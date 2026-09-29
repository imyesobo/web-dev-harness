import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AzureClient, parseTestResults } from '../src/cli/azure.js';
import type { CommandResult } from '../src/types.js';

test('uses the valid Azure Boards work-item command', async () => {
  let invocation: string[] = [];
  const client = new AzureClient({
    organization: 'example',
    project: 'project',
    workspace: '/workspace',
    runner: async (executable, args): Promise<CommandResult> => {
      invocation = [executable, ...args];
      return { command: executable, exitCode: 0, stdout: '{}', stderr: '' };
    },
  });

  await client.getWorkItem(42);
  assert.deepEqual(invocation.slice(0, 5), ['az', 'boards', 'work-item', 'show', '--id']);
  assert.equal(invocation[5], '42');
});

test('parses JUnit results for Azure Test Plans', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-test-'));
  const file = path.join(directory, 'junit.xml');
  await writeFile(file, `
    <testsuite>
      <testcase name="renders default" time="0.25"/>
      <testcase name="shows error"><failure>Expected error state</failure></testcase>
      <testcase name="disabled"><skipped/></testcase>
    </testsuite>
  `);

  assert.deepEqual(await parseTestResults(file), [
    { name: 'renders default', outcome: 'Passed', durationMs: 250 },
    { name: 'shows error', outcome: 'Failed', errorMessage: 'Expected error state' },
    { name: 'disabled', outcome: 'NotExecuted' },
  ]);
});

test('parses normalized JSON results', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-test-'));
  const file = path.join(directory, 'results.json');
  await writeFile(file, JSON.stringify([
    { title: 'journey', status: 'passed', durationMs: 42 },
    { name: 'pending contract', outcome: 'skipped' },
  ]));

  assert.deepEqual(await parseTestResults(file), [
    { name: 'journey', outcome: 'Passed', durationMs: 42 },
    { name: 'pending contract', outcome: 'NotExecuted' },
  ]);
});

test('parses Playwright JSON results', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-test-'));
  const file = path.join(directory, 'playwright.json');
  await writeFile(file, JSON.stringify({
    suites: [{
      title: 'checkout',
      specs: [{
        title: 'submits form',
        tests: [{ results: [{ status: 'failed', duration: 12, errors: [{ message: 'boom' }] }] }],
      }],
    }],
  }));

  assert.deepEqual(await parseTestResults(file), [{
    name: 'checkout › submits form',
    outcome: 'Failed',
    durationMs: 12,
    errorMessage: 'boom',
  }]);
});
