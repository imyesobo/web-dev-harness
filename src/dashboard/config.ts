import path from 'node:path';
import type { HarnessConfig } from '../types.js';
import { resolveExecutors } from '../workflow.js';
import type { SessionConfigInput } from './types.js';

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function positive(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

export function createSessionConfig(
  value: unknown,
  sessionId: string,
): HarnessConfig {
  if (!value || typeof value !== 'object') throw new Error('Configuration must be an object');
  const input = value as Partial<SessionConfigInput>;
  const workspace = path.resolve(text(input.workspace, 'workspace'));
  const pipelineId = input.pipelineId === undefined
    ? undefined
    : positive(input.pipelineId, 'pipelineId');
  const skipPublish = input.skipPublish ?? false;
  if (!skipPublish && pipelineId === undefined) {
    throw new Error('pipelineId is required unless publishing is skipped');
  }
  const relativeState = path.join('.harness', 'sessions', sessionId, 'state.json');
  return {
    workspace,
    stateFile: path.join(workspace, relativeState),
    workItemId: positive(input.workItemId, 'workItemId'),
    adoOrganization: text(input.adoOrganization, 'adoOrganization'),
    adoProject: text(input.adoProject, 'adoProject'),
    adoRepository: text(input.adoRepository, 'adoRepository'),
    sourceBranch: input.sourceBranch?.trim() || 'feature/copilot-component',
    targetBranch: input.targetBranch?.trim() || 'main',
    ...(pipelineId === undefined ? {} : { pipelineId }),
    figmaFileKey: text(input.figmaFileKey, 'figmaFileKey'),
    ...(input.figmaNodeIds?.length
      ? { figmaNodeIds: input.figmaNodeIds.map(String).map(item => item.trim()).filter(Boolean) }
      : {}),
    figmaToken: text(input.figmaToken, 'figmaToken'),
    openApiPath: resolveWithin(workspace, text(input.openApiPath, 'openApiPath'), 'openApiPath'),
    copilotModel: input.copilotModel?.trim() || 'gpt-5',
    resultFiles: (input.resultFiles ?? [])
      .map(file => resolveWithin(workspace, file, 'resultFiles')),
    skipPublish,
    executors: resolveExecutors(input.executors ?? {}),
  };
}

function resolveWithin(workspace: string, value: string, name: string): string {
  const resolved = path.resolve(workspace, text(value, name));
  if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`)) {
    throw new Error(`${name} must resolve inside the workspace`);
  }
  return resolved;
}
