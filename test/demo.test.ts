import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDemoServices, demoSessionInput, prepareDemoWorkspace } from '../src/demo.js';
import { createSessionConfig } from '../src/dashboard/config.js';
import { loadOpenApi } from '../src/openapi.js';
import { SessionManager } from '../src/dashboard/sessions.js';
import { createDashboardServer } from '../src/server.js';
import type { HarnessServices } from '../src/types.js';

test('demo workspace yields a valid session config and OpenAPI contract', async () => {
  const workspace = await prepareDemoWorkspace();
  assert.ok(workspace.startsWith(os.tmpdir()));
  const config = createSessionConfig(demoSessionInput(workspace), 'demo-session');
  assert.equal(config.workspace, workspace);
  assert.equal(config.skipPublish, false);
  assert.equal(config.pipelineId, 42);
  const openApi = await loadOpenApi(config.openApiPath) as { openapi: string; paths: object };
  assert.match(openApi.openapi, /^3\./);
  assert.ok('/feedback' in openApi.paths);
  assert.equal(config.executors['requirements-analysis'], 'github-agent');
  const hybrid = createSessionConfig(demoSessionInput(workspace, true), 'demo-hybrid');
  assert.equal(hybrid.executors['requirements-analysis'], 'human-m365');
  assert.equal(hybrid.executors['impact-analysis'], 'human-m365');
  assert.equal(hybrid.executors.implementation, 'github-agent');
});

test('demo services mock every external integration', async () => {
  const services = createDemoServices();
  const workItem = await services.azure?.getWorkItem(1234) as { id: number; fields: object };
  assert.equal(workItem.id, 1234);
  const pullRequest = await services.azure?.ensurePullRequest('repo', 'src', 'main', 1234) as {
    pullRequestId: number;
  };
  assert.equal(pullRequest.pullRequestId, 99);
  assert.equal(await services.azure?.publishTestResults(1234, []), 4321);
  const design = await services.figma?.getDesign('DEMO-FILE-KEY') as { document: { name: string } };
  assert.equal(design.document.name, 'feedback-form');
  const result = await services.verificationRunner?.('npm', ['run', 'lint'], '/tmp');
  assert.equal(result?.exitCode, 0);
});

test('POST /api/demo starts a session with injected demo services', async context => {
  let received: HarnessServices | undefined;
  const manager = new SessionManager(async (config, options) => {
    received = options?.services;
    assert.equal(path.basename(config.openApiPath), 'openapi.yaml');
  });
  const dashboard = createDashboardServer({ port: 0, manager });
  const { host, port } = await dashboard.listen();
  context.after(() => dashboard.server.close());

  const response = await fetch(`http://${host}:${port}/api/demo`, { method: 'POST' });
  assert.equal(response.status, 202);
  const record = await response.json() as {
    status: string;
    config: { figmaTokenConfigured: boolean; adoRepository: string };
  };
  assert.equal(record.config.adoRepository, 'demo-feedback-form');
  assert.equal(record.config.figmaTokenConfigured, true);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(received?.azure, 'demo azure mock should reach the runner');
  assert.ok(received?.figma, 'demo figma mock should reach the runner');
  assert.ok(received?.verificationRunner, 'demo verification runner should reach the runner');
});
