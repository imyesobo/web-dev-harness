import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProgressReporter } from '../src/progress/client.js';
import { observe } from '../src/cli/observe.js';
import { createDashboardServer } from '../src/server.js';
import type { ProgressSession } from '../src/progress/schema.js';

async function startServer() {
  const staticDirectory = await mkdtemp(path.join(os.tmpdir(), 'harness-ui-'));
  await writeFile(path.join(staticDirectory, 'index.html'), '<harness-dashboard></harness-dashboard>');
  const dashboard = createDashboardServer({ port: 0, staticDirectory, dataDirectory: false });
  const address = await dashboard.listen();
  return { dashboard, base: `http://${address.host}:${address.port}` };
}

test('progress reporter batches events, retries after failure, and learns the deep link', async context => {
  const { dashboard, base } = await startServer();
  context.after(() => dashboard.close());
  let failNext = true;
  const reporter = new ProgressReporter({
    runtime: 'copilot-sdk',
    externalId: 'observe-1',
    title: 'Try the reporter',
    url: base,
    token: dashboard.token,
    fetchImplementation: (input, init) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('offline'));
      }
      return fetch(input, init);
    },
  });
  reporter.report({ type: 'session.start', status: 'running' });
  reporter.report({ type: 'tool.start', tool: { name: 'bash', argsSummary: 'npm test' } });
  await reporter.flush(); // Fails; the batch returns to the buffer.
  await reporter.flush(); // Succeeds; idempotent event IDs survive the retry.
  assert.match(reporter.sessionUrl ?? '', /\/sessions\/[0-9a-f-]+$/);

  const sessions = await fetch(`${base}/api/progress/sessions`).then(r => r.json()) as ProgressSession[];
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.title, 'Try the reporter');
  assert.equal(sessions[0]?.lastSequence, 1);
});

test('observe runs a Copilot session as an observed session reporting progress', async context => {
  const { dashboard, base } = await startServer();
  context.after(() => dashboard.close());
  const reporter = new ProgressReporter({
    runtime: 'copilot-sdk',
    externalId: 'observe-2',
    url: base,
    token: dashboard.token,
  });
  const answer = await observe({
    prompt: 'Summarize the workspace',
    workspace: os.tmpdir(),
    model: 'gpt-5',
    reporter,
    agentFactory: (_workspace, _model, onTranscript, onActivity) => ({
      start: async () => undefined,
      prompt: async () => {
        onActivity?.({ type: 'tool.start', tool: { name: 'view', argsSummary: '{"path":"README.md"}' } });
        onActivity?.({ type: 'tool.end' });
        onTranscript?.('assistant', 'All done.');
        return 'All done.';
      },
      stop: async () => undefined,
    }),
  });
  assert.equal(answer, 'All done.');
  const session = dashboard.bus.list().find(record => record.externalId === 'observe-2');
  assert.equal(session?.status, 'completed');
  const types = dashboard.bus.events(session?.id ?? '').map(event => event.type);
  assert.deepEqual(types, ['session.start', 'tool.start', 'tool.end', 'message', 'session.end']);
});
