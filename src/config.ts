import path from 'node:path';
import type { HarnessConfig } from './types.js';
import { resolveExecutors } from './workflow.js';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  args: readonly string[] = process.argv.slice(2),
): HarnessConfig {
  const workspace = path.resolve(env.HARNESS_WORKSPACE ?? process.cwd());
  const pipeline = env.ADO_PIPELINE_ID?.trim();
  const skipPublish = args.includes('--skip-publish');
  if (!skipPublish && !pipeline) {
    throw new Error('ADO_PIPELINE_ID is required unless --skip-publish is used');
  }
  const nodeIds = env.FIGMA_NODE_IDS?.split(',').map(value => value.trim()).filter(Boolean);

  return {
    workspace,
    stateFile: path.resolve(workspace, env.HARNESS_STATE_FILE ?? '.harness/state.json'),
    workItemId: positiveInteger(required(env, 'ADO_WORK_ITEM_ID'), 'ADO_WORK_ITEM_ID'),
    adoOrganization: required(env, 'ADO_ORGANIZATION'),
    adoProject: required(env, 'ADO_PROJECT'),
    adoRepository: required(env, 'ADO_REPOSITORY'),
    sourceBranch: env.ADO_SOURCE_BRANCH ?? 'feature/copilot-component',
    targetBranch: env.ADO_TARGET_BRANCH ?? 'main',
    ...(pipeline ? { pipelineId: positiveInteger(pipeline, 'ADO_PIPELINE_ID') } : {}),
    figmaFileKey: required(env, 'FIGMA_FILE_KEY'),
    ...(nodeIds?.length ? { figmaNodeIds: nodeIds } : {}),
    figmaToken: required(env, 'FIGMA_TOKEN'),
    openApiPath: path.resolve(workspace, required(env, 'OPENAPI_PATH')),
    copilotModel: env.COPILOT_MODEL ?? 'gpt-5',
    resultFiles: (env.TEST_RESULT_FILES ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
      .map(value => path.resolve(workspace, value)),
    skipPublish,
    executors: resolveExecutors(Object.fromEntries(
      (env.HARNESS_STEP_EXECUTORS ?? '')
        .split(',')
        .map(pair => pair.split('=').map(value => value.trim()))
        .filter(([stepId]) => stepId),
    )),
  };
}
