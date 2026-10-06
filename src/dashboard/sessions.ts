import { randomUUID } from 'node:crypto';
import { loadState } from '../state.js';
import type { HarnessConfig, HarnessRunOptions, HarnessServices, TranscriptEntry } from '../types.js';
import { runHarness } from '../harness.js';
import type { ProgressBus } from '../progress/bus.js';
import type { ProgressEventInput } from '../progress/schema.js';
import { createSessionConfig } from './config.js';
import type { SessionConfigInput, SessionRecord, SessionStatus } from './types.js';

type HarnessRunner = (config: HarnessConfig, options?: HarnessRunOptions) => Promise<void>;

interface InternalSession extends SessionRecord {
  secretConfig: HarnessConfig;
  controller: AbortController;
  services?: HarnessServices;
  log: TranscriptEntry[];
}

export class SessionManager {
  readonly #sessions = new Map<string, InternalSession>();
  readonly #workspaceTails = new Map<string, Promise<void>>();
  readonly #bus: ProgressBus | undefined;

  constructor(readonly runner: HarnessRunner = runHarness, bus?: ProgressBus) {
    this.#bus = bus;
  }

  list(): SessionRecord[] {
    return [...this.#sessions.values()]
      .map(session => publicRecord(session))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  get(id: string): SessionRecord | undefined {
    const session = this.#sessions.get(id);
    return session ? publicRecord(session, true) : undefined;
  }

  start(input: SessionConfigInput, services?: HarnessServices): SessionRecord {
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
      log: [],
      ...(services ? { services } : {}),
    };
    this.#sessions.set(id, session);
    this.#bus?.register({
      kind: 'harness-workflow',
      runtime: 'harness',
      id,
      title: `Work item ${secretConfig.workItemId}`,
    });
    this.#publish(session, { type: 'session.start', status: 'waiting' });
    const previous = this.#workspaceTails.get(secretConfig.workspace) ?? Promise.resolve();
    const execution = previous.then(() => this.#run(session));
    this.#workspaceTails.set(secretConfig.workspace, execution);
    void execution.finally(() => {
      if (this.#workspaceTails.get(secretConfig.workspace) === execution) {
        this.#workspaceTails.delete(secretConfig.workspace);
      }
    });
    return publicRecord(session);
  }

  cancel(id: string): SessionRecord | undefined {
    const session = this.#sessions.get(id);
    if (!session || terminal(session.status)) return session && publicRecord(session);
    session.controller.abort();
    if (session.status === 'queued') {
      session.status = 'cancelled';
      session.endedAt = new Date().toISOString();
      this.#publish(session, { type: 'session.end', status: 'cancelled' });
    } else {
      session.status = 'cancelling';
    }
    return publicRecord(session);
  }

  async #run(session: InternalSession): Promise<void> {
    if (session.controller.signal.aborted) return;
    session.status = 'running';
    this.#publish(session, { type: 'session.status', status: 'running' });
    try {
      await this.runner(session.secretConfig, {
        signal: session.controller.signal,
        ...(session.services ? { services: session.services } : {}),
        onTranscript: entry => {
          session.log.push({
            ...entry,
            content: entry.content.replaceAll(session.secretConfig.figmaToken, '[REDACTED]'),
          });
        },
        onActivity: activity => {
          if (activity.type === 'tool.start' && activity.tool) {
            this.#publish(session, { type: 'tool.start', tool: activity.tool });
          } else if (activity.type === 'tool.end' || activity.type === 'turn.end') {
            this.#publish(session, { type: 'tool.end' });
          }
        },
        onEvent: async event => {
          session.currentStage = event.stage;
          if (event.attempt !== undefined) session.attempt = event.attempt;
          this.#publish(session, {
            type: event.status === 'started' ? 'step.start' : 'step.complete',
            step: {
              id: event.stage,
              name: event.stage,
              ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
            },
          });
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
      const outcome = session.status === 'completed'
        ? 'completed'
        : session.status === 'cancelled' ? 'cancelled' : 'failed';
      this.#publish(session, {
        type: 'session.end',
        status: outcome,
        ...(session.error ? { message: session.error } : {}),
      });
      try {
        session.state = await loadState(session.secretConfig.stateFile, session.secretConfig.workItemId);
      } catch {
        // A failure before the first checkpoint has no persisted state.
      }
    }
  }

  #publish(session: InternalSession, event: ProgressEventInput): void {
    if (!this.#bus) return;
    try {
      const secret = session.secretConfig.figmaToken;
      this.#bus.publish(session.id, {
        ...event,
        ...(event.message !== undefined ? { message: event.message.replaceAll(secret, '[REDACTED]') } : {}),
        ...(event.tool
          ? {
              tool: {
                name: event.tool.name,
                ...(event.tool.argsSummary !== undefined
                  ? { argsSummary: event.tool.argsSummary.replaceAll(secret, '[REDACTED]') }
                  : {}),
              },
            }
          : {}),
      });
    } catch {
      // Progress publication must never break a workflow run.
    }
  }
}

function redactConfig(config: HarnessConfig): SessionRecord['config'] {
  const { figmaToken: _secret, ...safe } = config;
  return { ...safe, figmaTokenConfigured: true };
}

function publicRecord(session: InternalSession, includeTranscript = false): SessionRecord {
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
    ...(includeTranscript ? { transcript: session.log } : {}),
  })) as SessionRecord;
}

function terminal(status: SessionStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function sanitizeError(error: unknown, config: HarnessConfig): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(config.figmaToken, '[REDACTED]');
}
