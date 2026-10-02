export interface HarnessConfig {
  workspace: string;
  stateFile: string;
  workItemId: number;
  adoOrganization: string;
  adoProject: string;
  adoRepository: string;
  sourceBranch: string;
  targetBranch: string;
  pipelineId?: number;
  figmaFileKey: string;
  figmaNodeIds?: string[];
  figmaToken: string;
  openApiPath: string;
  copilotModel: string;
  resultFiles: string[];
  skipPublish: boolean;
  /** Executor assigned to every workflow step; resolved from defaults plus overrides. */
  executors: Record<StageName, ExecutorType>;
}

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type StageName =
  | 'ingest'
  | 'requirements-analysis'
  | 'impact-analysis'
  | 'specification'
  | 'implementation'
  | 'verification'
  | 'publish';

/** Who executes a step. Workflow progression never depends on this value. */
export type ExecutorType = 'human' | 'human-m365' | 'github-agent' | 'tool';

export type StepStatus = 'pending' | 'running' | 'waiting_for_human' | 'completed';

export type StepOutputs = Record<string, string | string[] | number | boolean>;

export interface StepRecord {
  stepId: StageName;
  executor: ExecutorType;
  status: StepStatus;
  outputs?: StepOutputs;
  startedAt?: string;
  completedAt?: string;
}

export interface StepHistoryEntry {
  at: string;
  stepId: StageName;
  executor: ExecutorType;
  event: 'started' | 'waiting_for_human' | 'resumed' | 'completed';
}

export interface OutputField {
  name: string;
  label: string;
  kind: 'text' | 'list';
  required?: boolean;
}

/** What the harness hands to a human executor when it pauses. */
export interface HumanInputRequest {
  stepId: StageName;
  executor: ExecutorType;
  title: string;
  instructions: string;
  /** Ready-to-paste prompt for Microsoft 365 Copilot or another attended assistant. */
  briefing: string;
  fields: OutputField[];
}

export interface HarnessState {
  workItemId: number;
  completedStages: StageName[];
  attempts: number;
  steps: Partial<Record<StageName, StepRecord>>;
  history: StepHistoryEntry[];
  agentCalls: number;
  context?: IngestedContext;
  publication?: {
    testsPublished: boolean;
    pullRequestCreated: boolean;
    pipelineTriggered: boolean;
    testRunId?: number;
  };
  updatedAt: string;
}

export interface IngestedContext {
  workItem: unknown;
  figma: unknown;
  openApi: unknown;
}

export interface TestResult {
  name: string;
  outcome: 'Passed' | 'Failed' | 'NotExecuted';
  durationMs?: number;
  errorMessage?: string;
}

export interface HarnessEvent {
  stage: StageName;
  status: 'started' | 'completed' | 'waiting_for_human' | 'resumed';
  executor?: ExecutorType;
  attempt?: number;
}

export interface TranscriptEntry {
  at: string;
  stage?: StageName;
  role: 'user' | 'assistant' | 'reasoning' | 'tool' | 'human';
  content: string;
}

export interface HarnessOutcome {
  status: 'completed' | 'waiting_for_human';
  stepId?: StageName;
}

export interface AzureService {
  getWorkItem(id: number): Promise<unknown>;
  ensurePullRequest(
    repository: string,
    sourceBranch: string,
    targetBranch: string,
    workItemId: number,
  ): Promise<unknown>;
  runPipeline(pipelineId: number, branch: string): Promise<unknown>;
  publishTestResults(workItemId: number, resultFiles: readonly string[]): Promise<number | undefined>;
}

export interface FigmaService {
  getDesign(fileKey: string, nodeIds?: readonly string[]): Promise<unknown>;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) => Promise<CommandResult>;

/** Overrides for external integrations; used by demo mode and tests. */
export interface HarnessServices {
  azure?: AzureService;
  figma?: FigmaService;
  loadOpenApi?: (file: string) => Promise<unknown>;
  verificationRunner?: CommandRunner;
}

export interface HarnessRunOptions {
  signal?: AbortSignal;
  onEvent?: (event: HarnessEvent) => void | Promise<void>;
  onTranscript?: (entry: TranscriptEntry) => void;
  services?: HarnessServices;
  /**
   * Resolves with the human's structured outputs. Without it the harness
   * persists the waiting state and returns, to be resumed later.
   */
  awaitHumanInput?: (request: HumanInputRequest) => Promise<unknown>;
}
