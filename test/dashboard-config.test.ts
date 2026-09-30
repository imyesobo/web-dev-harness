import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionConfig } from '../src/dashboard/config.js';

const validInput = {
  workspace: '/workspace',
  workItemId: 42,
  adoOrganization: 'example',
  adoProject: 'components',
  adoRepository: 'web',
  pipelineId: 7,
  figmaFileKey: 'design',
  figmaToken: 'secret',
  openApiPath: 'contracts/api.yml',
};

test('dashboard config assigns isolated state and safe defaults', () => {
  const config = createSessionConfig(validInput, 'session-id');
  assert.equal(config.stateFile, '/workspace/.harness/sessions/session-id/state.json');
  assert.equal(config.openApiPath, '/workspace/contracts/api.yml');
  assert.equal(config.copilotModel, 'gpt-5');
  assert.equal(config.targetBranch, 'main');
});

test('dashboard config blocks paths outside the workspace', () => {
  assert.throws(
    () => createSessionConfig({ ...validInput, openApiPath: '../private.yml' }, 'session-id'),
    /inside the workspace/,
  );
  assert.throws(
    () => createSessionConfig({ ...validInput, resultFiles: ['/tmp/results.json'] }, 'session-id'),
    /inside the workspace/,
  );
});

test('dashboard config requires a pipeline unless publish is skipped', () => {
  const { pipelineId: _pipeline, ...withoutPipeline } = validInput;
  assert.throws(() => createSessionConfig(withoutPipeline, 'session-id'), /pipelineId/);
  assert.equal(
    createSessionConfig({ ...withoutPipeline, skipPublish: true }, 'session-id').skipPublish,
    true,
  );
});
