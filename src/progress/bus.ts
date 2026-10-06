import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PROGRESS_SCHEMA_VERSION,
  type AgentRuntime,
  type ProgressEvent,
  type ProgressEventInput,
  type ProgressSession,
  type SessionKind,
} from './schema.js';

export type ProgressListener = (session: ProgressSession, event: ProgressEvent) => void;

export interface ProgressBusOptions {
  /** Directory for persisted session records and event logs. Omit for in-memory only. */
  dataDirectory?: string;
  /** Redacts secrets from persisted/broadcast event text (applied to message and argsSummary). */
  redact?: (text: string) => string;
  /** Deep-link base, e.g. http://127.0.0.1:4173; set once the server port is known. */
  baseUrl?: string;
}

interface InternalSession {
  record: ProgressSession;
  seenEventIds: Set<string>;
  events: ProgressEvent[];
}

const MAX_EVENTS_IN_MEMORY = 2000;
const MAX_ERRORS = 20;

/**
 * Single event bus and source of truth for session progress. Both
 * harness-owned workflow sessions and observed external sessions publish
 * through it; the dashboard subscribes through it. Events are deduplicated by
 * eventId, ordered by sequence number, and appended to a JSONL log per
 * session so history survives server restarts.
 */
export class ProgressBus {
  readonly #sessions = new Map<string, InternalSession>();
  readonly #byNaturalKey = new Map<string, string>();
  readonly #listeners = new Set<ProgressListener>();
  readonly #options: ProgressBusOptions;
  #persistTail: Promise<void> = Promise.resolve();

  constructor(options: ProgressBusOptions = {}) {
    this.#options = options;
  }

  set baseUrl(url: string) {
    this.#options.baseUrl = url;
    for (const session of this.#sessions.values()) {
      session.record.url = `${url}/sessions/${session.record.id}`;
    }
  }

  /** Loads persisted session records from the data directory. */
  async restore(): Promise<void> {
    const directory = this.#options.dataDirectory;
    if (!directory) return;
    let entries: string[];
    try {
      entries = await readdir(path.join(directory, 'sessions'));
    } catch {
      return;
    }
    for (const id of entries) {
      try {
        const record = JSON.parse(
          await readFile(path.join(directory, 'sessions', id, 'record.json'), 'utf8'),
        ) as ProgressSession;
        // A session left "running" by a previous process cannot still be running.
        if (record.status === 'running' || record.status === 'waiting') record.status = 'failed';
        if (this.#options.baseUrl) record.url = `${this.#options.baseUrl}/sessions/${record.id}`;
        const session: InternalSession = { record, seenEventIds: new Set(), events: [] };
        this.#sessions.set(record.id, session);
        if (record.externalId) {
          this.#byNaturalKey.set(naturalKey(record.runtime, record.externalId), record.id);
        }
      } catch {
        // Skip unreadable records; the log file remains on disk for inspection.
      }
    }
  }

  list(): ProgressSession[] {
    return [...this.#sessions.values()]
      .map(session => ({ ...session.record }))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  get(id: string): ProgressSession | undefined {
    const session = this.#sessions.get(id);
    return session ? { ...session.record } : undefined;
  }

  events(id: string): ProgressEvent[] {
    return [...(this.#sessions.get(id)?.events ?? [])];
  }

  subscribe(listener: ProgressListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Registers (or reconciles) a session and returns its record. */
  register(options: {
    kind: SessionKind;
    runtime: AgentRuntime;
    externalId?: string;
    id?: string;
    title?: string;
  }): ProgressSession {
    const key = options.externalId ? naturalKey(options.runtime, options.externalId) : undefined;
    const existingId = key ? this.#byNaturalKey.get(key) : options.id;
    const existing = existingId ? this.#sessions.get(existingId) : undefined;
    if (existing) {
      existing.record.status = 'running';
      existing.record.updatedAt = new Date().toISOString();
      if (options.title) existing.record.title = options.title;
      this.#persist(existing);
      return { ...existing.record };
    }
    const id = options.id ?? randomUUID();
    const now = new Date().toISOString();
    const record: ProgressSession = {
      id,
      kind: options.kind,
      runtime: options.runtime,
      ...(options.externalId ? { externalId: options.externalId } : {}),
      ...(options.title ? { title: options.title } : {}),
      status: 'running',
      startedAt: now,
      updatedAt: now,
      lastSequence: -1,
      errors: [],
      ...(this.#options.baseUrl ? { url: `${this.#options.baseUrl}/sessions/${id}` } : {}),
    };
    const session: InternalSession = { record, seenEventIds: new Set(), events: [] };
    this.#sessions.set(id, session);
    if (key) this.#byNaturalKey.set(key, id);
    this.#persist(session);
    return { ...record };
  }

  /** Publishes one event for a session; fills identity fields, dedupes, persists, notifies. */
  publish(sessionId: string, input: ProgressEventInput): ProgressEvent | undefined {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Unknown progress session: ${sessionId}`);
    const redact = this.#options.redact ?? ((text: string) => text);
    const event: ProgressEvent = {
      schemaVersion: input.schemaVersion ?? PROGRESS_SCHEMA_VERSION,
      eventId: input.eventId ?? randomUUID(),
      sequence: input.sequence ?? session.record.lastSequence + 1,
      at: input.at ?? new Date().toISOString(),
      type: input.type,
      ...(input.status ? { status: input.status } : {}),
      ...(input.step ? { step: input.step } : {}),
      ...(input.tool
        ? {
            tool: {
              name: input.tool.name,
              ...(input.tool.argsSummary !== undefined
                ? { argsSummary: redact(input.tool.argsSummary) }
                : {}),
            },
          }
        : {}),
      ...(input.message !== undefined ? { message: redact(input.message) } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    if (session.seenEventIds.has(event.eventId)) return undefined;
    if (event.sequence <= session.record.lastSequence && input.sequence !== undefined) {
      // Stale replay of an already-applied position; drop it (idempotent ingest).
      return undefined;
    }
    session.seenEventIds.add(event.eventId);
    session.events.push(event);
    if (session.events.length > MAX_EVENTS_IN_MEMORY) session.events.shift();
    this.#apply(session.record, event);
    this.#persist(session, event);
    for (const listener of this.#listeners) {
      try {
        listener({ ...session.record }, event);
      } catch {
        // A faulty subscriber must not break publishing.
      }
    }
    return event;
  }

  /** Ingests a batch for an external runtime session, registering it on first contact. */
  ingest(
    runtime: AgentRuntime,
    externalId: string,
    inputs: ProgressEventInput[],
    title?: string,
  ): { session: ProgressSession; accepted: number } {
    const registered = this.register({
      kind: 'observed',
      runtime,
      externalId,
      ...(title ? { title } : {}),
    });
    let accepted = 0;
    for (const input of [...inputs].sort(bySequence)) {
      if (this.publish(registered.id, input)) accepted += 1;
    }
    const session = this.get(registered.id);
    if (!session) throw new Error('Session disappeared during ingest');
    return { session, accepted };
  }

  /** Resolves after all pending persistence writes have settled. */
  async flush(): Promise<void> {
    await this.#persistTail;
  }

  #apply(record: ProgressSession, event: ProgressEvent): void {
    record.lastSequence = Math.max(record.lastSequence, event.sequence);
    record.updatedAt = event.at;
    if (event.status) record.status = event.status;
    if (event.type === 'session.end' && !event.status) record.status = 'completed';
    if (event.type === 'step.start' && event.step) record.currentStep = event.step;
    if (event.type === 'step.complete') delete record.currentTool;
    if (event.type === 'tool.start' && event.tool) record.currentTool = event.tool;
    if (event.type === 'tool.end') delete record.currentTool;
    if (event.type === 'error' && event.message) {
      record.errors.push(event.message);
      if (record.errors.length > MAX_ERRORS) record.errors.shift();
    }
  }

  #persist(session: InternalSession, event?: ProgressEvent): void {
    const directory = this.#options.dataDirectory;
    if (!directory) return;
    const sessionDirectory = path.join(directory, 'sessions', session.record.id);
    const record = JSON.stringify(session.record);
    const line = event ? `${JSON.stringify(event)}\n` : undefined;
    this.#persistTail = this.#persistTail.then(async () => {
      try {
        await mkdir(sessionDirectory, { recursive: true });
        await writeFile(path.join(sessionDirectory, 'record.json'), `${record}\n`);
        if (line) await appendFile(path.join(sessionDirectory, 'events.jsonl'), line);
      } catch {
        // Persistence is best-effort; live subscribers already received the event.
      }
    });
  }
}

function naturalKey(runtime: AgentRuntime, externalId: string): string {
  return `${runtime}:${externalId}`;
}

function bySequence(left: ProgressEventInput, right: ProgressEventInput): number {
  return (left.sequence ?? 0) - (right.sequence ?? 0);
}
