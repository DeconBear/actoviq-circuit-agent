import type {
  AppSettings,
  ChatResponse,
  JobSummary,
  ReferenceDocument,
  CircuitBuildState,
  CircuitCommand,
  CircuitProjectBundle,
  CircuitProjectSummary,
  DesignMemoryItem,
  SavedDesignMemorySummary,
  WorkflowEvent,
  WorkspaceSummary,
} from './types';

export {};

declare global {
  interface Window {
    electronAPI: {
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
      openWorkspaceRoot(): void;
      openWorkspaceReferences(): void;
      listReferenceDocuments(): Promise<ReferenceDocument[]>;
      runReferenceOcr(relativePath: string): Promise<{ textPath: string; text: string }>;
      listCircuitProjects(): Promise<CircuitProjectSummary[]>;
      createCircuitProject(input: { name: string; demo?: boolean }): Promise<CircuitProjectBundle>;
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
      saveCircuitModuleNotebook(projectId: string, moduleId: string, markdown: string): Promise<{
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
      watchCircuitProject(projectId: string): Promise<void>;
      onCircuitProjectChanged(
        callback: (event: { projectId: string; timestamp: number }) => void,
      ): () => void;
      openCircuitProjectFolder(projectId: string): void;
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
