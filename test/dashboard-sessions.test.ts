import assert from 'node:assert/strict';
import test from 'node:test';
import type { HarnessRunOptions } from '../src/types.js';
import { SessionManager } from '../src/dashboard/sessions.js';

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
  await new Promise(resolve => setTimeout(resolve, 0));
  const visible = manager.get(session.id);
  assert.equal(visible?.status, 'running');
  assert.equal(visible?.currentStage, 'ingest');
  assert.equal(JSON.stringify(visible).includes('do-not-return'), false);
  release?.();
});

test('session manager cancels an active workflow', async () => {
  const manager = new SessionManager(async (_config, options?: HarnessRunOptions) => {
    await new Promise<void>(resolve => {
      options?.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    options?.signal?.throwIfAborted();
  });
  const session = manager.start(input);
  await new Promise(resolve => setTimeout(resolve, 0));
  const cancelled = manager.cancel(session.id);
  await new Promise(resolve => setTimeout(resolve, 0));
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
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(manager.get(first.id)?.status, 'running');
  assert.equal(manager.get(second.id)?.status, 'queued');
  releases.shift()?.();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(manager.get(second.id)?.status, 'running');
  assert.equal(maximumActive, 1);
  releases.shift()?.();
});
