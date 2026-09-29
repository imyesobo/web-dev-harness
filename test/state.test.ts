import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { completeStage, loadState, saveState } from '../src/state.js';

test('persists checkpoints without duplicating stages', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-state-'));
  const file = path.join(directory, 'state.json');
  const state = await loadState(file, 123);
  completeStage(state, 'ingest');
  completeStage(state, 'ingest');
  await saveState(file, state);

  assert.deepEqual((await loadState(file, 123)).completedStages, ['ingest']);
  await assert.rejects(loadState(file, 456), /belongs to work item 123/);
});
