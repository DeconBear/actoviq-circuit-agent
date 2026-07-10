import type {
  AppSettings,
  ChatResponse,
  JobSummary,
  ReferenceDocument,
  CircuitBuildState,
  CircuitCommand,
  CircuitHistoryEntry,
  CircuitProjectBundle,
  CircuitProjectSummary,
  CircuitTrashItem,
  DesignMemoryItem,
  SavedDesignMemorySummary,
  WorkflowEvent,
  WorkspaceSummary,
} from './types';

export {};

declare global {
  interface Window {
    electronAPI: {
      isE2E(): boolean;
      startWorkflow(params: {
        requirement?: string;
        approvalPolicy: 'manual' | 'execution' | 'all';
        jobName?: string;
        configPath?: string;
        revisionBaseJob?: string;
        resumeJob?: string;
        jobParentDir?: string;
        rerunFromStage?: string;
      }): void;
      pauseWorkflow(): void;
      resumeWorkflow(): void;
      stopWorkflow(): void;
      retryStage(): void;
      sendConfirmResponse(answer: 'y' | 'n'): void;
      onMenuAction(callback: (action:
        | 'new-design'
        | 'open-settings'
        | 'start-workflow'
        | 'pause-workflow'
        | 'resume-workflow'
        | 'validate-netlist'
        | 'run-simulation'
        | 'render-schematic'
      ) => void): () => void;
      onWorkflowEvent(callback: (event: WorkflowEvent) => void): () => void;
      readJobFile(jobId: string, relativePath: string): Promise<string>;
      writeJobFile(jobId: string, relativePath: string, content: string): Promise<void>;
      listJobs(): Promise<JobSummary[]>;
      openJobFolder(jobId: string): void;
      exportJob(jobId: string): Promise<string>;
      listWorkspaces(): Promise<WorkspaceSummary[]>;
      getActiveWorkspace(): Promise<WorkspaceSummary>;
      createWorkspace(input: { name?: string; root?: string }): Promise<WorkspaceSummary>;
      selectWorkspace(id: string): Promise<WorkspaceSummary>;
      chooseWorkspaceRoot(): Promise<string | null>;
      openWorkspaceRoot(): Promise<string>;
      openWorkspaceReferences(): Promise<string>;
      listReferenceDocuments(): Promise<ReferenceDocument[]>;
      runReferenceOcr(relativePath: string): Promise<{ textPath: string; text: string }>;
      listCircuitProjects(): Promise<CircuitProjectSummary[]>;
      trashCircuitProjects(projectIds: string[]): Promise<CircuitTrashItem[]>;
      listCircuitTrash(): Promise<CircuitTrashItem[]>;
      restoreCircuitProjects(trashIds: string[]): Promise<CircuitProjectSummary[]>;
      purgeCircuitProjects(trashIds: string[]): Promise<void>;
      listCircuitProjectHistory(projectId: string): Promise<CircuitHistoryEntry[]>;
      restoreCircuitProjectRevision(projectId: string, revision: number, baseRevision: number): Promise<{
        ok: true;
        revision: number;
        changed_modules: string[];
      }>;
      createCircuitProject(input: { name: string; demo?: boolean }): Promise<CircuitProjectBundle>;
      createCircuitProjectFromTemplate(input: { templateId: string; name?: string }): Promise<CircuitProjectBundle>;
      getCircuitProject(projectId: string): Promise<CircuitProjectBundle>;
      applyCircuitCommand(projectId: string, command: CircuitCommand): Promise<{
        ok: true;
        revision: number;
        changed_modules: string[];
      }>;
      compileCircuitProject(projectId: string): Promise<{
        ok: true;
        revision: number;
        netlist_path: string;
      }>;
      simulateCircuitProject(projectId: string): Promise<{
        ok: boolean;
        metrics: Array<{ name: string; value: number | null; unit: string; pass: boolean }>;
        stderr?: string;
      }>;
      compileCircuitModule(projectId: string, moduleId: string): Promise<{
        ok: true;
        module_id: string;
        revision: number;
        netlist_path: string;
        schematic_path: string;
        render: {
          ok: boolean;
          svg_path?: string;
          renderer?: string;
          error?: string;
        };
      }>;
      saveCircuitModuleNotebook(projectId: string, moduleId: string, markdown: string, baseRevision?: number): Promise<{
        ok: true;
        module_id: string;
        revision: number;
        netlist_path: string;
        schematic_path: string;
        render: {
          ok: boolean;
          svg_path?: string;
          renderer?: string;
          error?: string;
        };
      }>;
      simulateCircuitModule(projectId: string, moduleId: string): Promise<{
        ok: boolean;
        module_id: string;
        metrics: Array<{ name: string; value: number | null; unit: string; pass: boolean }>;
        stderr?: string;
      }>;
      readCircuitBuild(projectId: string): Promise<CircuitBuildState | null>;
      saveCircuitDesignTemplate(projectId: string): Promise<SavedDesignMemorySummary>;
      saveCircuitDesignFlow(projectId: string): Promise<SavedDesignMemorySummary>;
      listCircuitDesignMemory(): Promise<{ templates: DesignMemoryItem[]; flows: DesignMemoryItem[] }>;
      openCircuitDesignMemory(input: { kind: 'template' | 'flow'; id: string }): Promise<string>;
      watchCircuitProject(projectId: string): Promise<void>;
      onCircuitProjectChanged(
        callback: (event: { projectId: string; timestamp: number }) => void,
      ): () => void;
      openCircuitProjectFolder(projectId: string): Promise<string>;
      getSettings(): Promise<AppSettings>;
      saveSettings(settings: AppSettings): Promise<void>;
      getAppVersion(): Promise<string>;
      sendChatMessage(
        message: string,
        history?: Array<{ role: string; content: string }>,
        context?: { activeJobId?: string | null },
      ): Promise<ChatResponse>;
    };
  }
}
