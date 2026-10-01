import type { HarnessConfig, HarnessState, StageName, TranscriptEntry } from '../types.js';

export type SessionStatus =
  | 'queued'
  | 'running'
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
  /** Only present on the session detail endpoint, not the list. */
  transcript?: TranscriptEntry[];
}
