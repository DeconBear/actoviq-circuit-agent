export interface ChatMessage {
  id: string;
  role: 'user' | 'system';
  content: string;
  timestamp: number;
  isError?: boolean;
  conversationId?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  lastMessage: string;
  messageCount: number;
  updatedAt: number;
  jobId?: string;
}

export interface StageState {
  key: string;
  name: string;
  status: 'waiting' | 'running' | 'done' | 'error';
}

export interface ToolCallEntry {
  tool: string;
  stageKey: string;
  timestamp: number;
}

export interface StageDef {
  key: string;
  name: string;
}

export interface ChatResponse {
  text: string;
  isDesignRequest: boolean;
  formalizedRequirement?: string;
  isError?: boolean;
}

export interface WorkflowEvent {
  type:
    | 'stage-list'
    | 'stage-start'
    | 'stage-complete'
    | 'stage-error'
    | 'output'
    | 'stream-chunk'
    | 'tool-call'
    | 'workflow-complete'
    | 'job-info'
    | 'confirm-request'
    | 'confirm-rejected';
  stageKey?: string;
  stageName?: string;
  data?: unknown;
  timestamp: number;
}

export interface JobSummary {
  jobId: string;
  jobRoot: string;
  createdAt: string;
  stageCount: number;
  completedStages: number;
  status: 'running' | 'completed' | 'failed' | 'unknown' | 'incomplete';
}

export interface AppSettings {
  actoviqBaseUrl: string;
  actoviqAuthToken: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  ngspiceBin: string;
  workspaceRoot: string;
}
