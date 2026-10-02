// Pure workflow model shared by the harness, the session manager and the browser UI.
import type {
  ExecutorType as ExecutorTypeValue,
  HarnessState,
  HumanInputRequest,
  OutputField,
  StageName,
  StepHistoryEntry,
  StepOutputs,
} from './types.js';

export const ExecutorType = {
  HUMAN: 'human',
  M365_COPILOT: 'human-m365',
  GITHUB_AGENT: 'github-agent',
  TOOL: 'tool',
} as const satisfies Record<string, ExecutorTypeValue>;

const { HUMAN, M365_COPILOT, GITHUB_AGENT, TOOL } = ExecutorType;
const attendedOrAgent = [M365_COPILOT, HUMAN, GITHUB_AGENT] as const;

export interface StepDefinition {
  id: StageName;
  title: string;
  defaultExecutor: ExecutorTypeValue;
  executors: readonly ExecutorTypeValue[];
  instructions?: string;
  outputs?: readonly OutputField[];
}

export const workflowSteps: readonly StepDefinition[] = [
  { id: 'ingest', title: 'Ingest Sources', defaultExecutor: TOOL, executors: [TOOL] },
  {
    id: 'requirements-analysis',
    title: 'Requirements Analysis',
    defaultExecutor: GITHUB_AGENT,
    executors: attendedOrAgent,
    instructions: 'Analyze the Azure DevOps work item and the Figma design. Summarize the requirement, list the assumptions you made, and derive testable acceptance criteria.',
    outputs: [
      { name: 'summary', label: 'Summary', kind: 'text', required: true },
      { name: 'assumptions', label: 'Assumptions', kind: 'list' },
      { name: 'acceptanceCriteria', label: 'Acceptance criteria', kind: 'list' },
    ],
  },
  {
    id: 'impact-analysis',
    title: 'Impact Analysis',
    defaultExecutor: GITHUB_AGENT,
    executors: attendedOrAgent,
    instructions: 'Identify the components, APIs, and files affected by this change and the risks it introduces.',
    outputs: [
      { name: 'summary', label: 'Summary', kind: 'text', required: true },
      { name: 'affectedAreas', label: 'Affected areas', kind: 'list' },
      { name: 'risks', label: 'Risks', kind: 'list' },
    ],
  },
  {
    id: 'specification',
    title: 'Implementation Plan',
    defaultExecutor: GITHUB_AGENT,
    executors: attendedOrAgent,
    instructions: 'Write the Lion/Open-WC TDD specification for the component: public API, states, accessibility, Storybook stories, and Playwright tests.',
    outputs: [{ name: 'specification', label: 'Specification', kind: 'text', required: true }],
  },
  {
    id: 'implementation',
    title: 'Code Generation',
    defaultExecutor: GITHUB_AGENT,
    executors: attendedOrAgent,
    instructions: 'Implement the approved specification in the workspace, then summarize the changes.',
    outputs: [{ name: 'summary', label: 'Change summary', kind: 'text', required: true }],
  },
  { id: 'verification', title: 'Validation', defaultExecutor: TOOL, executors: [TOOL] },
  { id: 'publish', title: 'Publish', defaultExecutor: TOOL, executors: [TOOL] },
];

const maxText = 20_000;
const maxItems = 100;
const maxItemLength = 2_000;

export function stepDefinition(stepId: StageName): StepDefinition {
  const definition = workflowSteps.find(step => step.id === stepId);
  if (!definition) throw new Error(`Unknown workflow step: ${stepId}`);
  return definition;
}

export function executorLabel(executor: ExecutorTypeValue): string {
  switch (executor) {
    case HUMAN: return 'Human';
    case M365_COPILOT: return 'Human + M365 Copilot';
    case GITHUB_AGENT: return 'GitHub Agent';
    case TOOL: return 'Tool';
  }
}

export function isHumanExecutor(executor: ExecutorTypeValue): boolean {
  return executor === HUMAN || executor === M365_COPILOT;
}

export function resolveExecutors(overrides: unknown = {}): Record<StageName, ExecutorTypeValue> {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('executors must be an object of step ID to executor type');
  }
  const resolved = Object.fromEntries(
    workflowSteps.map(step => [step.id, step.defaultExecutor]),
  ) as Record<StageName, ExecutorTypeValue>;
  for (const [stepId, executor] of Object.entries(overrides)) {
    const definition = workflowSteps.find(step => step.id === stepId);
    if (!definition) throw new Error(`Unknown workflow step: ${stepId}`);
    if (!definition.executors.includes(executor as ExecutorTypeValue)) {
      throw new Error(`${stepId} cannot be executed by ${String(executor)}`);
    }
    resolved[definition.id] = executor as ExecutorTypeValue;
  }
  return resolved;
}

/** Validates human (or agent) outputs against the step's output contract. */
export function normalizeStepOutputs(stepId: StageName, value: unknown): StepOutputs {
  const fields = stepDefinition(stepId).outputs;
  if (!fields) throw new Error(`${stepId} does not accept external outputs`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('outputs must be an object');
  }
  const input = value as Record<string, unknown>;
  const outputs: StepOutputs = {};
  for (const field of fields) {
    const raw = input[field.name];
    if (field.kind === 'text') {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (field.required && !text) throw new Error(`${field.name} is required`);
      if (text.length > maxText) throw new Error(`${field.name} exceeds ${maxText} characters`);
      outputs[field.name] = text;
    } else {
      const items = Array.isArray(raw) ? raw : raw === undefined ? [] : undefined;
      if (!items || items.some(item => typeof item !== 'string')) {
        throw new Error(`${field.name} must be an array of strings`);
      }
      const list = (items as string[]).map(item => item.trim()).filter(Boolean);
      if (list.length > maxItems || list.some(item => item.length > maxItemLength)) {
        throw new Error(`${field.name} exceeds ${maxItems} items of ${maxItemLength} characters`);
      }
      if (field.required && !list.length) throw new Error(`${field.name} is required`);
      outputs[field.name] = list;
    }
  }
  return outputs;
}

/** Maps an agent reply onto the same output contract a human fills in. */
export function parseAgentOutputs(stepId: StageName, reply: string): StepOutputs {
  const fields = stepDefinition(stepId).outputs ?? [];
  const primary = fields[0]?.name ?? 'summary';
  if (fields.some(field => field.kind === 'list')) {
    const json = /\{[\s\S]*\}/.exec(reply)?.[0];
    try {
      if (json) return normalizeStepOutputs(stepId, JSON.parse(json));
    } catch {
      // Fall through: keep the raw reply rather than fail the step.
    }
  }
  return { ...emptyOutputs(fields), [primary]: reply.trim() };
}

function emptyOutputs(fields: readonly OutputField[]): StepOutputs {
  return Object.fromEntries(fields.map(field => [field.name, field.kind === 'list' ? [] : '']));
}

/** Outputs of completed steps, as consumed by downstream steps regardless of executor. */
export function workflowOutputs(state: HarnessState): Record<string, unknown> {
  return Object.fromEntries(
    workflowSteps
      .filter(step => step.outputs && state.steps[step.id]?.status === 'completed')
      .map(step => [step.id, {
        executor: state.steps[step.id]?.executor,
        outputs: state.steps[step.id]?.outputs,
      }]),
  );
}

export function outputText(state: HarnessState, stepId: StageName, field: string): string | undefined {
  const value = state.steps[stepId]?.outputs?.[field];
  return typeof value === 'string' && value ? value : undefined;
}

function responseFormat(fields: readonly OutputField[]): string {
  return fields
    .map(field => `- ${field.name}: ${field.kind === 'list' ? 'array of strings' : 'string'}${field.required ? ' (required)' : ''}`)
    .join('\n');
}

function sourceSections(state: HarnessState): string {
  return [
    `Source context:\n${JSON.stringify(state.context ?? {}, null, 2)}`,
    `Outputs of completed workflow steps:\n${JSON.stringify(workflowOutputs(state), null, 2)}`,
  ].join('\n\n');
}

/** Prompt for an autonomous agent executing a structured analysis step. */
export function agentStepPrompt(stepId: StageName, state: HarnessState): string {
  const step = stepDefinition(stepId);
  return [
    `Workflow step: ${step.title}. Do not edit files in this step.`,
    step.instructions,
    `Respond with only a JSON object with these keys:\n${responseFormat(step.outputs ?? [])}`,
    sourceSections(state),
  ].join('\n\n');
}

export function humanInputRequest(
  stepId: StageName,
  executor: ExecutorTypeValue,
  state: HarnessState,
): HumanInputRequest {
  const step = stepDefinition(stepId);
  const fields = [...(step.outputs ?? [])];
  return {
    stepId,
    executor,
    title: step.title,
    instructions: step.instructions ?? '',
    briefing: [
      `I am performing the "${step.title}" step of a software delivery workflow.`,
      step.instructions,
      `Answer with these sections (lists one item per line):\n${responseFormat(fields)}`,
      sourceSections(state),
    ].join('\n\n'),
    fields,
  };
}

function record(state: HarnessState, entry: Omit<StepHistoryEntry, 'at'>): string {
  const at = new Date().toISOString();
  state.history.push({ at, ...entry });
  return at;
}

export function markStepStarted(state: HarnessState, stepId: StageName, executor: ExecutorTypeValue): void {
  const startedAt = record(state, { stepId, executor, event: 'started' });
  state.steps[stepId] = { stepId, executor, status: 'running', startedAt };
}

export function markStepWaiting(state: HarnessState, stepId: StageName, executor: ExecutorTypeValue): void {
  const step = state.steps[stepId];
  if (step?.status === 'waiting_for_human') return;
  record(state, { stepId, executor, event: 'waiting_for_human' });
  state.steps[stepId] = { ...step, stepId, executor, status: 'waiting_for_human' };
}

export function markStepResumed(state: HarnessState, stepId: StageName, executor: ExecutorTypeValue): void {
  record(state, { stepId, executor, event: 'resumed' });
}

export function markStepCompleted(
  state: HarnessState,
  stepId: StageName,
  executor: ExecutorTypeValue,
  outputs: StepOutputs,
): void {
  const completedAt = record(state, { stepId, executor, event: 'completed' });
  state.steps[stepId] = { ...state.steps[stepId], stepId, executor, status: 'completed', outputs, completedAt };
  if (!state.completedStages.includes(stepId)) state.completedStages.push(stepId);
}

export interface CostSummary {
  humanSteps: number;
  agentSteps: number;
  toolSteps: number;
  estimatedCopilotCalls: number;
  copilotCalls: number;
  agentCallsAvoided: number;
}

export function costSummary(
  executors: Record<StageName, ExecutorTypeValue>,
  state?: Pick<HarnessState, 'agentCalls'>,
): CostSummary {
  const assigned = workflowSteps.map(step => executors[step.id] ?? step.defaultExecutor);
  const humanSteps = assigned.filter(isHumanExecutor).length;
  const agentSteps = assigned.filter(executor => executor === GITHUB_AGENT).length;
  const copilotCalls = state?.agentCalls ?? 0;
  return {
    humanSteps,
    agentSteps,
    toolSteps: assigned.filter(executor => executor === TOOL).length,
    estimatedCopilotCalls: Math.max(agentSteps, copilotCalls),
    copilotCalls,
    // Every attended step is one that an agent could otherwise have executed.
    agentCallsAvoided: humanSteps,
  };
}
