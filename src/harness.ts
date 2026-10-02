#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadPromptSet } from './agents.js';
import { AzureClient } from './cli/azure.js';
import { FigmaClient } from './cli/figma.js';
import { loadConfig } from './config.js';
import { CopilotAgent } from './copilot.js';
import { loadOpenApi } from './openapi.js';
import { loadState, saveState } from './state.js';
import type {
  AzureService,
  HarnessConfig,
  HarnessOutcome,
  HarnessRunOptions,
  HarnessState,
  IngestedContext,
  StageName,
  StepOutputs,
  TranscriptEntry,
} from './types.js';
import { verify } from './verification.js';
import {
  agentStepPrompt,
  executorLabel,
  humanInputRequest,
  isHumanExecutor,
  markStepCompleted,
  markStepResumed,
  markStepStarted,
  markStepWaiting,
  normalizeStepOutputs,
  outputText,
  parseAgentOutputs,
  workflowOutputs,
} from './workflow.js';

export async function runHarness(
  config: HarnessConfig,
  options: HarnessRunOptions = {},
): Promise<HarnessOutcome> {
  const state = await loadState(config.stateFile, config.workItemId);
  const azure = options.services?.azure ?? new AzureClient({
    organization: config.adoOrganization,
    project: config.adoProject,
    workspace: config.workspace,
    ...((process.env.SYSTEM_ACCESSTOKEN ?? process.env.AZURE_DEVOPS_EXT_PAT)
      ? { accessToken: process.env.SYSTEM_ACCESSTOKEN ?? process.env.AZURE_DEVOPS_EXT_PAT }
      : {}),
  });
  let currentStage: StageName | undefined;
  const transcript = (role: TranscriptEntry['role'], content: string): void => {
    options.onTranscript?.({
      at: new Date().toISOString(),
      ...(currentStage ? { stage: currentStage } : {}),
      role,
      content,
    });
  };

  const begin = async (stage: StageName): Promise<void> => {
    options.signal?.throwIfAborted();
    currentStage = stage;
    const executor = config.executors[stage];
    if (state.steps[stage]?.status !== 'waiting_for_human') markStepStarted(state, stage, executor);
    await saveState(config.stateFile, state);
    await options.onEvent?.({ stage, status: 'started', executor });
  };
  const finish = async (stage: StageName, outputs: StepOutputs): Promise<void> => {
    options.signal?.throwIfAborted();
    const executor = config.executors[stage];
    markStepCompleted(state, stage, executor, outputs);
    await saveState(config.stateFile, state);
    await options.onEvent?.({ stage, status: 'completed', executor });
    console.log(`Completed stage: ${stage} (${executor})`);
  };

  if (!done(state, 'ingest')) {
    await begin('ingest');
    state.context = await ingest(config, azure, options);
    await finish('ingest', { summary: 'Work item, Figma design and OpenAPI contract ingested' });
  }
  if (!state.context) throw new Error('Ingestion state is missing');

  const agent = new CopilotAgent(config.workspace, config.copilotModel, transcript);
  const prompts = await loadPromptSet();
  let agentStarted = false;
  const ask = async (prompt: string): Promise<string> => {
    options.signal?.throwIfAborted();
    if (!agentStarted) {
      await agent.start(prompts.system);
      agentStarted = true;
    }
    state.agentCalls += 1;
    await saveState(config.stateFile, state);
    return agent.prompt(prompt);
  };

  /** Runs an assignable step; returns false when it is parked waiting for a human. */
  const runStep = async (stage: StageName, agentPrompt: () => string): Promise<boolean> => {
    if (done(state, stage)) return true;
    await begin(stage);
    const executor = config.executors[stage];
    if (!isHumanExecutor(executor)) {
      await finish(stage, parseAgentOutputs(stage, await ask(agentPrompt())));
      return true;
    }
    const request = humanInputRequest(stage, executor, state);
    markStepWaiting(state, stage, executor);
    await saveState(config.stateFile, state);
    transcript('user', `Waiting for ${executorLabel(executor)}: ${request.instructions}`);
    await options.onEvent?.({ stage, status: 'waiting_for_human', executor });
    if (!options.awaitHumanInput) return false;
    const outputs = normalizeStepOutputs(stage, await options.awaitHumanInput(request));
    options.signal?.throwIfAborted();
    transcript('human', JSON.stringify(outputs, null, 2));
    markStepResumed(state, stage, executor);
    await options.onEvent?.({ stage, status: 'resumed', executor });
    await finish(stage, outputs);
    return true;
  };

  try {
    for (const stage of ['requirements-analysis', 'impact-analysis'] as const) {
      if (!await runStep(stage, () => agentStepPrompt(stage, state))) {
        return { status: 'waiting_for_human', stepId: stage };
      }
    }

    const specified = await runStep('specification', () => [
      prompts.specifier,
      `Context:\n${JSON.stringify(state.context, null, 2)}`,
      `Outputs of completed workflow steps:\n${JSON.stringify(workflowOutputs(state), null, 2)}`,
    ].join('\n\n'));
    if (!specified) return { status: 'waiting_for_human', stepId: 'specification' };
    const specification = outputText(state, 'specification', 'specification');
    if (!specification) throw new Error('Specification state is missing');

    const implemented = await runStep('implementation', () => [
      'Implement this approved specification now. You may edit files only in the workspace.',
      specification,
      `Source context:\n${JSON.stringify(state.context, null, 2)}`,
      `Outputs of completed workflow steps:\n${JSON.stringify(workflowOutputs(state), null, 2)}`,
    ].join('\n\n'));
    if (!implemented) return { status: 'waiting_for_human', stepId: 'implementation' };

    if (!done(state, 'verification')) {
      await begin('verification');
      await verify({
        workspace: config.workspace,
        maxAttempts: 3,
        ...(options.services?.verificationRunner
          ? { runner: options.services.verificationRunner }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        onAttempt: async attempt => {
          state.attempts = attempt;
          await saveState(config.stateFile, state);
          await options.onEvent?.({ stage: 'verification', status: 'started', executor: 'tool', attempt });
        },
        onFailure: async errorContext => {
          await ask([
            'Fix only the implementation or tests responsible for this exact failure.',
            'Do not publish, deploy, or advance the workflow.',
            errorContext,
          ].join('\n\n'));
        },
      });
      await finish('verification', { attempts: state.attempts });
    }
  } finally {
    if (agentStarted) await agent.stop();
  }

  if (!done(state, 'publish')) {
    await begin('publish');
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
    await finish('publish', config.skipPublish ? { skipped: true } : { ...state.publication });
  }
  return { status: 'completed' };
}

/** Records structured outputs for a step parked waiting for a human, so a re-run resumes past it. */
export async function submitHumanOutputs(config: HarnessConfig, submission: unknown): Promise<void> {
  const { stepId, outputs } = (submission ?? {}) as { stepId?: StageName; outputs?: unknown };
  const state = await loadState(config.stateFile, config.workItemId);
  const step = stepId ? state.steps[stepId] : undefined;
  if (!stepId || step?.status !== 'waiting_for_human') {
    throw new Error(`Step ${String(stepId)} is not waiting for human input`);
  }
  const normalized = normalizeStepOutputs(stepId, outputs);
  markStepResumed(state, stepId, step.executor);
  markStepCompleted(state, stepId, step.executor, normalized);
  await saveState(config.stateFile, state);
}

async function ingest(
  config: HarnessConfig,
  azure: AzureService,
  options: HarnessRunOptions,
): Promise<IngestedContext> {
  const figma = options.services?.figma ?? new FigmaClient({ token: config.figmaToken });
  const loadApi = options.services?.loadOpenApi ?? loadOpenApi;
  const [workItem, design, openApi] = await Promise.all([
    azure.getWorkItem(config.workItemId),
    figma.getDesign(config.figmaFileKey, config.figmaNodeIds),
    loadApi(config.openApiPath),
  ]);
  return { workItem, figma: design, openApi };
}

function done(state: HarnessState, stage: StageName): boolean {
  return state.completedStages.includes(stage);
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log(`Usage: web-dev-harness [--skip-publish] [--submit <outputs.json>]

Configuration is supplied through environment variables. See README.md.
--submit records {"stepId": "...", "outputs": {...}} for a step waiting for
human input and resumes the workflow.`);
    return;
  }
  try {
    const config = loadConfig();
    const submitIndex = process.argv.indexOf('--submit');
    if (submitIndex !== -1) {
      const file = process.argv[submitIndex + 1];
      if (!file) throw new Error('--submit requires a JSON file path');
      await submitHumanOutputs(config, JSON.parse(await readFile(file, 'utf8')));
    }
    const outcome = await runHarness(config);
    if (outcome.status === 'waiting_for_human' && outcome.stepId) {
      const state = await loadState(config.stateFile, config.workItemId);
      const request = humanInputRequest(outcome.stepId, config.executors[outcome.stepId], state);
      console.log([
        `Workflow paused: ${request.title} is waiting for ${executorLabel(request.executor)}.`,
        `Expected outputs: ${request.fields.map(field => `${field.name} (${field.kind})`).join(', ')}`,
        `Resume with: web-dev-harness --submit <file> where the file contains {"stepId": "${request.stepId}", "outputs": {...}}`,
        '',
        request.briefing,
      ].join('\n'));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
