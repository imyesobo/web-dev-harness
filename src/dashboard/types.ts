import type {
  ExecutorType,
  HarnessConfig,
  HarnessState,
  HumanInputRequest,
  StageName,
  TranscriptEntry,
} from '../types.js';

export type SessionStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_human'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SessionConfigInput {
  workspace: string;
  workItemId: number;
  adoOrganization: string;
  adoProject: string;
  adoRepository: string;
  sourceBranch?: string;
  targetBranch?: string;
  pipelineId?: number;
  figmaFileKey: string;
  figmaNodeIds?: string[];
  figmaToken: string;
  openApiPath: string;
  copilotModel?: string;
  resultFiles?: string[];
  skipPublish?: boolean;
  /** Overrides of the default executor per step, e.g. { "requirements-analysis": "human-m365" }. */
  executors?: Partial<Record<StageName, ExecutorType>>;
}

export interface SessionRecord {
  id: string;
  status: SessionStatus;
  currentStage?: StageName;
  attempt?: number;
  startedAt: string;
  endedAt?: string;
  error?: string;
  config: Omit<HarnessConfig, 'figmaToken'> & { figmaTokenConfigured: boolean };
  state?: HarnessState;
  /** Present while the workflow is paused on a human-assisted step. */
  pendingInput?: HumanInputRequest;
  /** Only present on the session detail endpoint, not the list. */
  transcript?: TranscriptEntry[];
}
