import assert from 'node:assert/strict';
import test from 'node:test';
import type { HarnessRunOptions } from '../src/types.js';
import { SessionManager, StepConflictError } from '../src/dashboard/sessions.js';
import { humanInputRequest } from '../src/workflow.js';
import { loadState } from '../src/state.js';

const input = {
  workspace: '/workspace',
  workItemId: 42,
  adoOrganization: 'example',
  adoProject: 'components',
  adoRepository: 'web',
  figmaFileKey: 'design',
  figmaToken: 'do-not-return',
  openApiPath: 'api.yml',
  skipPublish: true,
};

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('session manager exposes progress without returning secrets', async () => {
  let release: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => {
    release = resolve;
  });
  const manager = new SessionManager(async (_config, options?: HarnessRunOptions) => {
    await options?.onEvent?.({ stage: 'ingest', status: 'started' });
    await waiting;
  });

  const session = manager.start(input);
  await until(() => manager.get(session.id)?.status === 'running');
  const visible = manager.get(session.id);
  assert.equal(visible?.status, 'running');
  assert.equal(visible?.currentStage, 'ingest');
  assert.equal(JSON.stringify(visible).includes('do-not-return'), false);
  release?.();
});

test('session detail exposes a redacted transcript; the list does not', async () => {
  const manager = new SessionManager(async (_config, options?: HarnessRunOptions) => {
    options?.onTranscript?.({
      at: new Date().toISOString(),
      stage: 'specification',
      role: 'user',
      content: 'prompt with secret do-not-return inside',
    });
    options?.onTranscript?.({
      at: new Date().toISOString(),
      stage: 'specification',
      role: 'assistant',
      content: 'the specification',
    });
  });
  const session = manager.start(input);
  await until(() => manager.get(session.id)?.status === 'completed');
  const detail = manager.get(session.id);
  assert.equal(detail?.transcript?.length, 2);
  assert.equal(detail?.transcript?.[0]?.content.includes('do-not-return'), false);
  assert.match(detail?.transcript?.[0]?.content ?? '', /\[REDACTED\]/);
  assert.equal(detail?.transcript?.[1]?.role, 'assistant');
  assert.equal('transcript' in (manager.list()[0] ?? {}), false);
});

test('session manager cancels an active workflow', async () => {
  const manager = new SessionManager(async (_config, options?: HarnessRunOptions) => {
    await new Promise<void>(resolve => {
      options?.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    options?.signal?.throwIfAborted();
  });
  const session = manager.start(input);
  await until(() => manager.get(session.id)?.status === 'running');
  const cancelled = manager.cancel(session.id);
  await until(() => manager.get(session.id)?.status === 'cancelled');
  assert.equal(cancelled?.status, 'cancelling');
  assert.equal(manager.get(session.id)?.status, 'cancelled');
});

test('session manager serializes workflows sharing a workspace', async () => {
  const releases: Array<() => void> = [];
  let active = 0;
  let maximumActive = 0;
  const manager = new SessionManager(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise<void>(resolve => releases.push(resolve));
    active -= 1;
  });
  const first = manager.start(input);
  const second = manager.start({ ...input, workItemId: 43 });
  await until(() => manager.get(first.id)?.status === 'running');
  assert.equal(manager.get(second.id)?.status, 'queued');
  releases.shift()?.();
  await until(() => manager.get(second.id)?.status === 'running');
  assert.equal(maximumActive, 1);
  releases.shift()?.();
});

test('session waits for human input, validates it, and resumes', async () => {
  let received: unknown;
  const manager = new SessionManager(async (config, options?: HarnessRunOptions) => {
    const state = await loadState(config.stateFile, config.workItemId);
    received = await options?.awaitHumanInput?.(
      humanInputRequest('requirements-analysis', 'human-m365', state),
    );
  });
  const session = manager.start(input);
  await until(() => manager.get(session.id)?.status === 'waiting_for_human');
  assert.equal(manager.get(session.id)?.pendingInput?.stepId, 'requirements-analysis');
  assert.throws(() => manager.submit(session.id, 'impact-analysis', {}), StepConflictError);
  assert.throws(() => manager.submit(session.id, 'requirements-analysis', {}), /summary is required/);
  assert.equal(manager.get(session.id)?.status, 'waiting_for_human');

  const resumed = manager.submit(session.id, 'requirements-analysis', { summary: 'done' });
  assert.equal(resumed?.status, 'running');
  assert.equal(resumed?.pendingInput, undefined);
  await until(() => manager.get(session.id)?.status === 'completed');
  assert.deepEqual(received, { summary: 'done', assumptions: [], acceptanceCriteria: [] });
  assert.equal(manager.submit('00000000-0000-0000-0000-000000000000', 'x', {}), undefined);
});

test('session waiting for human input can be cancelled', async () => {
  const manager = new SessionManager(async (config, options?: HarnessRunOptions) => {
    const state = await loadState(config.stateFile, config.workItemId);
    await options?.awaitHumanInput?.(humanInputRequest('impact-analysis', 'human', state));
  });
  const session = manager.start(input);
  await until(() => manager.get(session.id)?.status === 'waiting_for_human');
  manager.cancel(session.id);
  await until(() => manager.get(session.id)?.status === 'cancelled');
  assert.equal(manager.get(session.id)?.pendingInput, undefined);
});
