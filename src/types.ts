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
}

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type StageName =
  | 'ingest'
  | 'specification'
  | 'implementation'
  | 'verification'
  | 'publish';

export interface HarnessState {
  workItemId: number;
  completedStages: StageName[];
  attempts: number;
  context?: IngestedContext;
  specification?: string;
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
  status: 'started' | 'completed';
  attempt?: number;
}

/** Fine-grained agentic-layer activity surfaced to the progress event bus. */
export interface AgentActivity {
  type: 'prompt' | 'tool.start' | 'tool.end' | 'turn.end';
  tool?: { name: string; argsSummary?: string };
}

export interface TranscriptEntry {
  at: string;
  stage?: StageName;
  role: 'user' | 'assistant' | 'reasoning' | 'tool';
  content: string;
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
  onActivity?: (activity: AgentActivity) => void;
  services?: HarnessServices;
}
