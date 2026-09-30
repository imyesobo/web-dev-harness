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

export interface HarnessRunOptions {
  signal?: AbortSignal;
  onEvent?: (event: HarnessEvent) => void | Promise<void>;
}
