import type { AppSettings, ChatResponse, JobSummary, WorkflowEvent } from './types';

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
      sendChatMessage(message: string, history?: Array<{ role: string; content: string }>): Promise<ChatResponse>;
    };
  }
}
