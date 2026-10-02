import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionConfig } from '../src/dashboard/config.js';
import { createDemoServices, demoSessionInput, prepareDemoWorkspace } from '../src/demo.js';
import { runHarness, submitHumanOutputs } from '../src/harness.js';
import { loadState } from '../src/state.js';
import type { HumanInputRequest, StageName } from '../src/types.js';
import {
  costSummary,
  normalizeStepOutputs,
  parseAgentOutputs,
  resolveExecutors,
} from '../src/workflow.js';

const humanOutputs: Record<string, object> = {
  'requirements-analysis': {
    summary: 'Feedback form with rating',
    assumptions: ['Anonymous users allowed'],
    acceptanceCriteria: ['Rejects invalid email'],
  },
  'impact-analysis': { summary: 'New component only', affectedAreas: ['src/feedback-form.ts'], risks: [] },
  specification: { specification: 'SPEC: <feedback-form> with email, rating, message' },
  implementation: { summary: 'Implemented by hand' },
};

const allHuman = {
  'requirements-analysis': 'human-m365',
  'impact-analysis': 'human-m365',
  specification: 'human',
  implementation: 'human',
} as const;

async function hybridConfig() {
  const workspace = await prepareDemoWorkspace();
  return createSessionConfig(
    { ...demoSessionInput(workspace), skipPublish: true, executors: allHuman },
    'hybrid-test',
  );
}

test('executors default per step and reject disallowed assignments', () => {
  const executors = resolveExecutors({ 'requirements-analysis': 'human-m365' });
  assert.equal(executors['requirements-analysis'], 'human-m365');
  assert.equal(executors.specification, 'github-agent');
  assert.equal(executors.verification, 'tool');
  assert.throws(() => resolveExecutors({ verification: 'human' }), /cannot be executed by human/);
  assert.throws(() => resolveExecutors({ unknown: 'tool' }), /Unknown workflow step/);
});

test('human and agent outputs share one structured contract', () => {
  assert.deepEqual(normalizeStepOutputs('requirements-analysis', { summary: ' s ', assumptions: ['a', ' '] }), {
    summary: 's',
    assumptions: ['a'],
    acceptanceCriteria: [],
  });
  assert.throws(() => normalizeStepOutputs('requirements-analysis', { assumptions: [] }), /summary is required/);
  assert.throws(() => normalizeStepOutputs('impact-analysis', { summary: 'x', risks: 'one' }), /array of strings/);
  assert.throws(() => normalizeStepOutputs('verification', {}), /does not accept/);

  const fromAgent = parseAgentOutputs('requirements-analysis', 'Here:\n{"summary":"ok","acceptanceCriteria":["c"]}');
  assert.deepEqual(fromAgent, { summary: 'ok', assumptions: [], acceptanceCriteria: ['c'] });
  assert.equal(parseAgentOutputs('impact-analysis', 'not json').summary, 'not json');
  assert.deepEqual(parseAgentOutputs('specification', 'Spec with {"json": true}'), {
    specification: 'Spec with {"json": true}',
  });
});

test('cost summary counts executors and avoided agent calls', () => {
  const cost = costSummary(resolveExecutors({ 'requirements-analysis': 'human-m365', 'impact-analysis': 'human' }));
  assert.deepEqual(cost, {
    humanSteps: 2,
    agentSteps: 2,
    toolSteps: 3,
    estimatedCopilotCalls: 2,
    copilotCalls: 0,
    agentCallsAvoided: 2,
  });
});

test('workflow pauses on human steps and downstream steps consume their outputs', async () => {
  const config = await hybridConfig();
  const requests: HumanInputRequest[] = [];
  const events: string[] = [];
  const outcome = await runHarness(config, {
    services: createDemoServices(),
    onEvent: event => {
      events.push(`${event.stage}:${event.status}`);
    },
    awaitHumanInput: async request => {
      requests.push(request);
      const state = await loadState(config.stateFile, config.workItemId);
      assert.equal(state.steps[request.stepId]?.status, 'waiting_for_human');
      return humanOutputs[request.stepId];
    },
  });

  assert.deepEqual(outcome, { status: 'completed' });
  assert.deepEqual(requests.map(request => request.stepId), [
    'requirements-analysis',
    'impact-analysis',
    'specification',
    'implementation',
  ]);
  // Later briefings include earlier human outputs, exactly like agent prompts do.
  assert.match(requests[1]?.briefing ?? '', /Anonymous users allowed/);
  assert.match(requests[3]?.briefing ?? '', /SPEC: <feedback-form>/);
  assert.ok(events.includes('requirements-analysis:waiting_for_human'));
  assert.ok(events.includes('requirements-analysis:resumed'));

  const state = await loadState(config.stateFile, config.workItemId);
  assert.equal(state.completedStages.length, 7);
  assert.equal(state.agentCalls, 0);
  assert.equal(state.steps['requirements-analysis']?.executor, 'human-m365');
  assert.deepEqual(state.steps['requirements-analysis']?.outputs, humanOutputs['requirements-analysis']);
  assert.equal(state.steps.verification?.executor, 'tool');
  assert.deepEqual(
    state.history.filter(entry => entry.stepId === 'impact-analysis').map(entry => entry.event),
    ['started', 'waiting_for_human', 'resumed', 'completed'],
  );
});

test('without an attended channel the workflow persists the pause and resumes after submission', async () => {
  const config = await hybridConfig();
  const services = createDemoServices();
  const order: StageName[] = ['requirements-analysis', 'impact-analysis', 'specification', 'implementation'];
  for (const stepId of order) {
    assert.deepEqual(await runHarness(config, { services }), { status: 'waiting_for_human', stepId });
    await assert.rejects(submitHumanOutputs(config, { stepId: 'publish', outputs: {} }), /not waiting/);
    await submitHumanOutputs(config, { stepId, outputs: humanOutputs[stepId] });
  }
  assert.deepEqual(await runHarness(config, { services }), { status: 'completed' });
  const state = await loadState(config.stateFile, config.workItemId);
  assert.ok(state.completedStages.includes('publish'));
});
