/**
 * Web Dev Harness progress mod for Claude Code.
 *
 * Deliberately thin: it only maps Claude Code lifecycle events onto the
 * harness "Agent Session Progress" schema (v1) and ships them to the local
 * dashboard. All ordering/idempotency guarantees come from the schema
 * (eventId + sequence); the backend deduplicates replayed batches, so the
 * retry/offline buffer here can be simple.
 *
 * Pinned to the Claude Code mods API v1 — the mods API is new and evolving,
 * so keep logic out of this file and in the harness backend wherever possible.
 *
 * The mod discovers the running dashboard through the discovery file the
 * server writes on startup: `~/.web-dev-harness/harness.json`
 * (override the directory with HARNESS_DATA_DIR), containing `{ url, token }`.
 * The token is minted per server run — nothing long-lived is stored here.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 1;
const RUNTIME = 'claude-code';
const FLUSH_INTERVAL_MS = 250;
const MAX_BUFFERED_EVENTS = 500;

interface BufferedEvent {
  schemaVersion: number;
  eventId: string;
  sequence: number;
  at: string;
  type: string;
  status?: string;
  tool?: { name: string; argsSummary?: string };
  message?: string;
}

interface Discovery {
  url: string;
  token: string;
}

const state = {
  sessionId: undefined as string | undefined,
  sequence: 0,
  buffer: [] as BufferedEvent[],
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  discovery: undefined as Discovery | undefined,
  sessionUrl: undefined as string | undefined,
};

function push(event: Omit<BufferedEvent, 'schemaVersion' | 'eventId' | 'sequence' | 'at'>): void {
  state.buffer.push({
    ...event,
    schemaVersion: SCHEMA_VERSION,
    eventId: randomUUID(),
    sequence: state.sequence++,
    at: new Date().toISOString(),
  });
  while (state.buffer.length > MAX_BUFFERED_EVENTS) state.buffer.shift();
  if (!state.timer) {
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void flush();
    }, FLUSH_INTERVAL_MS);
  }
}

async function discover(): Promise<Discovery | undefined> {
  if (state.discovery) return state.discovery;
  const directory = process.env.HARNESS_DATA_DIR ?? join(homedir(), '.web-dev-harness');
  try {
    state.discovery = JSON.parse(await readFile(join(directory, 'harness.json'), 'utf8')) as Discovery;
    return state.discovery;
  } catch {
    return undefined; // No dashboard running; keep buffering (offline buffer).
  }
}

async function flush(): Promise<void> {
  if (!state.buffer.length || !state.sessionId) return;
  const discovery = await discover();
  if (!discovery) return;
  const batch = state.buffer.splice(0, state.buffer.length);
  try {
    const response = await fetch(
      `${discovery.url}/api/sessions/${RUNTIME}/${encodeURIComponent(state.sessionId)}/events`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: ['Bea', 'rer ', discovery.token].join(''),
        },
        body: JSON.stringify({ events: batch }),
      },
    );
    if (!response.ok) throw new Error(`Ingest failed: ${response.status}`);
    const body = await response.json() as { session?: { url?: string } };
    if (body.session?.url) state.sessionUrl = body.session.url;
  } catch {
    // Put the batch back; eventIds make the eventual retry idempotent.
    state.buffer.unshift(...batch);
    state.discovery = undefined; // The server may have restarted with a new token.
  }
}

function summarize(args: unknown): string | undefined {
  if (args === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(args) ?? '';
  } catch {
    return undefined;
  }
  return serialized.length > 400 ? `${serialized.slice(0, 400)}…` : serialized;
}

// Mods API v1 entry point. `on` registers middleware-style event handlers; the
// `$` namespace object passed to each handler exposes ui/command helpers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function register(on: any): void {
  on('session.start', async ($: any, event: any, next: any) => {
    state.sessionId = String(event?.sessionId ?? event?.session?.id ?? randomUUID());
    push({ type: 'session.start', status: 'running' });
    try {
      await $?.command?.register?.({
        name: 'harness',
        description: 'Open this session in the web-dev-harness dashboard',
      });
      $?.ui?.status?.('harness: reporting progress');
    } catch {
      // UI/commands are optional niceties; never block session start.
    }
    return next(event);
  });

  on('tool.call', async ($: any, event: any, next: any) => {
    const name = String(event?.tool ?? event?.toolName ?? 'tool');
    push({
      type: 'tool.start',
      tool: { name, ...(summarize(event?.arguments) !== undefined ? { argsSummary: summarize(event?.arguments) } : {}) },
    });
    try {
      $?.ui?.status?.(`harness: ${name}${state.sessionUrl ? ` · ${state.sessionUrl}` : ''}`);
    } catch {
      // Status updates are best-effort.
    }
    const result = await next(event);
    push({ type: 'tool.end' });
    return result;
  });

  on('command.run', { command: 'harness' }, async () => {
    await flush();
    return {
      text: state.sessionUrl
        ? `Open this session in the harness: ${state.sessionUrl}`
        : 'The web-dev-harness dashboard is not reachable. Start it with `npm run dashboard` and try again.',
    };
  });

  on('session.end', async (_$: any, event: any, next: any) => {
    push({ type: 'session.end', status: 'completed' });
    await flush();
    return next(event);
  });
}
