import { randomUUID } from 'node:crypto';
import { loadState } from '../state.js';
import type { HarnessConfig, HarnessRunOptions } from '../types.js';
import { runHarness } from '../harness.js';
import { createSessionConfig } from './config.js';
import type { SessionConfigInput, SessionRecord, SessionStatus } from './types.js';

type HarnessRunner = (config: HarnessConfig, options?: HarnessRunOptions) => Promise<void>;

interface InternalSession extends SessionRecord {
  secretConfig: HarnessConfig;
  controller: AbortController;
}

export class SessionManager {
  readonly #sessions = new Map<string, InternalSession>();

  constructor(readonly runner: HarnessRunner = runHarness) {}

  list(): SessionRecord[] {
    return [...this.#sessions.values()]
      .map(session => publicRecord(session))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  get(id: string): SessionRecord | undefined {
    const session = this.#sessions.get(id);
    return session ? publicRecord(session) : undefined;
  }

  start(input: SessionConfigInput): SessionRecord {
    const id = randomUUID();
    const secretConfig = createSessionConfig(input, id);
    const controller = new AbortController();
    const session: InternalSession = {
      id,
      status: 'queued',
      startedAt: new Date().toISOString(),
      config: redactConfig(secretConfig),
      secretConfig,
      controller,
    };
    this.#sessions.set(id, session);
    void this.#run(session);
    return publicRecord(session);
  }

  cancel(id: string): SessionRecord | undefined {
    const session = this.#sessions.get(id);
    if (!session || terminal(session.status)) return session && publicRecord(session);
    session.controller.abort();
    session.status = 'cancelled';
    session.endedAt = new Date().toISOString();
    return publicRecord(session);
  }

  async #run(session: InternalSession): Promise<void> {
    session.status = 'running';
    try {
      await this.runner(session.secretConfig, {
        signal: session.controller.signal,
        onEvent: async event => {
          session.currentStage = event.stage;
          if (event.attempt !== undefined) session.attempt = event.attempt;
          if (event.status === 'completed') {
            session.state = await loadState(
              session.secretConfig.stateFile,
              session.secretConfig.workItemId,
            );
          }
        },
      });
      if (!session.controller.signal.aborted) session.status = 'completed';
    } catch (error) {
      if (session.controller.signal.aborted) {
        session.status = 'cancelled';
      } else {
        session.status = 'failed';
        session.error = sanitizeError(error, session.secretConfig);
      }
    } finally {
      session.endedAt ??= new Date().toISOString();
      try {
        session.state = await loadState(session.secretConfig.stateFile, session.secretConfig.workItemId);
      } catch {
        // A failure before the first checkpoint has no persisted state.
      }
    }
  }
}

function redactConfig(config: HarnessConfig): SessionRecord['config'] {
  const { figmaToken: _secret, ...safe } = config;
  return { ...safe, figmaTokenConfigured: true };
}

function publicRecord(session: InternalSession): SessionRecord {
  return JSON.parse(JSON.stringify({
    id: session.id,
    status: session.status,
    currentStage: session.currentStage,
    attempt: session.attempt,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    error: session.error,
    config: session.config,
    state: session.state,
  })) as SessionRecord;
}

function terminal(status: SessionStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function sanitizeError(error: unknown, config: HarnessConfig): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(config.figmaToken, '[REDACTED]');
}
