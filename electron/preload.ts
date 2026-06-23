import { contextBridge, ipcRenderer } from 'electron';

export interface WorkflowParams {
  requirement?: string;
  approvalPolicy: 'manual' | 'execution' | 'all';
  jobName?: string;
  configPath?: string;
  revisionBaseJob?: string;
  resumeJob?: string;
  jobParentDir?: string;
  rerunFromStage?: string;
}

export interface WorkflowEvent {
  type: 'stage-list' | 'stage-start' | 'stage-complete' | 'stage-error' | 'output' | 'stream-chunk' | 'tool-call' | 'workflow-complete' | 'job-info' | 'confirm-request' | 'confirm-rejected';
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

export interface WorkspaceSummary {
  id: string;
  name: string;
  root: string;
  jobsDir: string;
  projectsDir: string;
  referencesDir: string;
  createdAt: string;
  lastOpenedAt: string;
}

export interface ReferenceDocument {
  name: string;
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  updatedAt: string;
  ocrTextPath?: string;
}

export interface AppSettings {
  actoviqBaseUrl: string;
  actoviqAuthToken: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  ngspiceBin: string;
  workspaceRoot: string;
  yunzhishengOcrBaseUrl: string;
  yunzhishengOcrApiKey: string;
  yunzhishengOcrModel: string;
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

  sendConfirmResponse(answer: 'y' | 'n'): void {
    ipcRenderer.send('workflow:confirm-response', answer);
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

  listWorkspaces(): Promise<WorkspaceSummary[]> {
    return ipcRenderer.invoke('workspace:list');
  },

  getActiveWorkspace(): Promise<WorkspaceSummary> {
    return ipcRenderer.invoke('workspace:active');
  },

  createWorkspace(input: { name?: string; root?: string }): Promise<WorkspaceSummary> {
    return ipcRenderer.invoke('workspace:create', input);
  },

  selectWorkspace(id: string): Promise<WorkspaceSummary> {
    return ipcRenderer.invoke('workspace:select', id);
  },

  chooseWorkspaceRoot(): Promise<string | null> {
    return ipcRenderer.invoke('workspace:choose-root');
  },

  openWorkspaceRoot(): void {
    ipcRenderer.send('workspace:open-root');
  },

  openWorkspaceReferences(): void {
    ipcRenderer.send('workspace:open-references');
  },

  listReferenceDocuments(): Promise<ReferenceDocument[]> {
    return ipcRenderer.invoke('workspace:list-references');
  },

  runReferenceOcr(relativePath: string): Promise<{ textPath: string; text: string }> {
    return ipcRenderer.invoke('workspace:ocr-reference', relativePath);
  },

  listCircuitProjects(): Promise<unknown[]> {
    return ipcRenderer.invoke('project:list');
  },

  createCircuitProject(input: { name: string; demo?: boolean }): Promise<unknown> {
    return ipcRenderer.invoke('project:create', input);
  },

  getCircuitProject(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:get', projectId);
  },

  applyCircuitCommand(projectId: string, command: unknown): Promise<unknown> {
    return ipcRenderer.invoke('project:apply-command', projectId, command);
  },

  compileCircuitProject(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:compile', projectId);
  },

  simulateCircuitProject(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:simulate', projectId);
  },

  compileCircuitModule(projectId: string, moduleId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:compile-module', projectId, moduleId);
  },

  saveCircuitModuleNotebook(projectId: string, moduleId: string, markdown: string): Promise<unknown> {
    return ipcRenderer.invoke('project:save-module-notebook', projectId, moduleId, markdown);
  },

  simulateCircuitModule(projectId: string, moduleId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:simulate-module', projectId, moduleId);
  },

  readCircuitBuild(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:read-build', projectId);
  },

  saveCircuitDesignTemplate(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:save-design-template', projectId);
  },

  saveCircuitDesignFlow(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:save-design-flow', projectId);
  },

  listCircuitDesignMemory(): Promise<unknown> {
    return ipcRenderer.invoke('project:list-design-memory');
  },

  watchCircuitProject(projectId: string): Promise<void> {
    return ipcRenderer.invoke('project:watch', projectId);
  },

  onCircuitProjectChanged(callback: (event: { projectId: string; timestamp: number }) => void): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { projectId: string; timestamp: number },
    ): void => callback(data);
    ipcRenderer.on('project:changed', handler);
    return () => ipcRenderer.removeListener('project:changed', handler);
  },

  openCircuitProjectFolder(projectId: string): void {
    ipcRenderer.send('project:open-folder', projectId);
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

  sendChatMessage(
    message: string,
    history?: Array<{ role: string; content: string }>,
    context?: { activeJobId?: string | null },
  ): Promise<ChatResponse> {
    return ipcRenderer.invoke('chat:send', message, history, context);
  },
};

export interface ChatResponse {
  text: string;
  isDesignRequest: boolean;
  formalizedRequirement?: string;
  isRevisionRequest?: boolean;
  revisionRequest?: string;
  targetStage?: string;
  isError?: boolean;
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export type ElectronAPI = typeof electronAPI;
