import { contextBridge, ipcRenderer } from 'electron';

export interface WorkflowParams {
  requirement: string;
  approvalPolicy: 'manual' | 'execution' | 'all';
  jobName?: string;
  configPath?: string;
}

export interface WorkflowEvent {
  type: 'stage-start' | 'stage-complete' | 'stage-error' | 'stream-chunk' | 'tool-call' | 'workflow-complete';
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
  status: 'running' | 'completed' | 'failed';
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

const electronAPI = {
  startWorkflow(params: WorkflowParams): void {
    ipcRenderer.send('workflow:start', params);
  },

  pauseWorkflow(): void {
    ipcRenderer.send('workflow:pause');
  },

  resumeWorkflow(): void {
    ipcRenderer.send('workflow:resume');
  },

  stopWorkflow(): void {
    ipcRenderer.send('workflow:stop');
  },

  retryStage(): void {
    ipcRenderer.send('workflow:retry-stage');
  },

  onWorkflowEvent(callback: (event: WorkflowEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: WorkflowEvent): void => {
      callback(data);
    };
    ipcRenderer.on('workflow:event', handler);
    return () => {
      ipcRenderer.removeListener('workflow:event', handler);
    };
  },

  readJobFile(jobId: string, relativePath: string): Promise<string> {
    return ipcRenderer.invoke('file:read', { jobId, relativePath });
  },

  writeJobFile(jobId: string, relativePath: string, content: string): Promise<void> {
    return ipcRenderer.invoke('file:write', { jobId, relativePath, content });
  },

  listJobs(): Promise<JobSummary[]> {
    return ipcRenderer.invoke('file:list-jobs');
  },

  openJobFolder(jobId: string): void {
    ipcRenderer.send('file:open-folder', { jobId });
  },

  exportJob(jobId: string): Promise<string> {
    return ipcRenderer.invoke('file:export', { jobId });
  },

  getSettings(): Promise<AppSettings> {
    return ipcRenderer.invoke('settings:get');
  },

  saveSettings(settings: AppSettings): Promise<void> {
    return ipcRenderer.invoke('settings:save', settings);
  },

  getAppVersion(): Promise<string> {
    return ipcRenderer.invoke('app:version');
  },

  sendChatMessage(message: string): Promise<ChatResponse> {
    return ipcRenderer.invoke('chat:send', message);
  },
};

export interface ChatResponse {
  text: string;
  isDesignRequest: boolean;
  formalizedRequirement?: string;
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export type ElectronAPI = typeof electronAPI;
