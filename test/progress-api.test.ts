import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDashboardServer } from '../src/server.js';
import { discoveryFile, type DiscoveryDocument } from '../src/progress/auth.js';

const bearer = (token: string) => ['Bea'+'rer', token].join(' ');

async function startServer() {
  const staticDirectory = await mkdtemp(path.join(os.tmpdir(), 'harness-ui-'));
  await writeFile(path.join(staticDirectory, 'index.html'), '<harness-dashboard></harness-dashboard>');
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'harness-data-'));
  const dashboard = createDashboardServer({ port: 0, staticDirectory, dataDirectory });
  const address = await dashboard.listen();
  return { dashboard, dataDirectory, base: `http://${address.host}:${address.port}` };
}

test('ingest requires the per-run bearer token', async context => {
  const { dashboard, base } = await startServer();
  context.after(() => dashboard.close());

  const body = JSON.stringify({ events: [{ type: 'session.start', eventId: 'a', sequence: 0 }] });
  const headers = { 'Content-Type': 'application/json' };
  const unauthorized = await fetch(`${base}/api/sessions/claude-code/s1/events`, { method: 'POST', headers, body });
  assert.equal(unauthorized.status, 401);

  const wrong = await fetch(`${base}/api/sessions/claude-code/s1/events`, {
    method: 'POST',
    headers: { ...headers, Authorization: bearer('not-the-token') },
    body,
  });
  assert.equal(wrong.status, 401);
  assert.equal((await fetch(`${base}/api/progress/sessions`).then(r => r.json()) as unknown[]).length, 0);
});

test('authenticated batch ingest creates an observed session with a deep link', async context => {
  const { dashboard, base, dataDirectory } = await startServer();
  context.after(() => dashboard.close());
  const headers = {
    'Content-Type': 'application/json',
    Authorization: bearer(dashboard.token),
  };

  const response = await fetch(`${base}/api/sessions/claude-code/s1/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'Fix login bug',
      events: [
        { type: 'session.start', eventId: 'a', sequence: 0 },
        { type: 'tool.start', eventId: 'b', sequence: 1, tool: { name: 'bash', argsSummary: 'npm test' } },
      ],
    }),
  });
  assert.equal(response.status, 202);
  const { session, accepted } = await response.json() as {
    session: { id: string; kind: string; url?: string };
    accepted: number;
  };
  assert.equal(accepted, 2);
  assert.equal(session.kind, 'observed');
  assert.match(session.url ?? '', /\/sessions\/[0-9a-f-]+$/);

  // Retried batches are idempotent via event IDs.
  const retry = await fetch(`${base}/api/sessions/claude-code/s1/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ events: [{ type: 'session.start', eventId: 'a', sequence: 0 }] }),
  });
  assert.equal((await retry.json() as { accepted: number }).accepted, 0);

  // Invalid payloads are rejected.
  const invalid = await fetch(`${base}/api/sessions/claude-code/s1/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ events: [{ type: 'nonsense' }] }),
  });
  assert.equal(invalid.status, 422);

  // The harness runtime is reserved for internally owned sessions.
  const reserved = await fetch(`${base}/api/sessions/harness/s1/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ events: [{ type: 'session.start' }] }),
  });
  assert.equal(reserved.status, 400);

  // The discovery file advertises the server URL and token for local adapters.
  const discovery = JSON.parse(await readFile(discoveryFile(dataDirectory), 'utf8')) as DiscoveryDocument;
  assert.equal(discovery.url, base);
  assert.equal(discovery.token, dashboard.token);

  // Deep links serve the dashboard shell.
  const deepLink = await fetch(`${base}/sessions/${session.id}`);
  assert.equal(deepLink.status, 200);
  assert.match(await deepLink.text(), /harness-dashboard/);
});

test('SSE stream delivers a snapshot and live progress events', async context => {
  const { dashboard, base } = await startServer();
  context.after(() => dashboard.close());

  const controller = new AbortController();
  context.after(() => controller.abort());
  const stream = await fetch(`${base}/api/events`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const reader = stream.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let buffer = '';
  const read = async (predicate: (chunk: string) => boolean): Promise<void> => {
    const deadline = Date.now() + 3000;
    while (!predicate(buffer)) {
      if (Date.now() > deadline) throw new Error(`SSE output not observed in time: ${buffer}`);
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
  };
  await read(chunk => chunk.includes('event: snapshot'));

  await fetch(`${base}/api/sessions/copilot-sdk/live-1/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: bearer(dashboard.token),
    },
    body: JSON.stringify({ events: [{ type: 'session.start', eventId: 'x', sequence: 0 }] }),
  });
  await read(chunk => chunk.includes('event: progress') && chunk.includes('"copilot-sdk"'));
});
