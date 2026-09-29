import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HarnessState, StageName } from './types.js';

export async function loadState(file: string, workItemId: number): Promise<HarnessState> {
  try {
    const state = JSON.parse(await readFile(file, 'utf8')) as HarnessState;
    if (state.workItemId !== workItemId) {
      throw new Error(`State belongs to work item ${state.workItemId}, not ${workItemId}`);
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { workItemId, completedStages: [], attempts: 0, updatedAt: new Date().toISOString() };
  }
}

export async function saveState(file: string, state: HarnessState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  await rename(temporary, file);
}

export function completeStage(state: HarnessState, stage: StageName): void {
  if (!state.completedStages.includes(stage)) state.completedStages.push(stage);
}
