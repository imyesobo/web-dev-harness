/**
 * Agent Session Progress schema, version 1.
 *
 * The schema is deliberately minimal and additive: new optional fields may be
 * added within a major version, and every event carries `schemaVersion` so
 * producers and consumers can degrade gracefully across version skew.
 *
 * Harness-owned workflow sessions map onto this schema as follows: each
 * `StageName` becomes a step (`step.id` = stage name), verification retries
 * carry `step.attempt`, and checkpoints are `step.complete` events.
 */

export const PROGRESS_SCHEMA_VERSION = 1;

/** Runtime that produced the events. */
export type AgentRuntime = 'harness' | 'claude-code' | 'copilot-cli' | 'copilot-sdk' | 'custom';

/**
 * Harness-workflow sessions are owned and driven by the deterministic
 * orchestrator; observed sessions belong to an external agent runtime that
 * merely reports progress. Stage/attempt/checkpoint semantics apply only to
 * the former.
 */
export type SessionKind = 'harness-workflow' | 'observed';

export type ProgressStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export type ProgressEventType =
  | 'session.start'
  | 'session.status'
  | 'step.start'
  | 'step.complete'
  | 'tool.start'
  | 'tool.end'
  | 'message'
  | 'error'
  | 'session.end';

export interface ProgressStep {
  id: string;
  name: string;
  attempt?: number;
}

export interface ProgressTool {
  name: string;
  argsSummary?: string;
}

export interface ProgressEvent {
  schemaVersion: number;
  /** Globally unique; the ingest path deduplicates on it (idempotent retries). */
  eventId: string;
  /** Monotonic per session; used to order and to drop stale duplicates. */
  sequence: number;
  at: string;
  type: ProgressEventType;
  status?: ProgressStatus;
  step?: ProgressStep;
  tool?: ProgressTool;
  message?: string;
  metadata?: Record<string, unknown>;
}

/** Event as submitted by a producer; the bus fills identity and defaults. */
export interface ProgressEventInput {
  schemaVersion?: number;
  eventId?: string;
  sequence?: number;
  at?: string;
  type: ProgressEventType;
  status?: ProgressStatus;
  step?: ProgressStep;
  tool?: ProgressTool;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface ProgressSession {
  /** Internal UUID; the natural key for external sessions is runtime + externalId. */
  id: string;
  kind: SessionKind;
  runtime: AgentRuntime;
  /** Runtime-native session ID, so resumed external sessions reconcile. */
  externalId?: string;
  title?: string;
  status: ProgressStatus;
  startedAt: string;
  updatedAt: string;
  currentStep?: ProgressStep;
  currentTool?: ProgressTool;
  lastSequence: number;
  errors: string[];
  /** Deep link to this session in the web harness. */
  url?: string;
}

const eventTypes = new Set<ProgressEventType>([
  'session.start', 'session.status', 'step.start', 'step.complete',
  'tool.start', 'tool.end', 'message', 'error', 'session.end',
]);

const statuses = new Set<ProgressStatus>(['running', 'waiting', 'completed', 'failed', 'cancelled']);

/** Validates an untrusted ingested payload; returns an error string or undefined. */
export function validateEventInput(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return 'Event must be an object';
  const event = value as Record<string, unknown>;
  if (!eventTypes.has(event.type as ProgressEventType)) return `Unknown event type: ${String(event.type)}`;
  if (event.status !== undefined && !statuses.has(event.status as ProgressStatus)) {
    return `Unknown status: ${String(event.status)}`;
  }
  if (event.sequence !== undefined && (!Number.isInteger(event.sequence) || (event.sequence as number) < 0)) {
    return 'sequence must be a non-negative integer';
  }
  if (event.eventId !== undefined && typeof event.eventId !== 'string') return 'eventId must be a string';
  if (event.schemaVersion !== undefined && event.schemaVersion !== PROGRESS_SCHEMA_VERSION) {
    return `Unsupported schemaVersion: ${String(event.schemaVersion)}`;
  }
  return undefined;
}
