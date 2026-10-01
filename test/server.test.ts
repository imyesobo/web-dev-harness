import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDashboardServer } from '../src/server.js';

test('dashboard server serves the UI and validates session configuration', async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-ui-'));
  await writeFile(path.join(directory, 'index.html'), '<harness-dashboard></harness-dashboard>');
  const dashboard = createDashboardServer({ port: 0, staticDirectory: directory });
  const { host, port } = await dashboard.listen();
  context.after(() => dashboard.server.close());

  const page = await fetch(`http://${host}:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /harness-dashboard/);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);

  const invalid = await fetch(`http://${host}:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /workspace is required/);
});
