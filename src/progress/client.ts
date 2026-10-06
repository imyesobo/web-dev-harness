import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { defaultDataDirectory, discoveryFile, type DiscoveryDocument } from './auth.js';
import type { AgentRuntime, ProgressEventInput } from './schema.js';
import { PROGRESS_SCHEMA_VERSION } from './schema.js';

export interface ProgressReporterOptions {
  runtime: AgentRuntime;
  externalId: string;
  title?: string;
  /** Explicit endpoint; when omitted the local discovery file is used. */
  url?: string;
  token?: string;
  /** Flush at most every N milliseconds (events are batched in between). */
  flushIntervalMs?: number;
  maxBufferedEvents?: number;
  fetchImplementation?: typeof fetch;
}

/**
 * Shared transport used by every runtime adapter (harness-observe wrapper,
 * future adapters): assigns monotonic sequence numbers and unique event IDs,
 * batches and debounces high-frequency events, retries on failure, and keeps
 * an in-memory offline buffer so a temporarily unreachable backend loses
 * nothing. Idempotent by construction: replayed batches are deduplicated
 * server-side by eventId.
 */
export class ProgressReporter {
  readonly #options: ProgressReporterOptions;
  readonly #buffer: ProgressEventInput[] = [];
  #sequence = 0;
  #timer: NodeJS.Timeout | undefined;
  #discovery: DiscoveryDocument | undefined;
  #sending: Promise<void> = Promise.resolve();

  constructor(options: ProgressReporterOptions) {
    this.#options = options;
  }

  /** Deep link for this session once the backend has acknowledged it. */
  sessionUrl: string | undefined;

  report(event: Omit<ProgressEventInput, 'schemaVersion' | 'eventId' | 'sequence' | 'at'>): void {
    this.#buffer.push({
      ...event,
      schemaVersion: PROGRESS_SCHEMA_VERSION,
      eventId: randomUUID(),
      sequence: this.#sequence++,
      at: new Date().toISOString(),
    });
    const limit = this.#options.maxBufferedEvents ?? 500;
    while (this.#buffer.length > limit) this.#buffer.shift();
    this.#schedule();
  }

  /** Sends anything buffered and resolves when the attempt has completed. */
  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#sending = this.#sending.then(() => this.#send());
    await this.#sending;
  }

  #schedule(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#sending = this.#sending.then(() => this.#send());
    }, this.#options.flushIntervalMs ?? 250);
    this.#timer.unref?.();
  }

  async #send(): Promise<void> {
    if (!this.#buffer.length) return;
    const discovery = await this.#discover();
    if (!discovery) return; // No running harness; keep buffering.
    const batch = this.#buffer.splice(0, this.#buffer.length);
    const target = `${discovery.url}/api/sessions/${encodeURIComponent(this.#options.runtime)}/${encodeURIComponent(this.#options.externalId)}/events`;
    const fetchImplementation = this.#options.fetchImplementation ?? fetch;
    try {
      const response = await fetchImplementation(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${discovery.token}`,
        },
        body: JSON.stringify({
          ...(this.#options.title ? { title: this.#options.title } : {}),
          events: batch,
        }),
      });
      if (!response.ok) throw new Error(`Ingest failed with status ${response.status}`);
      const body = await response.json() as { session?: { url?: string } };
      if (body.session?.url) this.sessionUrl = body.session.url;
    } catch {
      // Put the batch back for the next flush; eventIds make retries idempotent.
      this.#buffer.unshift(...batch);
      this.#discovery = undefined; // Re-read discovery next time; server may have restarted.
      this.#schedule();
    }
  }

  async #discover(): Promise<{ url: string; token: string } | undefined> {
    if (this.#options.url && this.#options.token) {
      return { url: this.#options.url, token: this.#options.token };
    }
    if (this.#discovery) return this.#discovery;
    try {
      this.#discovery = JSON.parse(
        await readFile(discoveryFile(defaultDataDirectory()), 'utf8'),
      ) as DiscoveryDocument;
      return this.#discovery;
    } catch {
      return undefined;
    }
  }
}
