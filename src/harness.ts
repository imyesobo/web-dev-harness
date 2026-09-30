#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { AzureClient } from './cli/azure.js';
import { FigmaClient } from './cli/figma.js';
import { loadConfig } from './config.js';
import { CopilotAgent } from './copilot.js';
import { loadOpenApi } from './openapi.js';
import {
  developerPrompt,
  playwrightPrompt,
  specifierPrompt,
  storybookPrompt,
} from './prompts/index.js';
import { completeStage, loadState, saveState } from './state.js';
import type {
  HarnessConfig,
  HarnessRunOptions,
  HarnessState,
  IngestedContext,
  StageName,
} from './types.js';
import { verify } from './verification.js';

export async function runHarness(
  config: HarnessConfig,
  options: HarnessRunOptions = {},
): Promise<void> {
  const state = await loadState(config.stateFile, config.workItemId);
  const azure = new AzureClient({
    organization: config.adoOrganization,
    project: config.adoProject,
    workspace: config.workspace,
    ...((process.env.SYSTEM_ACCESSTOKEN ?? process.env.AZURE_DEVOPS_EXT_PAT)
      ? { accessToken: process.env.SYSTEM_ACCESSTOKEN ?? process.env.AZURE_DEVOPS_EXT_PAT }
      : {}),
  });

  if (!done(state, 'ingest')) {
    await stageStarted(options, 'ingest');
    state.context = await ingest(config, azure);
    await checkpoint(config, state, 'ingest', options);
  }
  if (!state.context) throw new Error('Ingestion state is missing');

  const needsAgent = !done(state, 'specification')
    || !done(state, 'implementation')
    || !done(state, 'verification');
  const agent = new CopilotAgent(config.workspace, config.copilotModel);
  if (needsAgent) {
    options.signal?.throwIfAborted();
    await agent.start([developerPrompt, storybookPrompt, playwrightPrompt].join('\n'));
  }
  try {
    if (!done(state, 'specification')) {
      await stageStarted(options, 'specification');
      state.specification = await agent.prompt(
        `${specifierPrompt}\n\nContext:\n${JSON.stringify(state.context, null, 2)}`,
      );
      await checkpoint(config, state, 'specification', options);
    }
    if (!state.specification) throw new Error('Specification state is missing');

    if (!done(state, 'implementation')) {
      await stageStarted(options, 'implementation');
      await agent.prompt([
        'Implement this approved specification now. You may edit files only in the workspace.',
        state.specification,
        `Source context:\n${JSON.stringify(state.context, null, 2)}`,
      ].join('\n\n'));
      await checkpoint(config, state, 'implementation', options);
    }

    if (!done(state, 'verification')) {
      await stageStarted(options, 'verification');
      await verify({
        workspace: config.workspace,
        maxAttempts: 3,
        ...(options.signal ? { signal: options.signal } : {}),
        onAttempt: async attempt => {
          state.attempts = attempt;
          await saveState(config.stateFile, state);
          await options.onEvent?.({ stage: 'verification', status: 'started', attempt });
        },
        onFailure: async errorContext => {
          await agent.prompt([
            'Fix only the implementation or tests responsible for this exact failure.',
            'Do not publish, deploy, or advance the workflow.',
            errorContext,
          ].join('\n\n'));
        },
      });
      await checkpoint(config, state, 'verification', options);
    }
  } finally {
    if (needsAgent) await agent.stop();
  }

  if (!done(state, 'publish')) {
    await stageStarted(options, 'publish');
    if (!config.skipPublish) {
      if (!config.pipelineId) throw new Error('Missing validated pipeline ID');
      state.publication ??= {
        testsPublished: false,
        pullRequestCreated: false,
        pipelineTriggered: false,
      };
      if (!state.publication.testsPublished) {
        options.signal?.throwIfAborted();
        const testRunId = await azure.publishTestResults(config.workItemId, config.resultFiles);
        state.publication.testsPublished = true;
        if (testRunId !== undefined) state.publication.testRunId = testRunId;
        await saveState(config.stateFile, state);
      }
      if (!state.publication.pullRequestCreated) {
        options.signal?.throwIfAborted();
        await azure.ensurePullRequest(
          config.adoRepository,
          config.sourceBranch,
          config.targetBranch,
          config.workItemId,
        );
        state.publication.pullRequestCreated = true;
        await saveState(config.stateFile, state);
      }
      if (!state.publication.pipelineTriggered) {
        options.signal?.throwIfAborted();
        await azure.runPipeline(config.pipelineId, config.sourceBranch);
        state.publication.pipelineTriggered = true;
        await saveState(config.stateFile, state);
      }
    }
    await checkpoint(config, state, 'publish', options);
  }
}

async function ingest(config: HarnessConfig, azure: AzureClient): Promise<IngestedContext> {
  const figma = new FigmaClient({ token: config.figmaToken });
  const [workItem, design, openApi] = await Promise.all([
    azure.getWorkItem(config.workItemId),
    figma.getDesign(config.figmaFileKey, config.figmaNodeIds),
    loadOpenApi(config.openApiPath),
  ]);
  return { workItem, figma: design, openApi };
}

function done(state: HarnessState, stage: StageName): boolean {
  return state.completedStages.includes(stage);
}

async function checkpoint(
  config: HarnessConfig,
  state: HarnessState,
  stage: StageName,
  options: HarnessRunOptions,
): Promise<void> {
  options.signal?.throwIfAborted();
  completeStage(state, stage);
  await saveState(config.stateFile, state);
  await options.onEvent?.({ stage, status: 'completed' });
  console.log(`Completed stage: ${stage}`);
}

async function stageStarted(options: HarnessRunOptions, stage: StageName): Promise<void> {
  options.signal?.throwIfAborted();
  await options.onEvent?.({ stage, status: 'started' });
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log(`Usage: web-dev-harness [--skip-publish]

Configuration is supplied through environment variables. See README.md.`);
    return;
  }
  try {
    await runHarness(loadConfig());
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
