export {};

declare global {
  interface Window {
    electronAPI: {
      startWorkflow(params: {
        requirement: string;
        approvalPolicy: 'manual' | 'execution' | 'all';
        jobName?: string;
        configPath?: string;
      }): void;
      pauseWorkflow(): void;
      resumeWorkflow(): void;
      stopWorkflow(): void;
      retryStage(): void;
      sendConfirmResponse(answer: 'y' | 'n'): void;
      onWorkflowEvent(callback: (event: WorkflowEvent) => void): () => void;
      readJobFile(jobId: string, relativePath: string): Promise<string>;
      writeJobFile(jobId: string, relativePath: string, content: string): Promise<void>;
      listJobs(): Promise<JobSummary[]>;
      openJobFolder(jobId: string): void;
      exportJob(jobId: string): Promise<string>;
      getSettings(): Promise<AppSettings>;
      saveSettings(settings: AppSettings): Promise<void>;
      getAppVersion(): Promise<string>;
      sendChatMessage(message: string): Promise<ChatResponse>;
    };
  }
}

interface ChatResponse {
  text: string;
  isDesignRequest: boolean;
  formalizedRequirement?: string;
}

interface WorkflowEvent {
  type: string;
  stageKey?: string;
  stageName?: string;
  data?: unknown;
  timestamp: number;
}

interface JobSummary {
  jobId: string;
  jobRoot: string;
  createdAt: string;
  stageCount: number;
  completedStages: number;
  status: 'running' | 'completed' | 'failed' | 'unknown' | 'incomplete';
}

interface AppSettings {
  actoviqBaseUrl: string;
  actoviqAuthToken: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  ngspiceBin: string;
  workspaceRoot: string;
}

interface StageDef {
  key: string;
  name: string;
}
