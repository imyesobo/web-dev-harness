import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProgressBus } from '../src/progress/bus.js';

test('bus assigns sequence numbers, dedupes event IDs, and tracks session summary', () => {
  const bus = new ProgressBus();
  const session = bus.register({ kind: 'observed', runtime: 'claude-code', externalId: 'abc' });
  const first = bus.publish(session.id, { type: 'session.start', eventId: 'e1' });
  assert.equal(first?.sequence, 0);
  assert.equal(bus.publish(session.id, { type: 'session.start', eventId: 'e1' }), undefined);
  bus.publish(session.id, { type: 'tool.start', tool: { name: 'bash', argsSummary: 'ls' } });
  assert.equal(bus.get(session.id)?.currentTool?.name, 'bash');
  bus.publish(session.id, { type: 'tool.end' });
  assert.equal(bus.get(session.id)?.currentTool, undefined);
  bus.publish(session.id, { type: 'error', message: 'boom' });
  bus.publish(session.id, { type: 'session.end', status: 'failed' });
  const record = bus.get(session.id);
  assert.equal(record?.status, 'failed');
  assert.deepEqual(record?.errors, ['boom']);
  assert.equal(record?.lastSequence, 4);
});

test('ingest reconciles resumed external sessions and orders batches by sequence', () => {
  const bus = new ProgressBus();
  const first = bus.ingest('copilot-cli', 'session-1', [
    { type: 'step.start', sequence: 1, eventId: 'b', step: { id: 's', name: 'step' } },
    { type: 'session.start', sequence: 0, eventId: 'a' },
  ]);
  assert.equal(first.accepted, 2);
  const second = bus.ingest('copilot-cli', 'session-1', [
    { type: 'session.end', sequence: 2, eventId: 'c', status: 'completed' },
    { type: 'session.start', sequence: 0, eventId: 'a' },
  ]);
  assert.equal(second.session.id, first.session.id);
  assert.equal(second.accepted, 1);
  assert.equal(bus.list().length, 1);
  assert.equal(bus.get(first.session.id)?.status, 'completed');
});

test('bus redacts secrets from messages and tool arguments', () => {
  const bus = new ProgressBus({ redact: text => text.replaceAll('hunter2', '[REDACTED]') });
  const session = bus.register({ kind: 'observed', runtime: 'custom', externalId: 'x' });
  const event = bus.publish(session.id, {
    type: 'tool.start',
    message: 'token hunter2 leaked',
    tool: { name: 'curl', argsSummary: '-H hunter2' },
  });
  assert.equal(event?.message?.includes('hunter2'), false);
  assert.equal(event?.tool?.argsSummary?.includes('hunter2'), false);
});

test('bus persists sessions and marks interrupted runs failed on restore', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-bus-'));
  const bus = new ProgressBus({ dataDirectory: directory });
  const running = bus.register({ kind: 'observed', runtime: 'claude-code', externalId: 'live' });
  const finished = bus.register({ kind: 'observed', runtime: 'claude-code', externalId: 'done' });
  bus.publish(finished.id, { type: 'session.end', status: 'completed' });
  await bus.flush();

  const restored = new ProgressBus({ dataDirectory: directory, baseUrl: 'http://127.0.0.1:9999' });
  await restored.restore();
  assert.equal(restored.list().length, 2);
  assert.equal(restored.get(running.id)?.status, 'failed');
  assert.equal(restored.get(finished.id)?.status, 'completed');
  assert.equal(restored.get(finished.id)?.url, `http://127.0.0.1:9999/sessions/${finished.id}`);
  // A resumed external session reconciles to the restored record.
  const resumed = restored.register({ kind: 'observed', runtime: 'claude-code', externalId: 'live' });
  assert.equal(resumed.id, running.id);
  assert.equal(resumed.status, 'running');
});

test('subscribers receive published events and cannot break publishing', () => {
  const bus = new ProgressBus();
  const session = bus.register({ kind: 'harness-workflow', runtime: 'harness' });
  const seen: string[] = [];
  bus.subscribe(() => {
    throw new Error('faulty subscriber');
  });
  const unsubscribe = bus.subscribe((_record, event) => seen.push(event.type));
  bus.publish(session.id, { type: 'session.start' });
  unsubscribe();
  bus.publish(session.id, { type: 'session.end' });
  assert.deepEqual(seen, ['session.start']);
});
