import { randomUUID } from 'node:crypto';
import { loadState } from '../state.js';
import type {
  HarnessConfig,
  HarnessRunOptions,
  HarnessServices,
  HumanInputRequest,
  StageName,
  StepOutputs,
  TranscriptEntry,
} from '../types.js';
import { runHarness } from '../harness.js';
import { normalizeStepOutputs } from '../workflow.js';
import { createSessionConfig } from './config.js';
import type { SessionConfigInput, SessionRecord, SessionStatus } from './types.js';

type HarnessRunner = (config: HarnessConfig, options?: HarnessRunOptions) => Promise<unknown>;

/** Raised when outputs are submitted for a step the workflow is not waiting on. */
export class StepConflictError extends Error {}

interface PendingInput {
  request: HumanInputRequest;
  resolve: (outputs: StepOutputs) => void;
}

interface InternalSession extends SessionRecord {
  secretConfig: HarnessConfig;
  controller: AbortController;
  services?: HarnessServices;
  log: TranscriptEntry[];
  pending?: PendingInput;
}

export class SessionManager {
  readonly #sessions = new Map<string, InternalSession>();
  readonly #workspaceTails = new Map<string, Promise<void>>();

  constructor(readonly runner: HarnessRunner = runHarness) {}

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
    delete session.pending;
    if (session.status === 'queued') {
      session.status = 'cancelled';
      session.endedAt = new Date().toISOString();
    } else {
      session.status = 'cancelling';
    }
    return publicRecord(session);
  }

  /** Accepts structured human outputs and resumes the paused workflow. */
  submit(id: string, stepId: string, outputs: unknown): SessionRecord | undefined {
    const session = this.#sessions.get(id);
    if (!session) return undefined;
    const pending = session.pending;
    if (session.status !== 'waiting_for_human' || pending?.request.stepId !== stepId) {
      throw new StepConflictError(`Session is not waiting for input on step ${stepId}`);
    }
    const normalized = normalizeStepOutputs(stepId as StageName, outputs);
    delete session.pending;
    session.status = 'running';
    pending.resolve(normalized);
    return publicRecord(session);
  }

  async #run(session: InternalSession): Promise<void> {
    if (session.controller.signal.aborted) return;
    session.status = 'running';
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
        onEvent: async event => {
          session.currentStage = event.stage;
          if (event.attempt !== undefined) session.attempt = event.attempt;
          session.state = await loadState(
            session.secretConfig.stateFile,
            session.secretConfig.workItemId,
          );
        },
        awaitHumanInput: request => new Promise<StepOutputs>((resolve, reject) => {
          const signal = session.controller.signal;
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          const onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          session.pending = {
            request: {
              ...request,
              briefing: request.briefing.replaceAll(session.secretConfig.figmaToken, '[REDACTED]'),
            },
            resolve: outputs => {
              signal.removeEventListener('abort', onAbort);
              resolve(outputs);
            },
          };
          session.status = 'waiting_for_human';
        }),
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
    pendingInput: session.pending?.request,
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
