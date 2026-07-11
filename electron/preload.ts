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

export type MenuAction =
  | 'new-design'
  | 'open-settings'
  | 'start-workflow'
  | 'pause-workflow'
  | 'resume-workflow'
  | 'validate-netlist'
  | 'run-simulation'
  | 'render-schematic';

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
  isE2E(): boolean {
    return process.env.ACTOVIQ_E2E === '1';
  },

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

  onMenuAction(callback: (action: MenuAction) => void): () => void {
    const channels: Record<string, MenuAction> = {
      'menu:new-design': 'new-design',
      'menu:open-settings': 'open-settings',
      'menu:start-workflow': 'start-workflow',
      'menu:pause-workflow': 'pause-workflow',
      'menu:resume-workflow': 'resume-workflow',
      'menu:validate-netlist': 'validate-netlist',
      'menu:run-simulation': 'run-simulation',
      'menu:render-schematic': 'render-schematic',
    };
    const removers = Object.entries(channels).map(([channel, action]) => {
      const handler = (): void => callback(action);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    });
    return () => {
      removers.forEach((remove) => remove());
    };
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

  openWorkspaceRoot(): Promise<string> {
    return ipcRenderer.invoke('workspace:open-root');
  },

  openWorkspaceReferences(): Promise<string> {
    return ipcRenderer.invoke('workspace:open-references');
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

  trashCircuitProjects(projectIds: string[]): Promise<unknown[]> {
    return ipcRenderer.invoke('project:trash', projectIds);
  },

  listCircuitTrash(): Promise<unknown[]> {
    return ipcRenderer.invoke('project:list-trash');
  },

  restoreCircuitProjects(trashIds: string[]): Promise<unknown[]> {
    return ipcRenderer.invoke('project:restore-trash', trashIds);
  },

  purgeCircuitProjects(trashIds: string[]): Promise<void> {
    return ipcRenderer.invoke('project:purge-trash', trashIds);
  },

  listCircuitProjectHistory(projectId: string): Promise<unknown[]> {
    return ipcRenderer.invoke('project:list-history', projectId);
  },

  restoreCircuitProjectRevision(projectId: string, revision: number, baseRevision: number): Promise<unknown> {
    return ipcRenderer.invoke('project:restore-revision', projectId, revision, baseRevision);
  },

  createCircuitProject(input: { name: string; demo?: boolean }): Promise<unknown> {
    return ipcRenderer.invoke('project:create', input);
  },

  createCircuitProjectFromTemplate(input: { templateId: string; name?: string }): Promise<unknown> {
    return ipcRenderer.invoke('project:create-from-template', input);
  },

  getCircuitProject(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:get', projectId);
  },

  applyCircuitCommand(projectId: string, command: unknown): Promise<unknown> {
    return ipcRenderer.invoke('project:apply-command', projectId, command);
  },

  runCircuitErc(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:run-erc', projectId);
  },

  getCircuitAgentContext(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:agent-context', projectId);
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

  saveCircuitModuleNotebook(projectId: string, moduleId: string, markdown: string, baseRevision?: number): Promise<unknown> {
    return ipcRenderer.invoke('project:save-module-notebook', projectId, moduleId, markdown, baseRevision);
  },

  simulateCircuitModule(projectId: string, moduleId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:simulate-module', projectId, moduleId);
  },

  readCircuitBuild(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:read-build', projectId);
  },

  readCircuitSimulationDataset(projectId: string, input: {
    runId: string;
    analysisId: string;
    moduleId?: string;
    maxPoints?: number;
    xMin?: number;
    xMax?: number;
  }): Promise<unknown> {
    return ipcRenderer.invoke('project:read-simulation-dataset', projectId, input);
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

  openCircuitDesignMemory(input: { kind: 'template' | 'flow'; id: string }): Promise<string> {
    return ipcRenderer.invoke('project:open-design-memory', input);
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

  openCircuitProjectFolder(projectId: string): Promise<string> {
    return ipcRenderer.invoke('project:open-folder', projectId);
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

  getCircuitSkillStatus(): Promise<unknown> {
    return ipcRenderer.invoke('skill:circuit-status');
  },

  syncCircuitSkill(): Promise<unknown> {
    return ipcRenderer.invoke('skill:circuit-sync');
  },

  sendChatMessage(
    message: string,
    history?: Array<{ role: string; content: string }>,
    context?: { activeJobId?: string | null; activeProject?: Record<string, unknown> | null },
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
  projectName?: string;
  projectOperations?: Array<Record<string, unknown>>;
  compileAfterApply?: boolean;
  simulateAfterApply?: boolean;
  isError?: boolean;
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export type ElectronAPI = typeof electronAPI;
