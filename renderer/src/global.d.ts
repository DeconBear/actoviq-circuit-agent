import type {
  AppSettings,
  ProviderTestResult,
  DesktopAgentEvent,
  ChatResponse,
  JobSummary,
  ReferenceDocument,
  CircuitBuildState,
  CircuitAgentContext,
  CircuitCommand,
  CircuitErcResult,
  CircuitHistoryEntry,
  CircuitProjectBundle,
  CircuitProjectSummary,
  CircuitTrashItem,
  CircuitSkillStatus,
  DesignMemoryItem,
  EdaExportRequest,
  EdaExportResult,
  SavedDesignMemorySummary,
  SimulationDataset,
  SimulationRun,
  TechnicalReportResult,
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
        erc: CircuitErcResult;
      }>;
      runCircuitErc(projectId: string): Promise<CircuitErcResult & { ok: true }>;
      getCircuitAgentContext(projectId: string): Promise<CircuitAgentContext>;
      compileCircuitProject(projectId: string): Promise<{
        ok: true;
        revision: number;
        netlist_path: string;
      }>;
      exportCircuitEda(projectId: string, input: EdaExportRequest): Promise<EdaExportResult>;
      chooseCircuitEdaMapping(): Promise<string | null>;
      simulateCircuitProject(projectId: string): Promise<SimulationRun>;
      generateCircuitTechnicalReport(projectId: string, sourceRevision: number): Promise<TechnicalReportResult>;
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
      simulateCircuitModule(projectId: string, moduleId: string): Promise<SimulationRun & { module_id: string }>;
      readCircuitBuild(projectId: string): Promise<CircuitBuildState | null>;
      readCircuitSimulationDataset(projectId: string, input: {
        runId: string;
        analysisId: string;
        moduleId?: string;
        maxPoints?: number;
        xMin?: number;
        xMax?: number;
      }): Promise<SimulationDataset>;
      saveCircuitDesignTemplate(projectId: string): Promise<SavedDesignMemorySummary>;
      saveCircuitDesignFlow(projectId: string): Promise<SavedDesignMemorySummary>;
      listCircuitDesignMemory(): Promise<{ templates: DesignMemoryItem[]; flows: DesignMemoryItem[] }>;
      openCircuitDesignMemory(input: { kind: 'template' | 'flow'; id: string }): Promise<string>;
      watchCircuitProject(projectId: string): Promise<void>;
      onCircuitProjectChanged(
        callback: (event: { projectId: string; timestamp: number }) => void,
      ): () => void;
      openCircuitProjectFolder(projectId: string): Promise<string>;
      openCircuitEdaExportFolder(projectId: string, exportId: string): Promise<string>;
      getSettings(): Promise<AppSettings>;
      saveSettings(settings: AppSettings): Promise<AppSettings>;
      testProviderSettings(settings: AppSettings): Promise<ProviderTestResult>;
      getAppVersion(): Promise<string>;
      getCircuitSkillStatus(): Promise<CircuitSkillStatus>;
      syncCircuitSkill(): Promise<CircuitSkillStatus>;
      sendChatMessage(
        message: string,
        history?: Array<{ role: 'user' | 'assistant'; content: string }>,
        context?: {
          conversationId?: string;
          activeJobId?: string | null;
          activeProject?: Record<string, unknown> | null;
          workspaceRoot?: string;
        },
      ): Promise<ChatResponse>;
      stopChat(conversationId?: string): Promise<boolean>;
      onChatEvent(callback: (event: DesktopAgentEvent) => void): () => void;
    };
  }
}
