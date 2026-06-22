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
  isRevisionRequest?: boolean;
  revisionRequest?: string;
  targetStage?: string;
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

export interface ModuleManifest {
  version?: string;
  strategy: 'single_block' | 'partitioned';
  module_count: number;
  component_count: number;
  modules: Array<{
    order?: number;
    name: string;
    file: string;
    component_count: number;
  }>;
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

export type PortDirection = 'input' | 'output' | 'bidirectional';
export type SignalType = 'analog' | 'digital' | 'power' | 'ground';

export interface CircuitPort {
  id: string;
  name: string;
  direction: PortDirection;
  signal_type: SignalType;
  net: string;
  network?: string;
}

export interface CircuitPosition {
  x: number;
  y: number;
}

export interface CircuitModuleRef {
  id: string;
  name: string;
  kind: string;
  function?: string;
  parameters?: Record<string, string>;
  notes?: string;
  preview_enabled?: boolean;
  source: string;
  position: CircuitPosition;
  size: { width: number; height: number };
  ports: CircuitPort[];
}

export interface CircuitConnection {
  id: string;
  from: { module_id: string; port_id: string };
  to: { module_id: string; port_id: string };
  network?: string;
}

export interface CircuitProject {
  schema: 'actoviq.project.v1';
  project_id: string;
  name: string;
  revision: number;
  created_at: string;
  updated_at: string;
  modules: CircuitModuleRef[];
  connections: CircuitConnection[];
  analyses?: Record<string, unknown>;
}

export interface CircuitPin {
  id: string;
  name: string;
  net: string;
}

export interface CircuitComponent {
  id: string;
  type: 'R' | 'C' | 'L' | 'D' | 'Q' | 'M' | 'V' | 'I';
  name: string;
  value: string;
  position: CircuitPosition;
  rotation: number;
  pins: CircuitPin[];
}

export interface CircuitModule {
  schema: 'actoviq.module.v1';
  module_id: string;
  name: string;
  revision: number;
  ports: CircuitPort[];
  components: CircuitComponent[];
  wires: unknown[];
  annotations: unknown[];
}

export interface CircuitProjectSummary {
  projectId: string;
  name: string;
  revision: number;
  updatedAt: string;
  projectRoot: string;
  moduleCount: number;
}

export interface CircuitProjectBundle {
  ok: true;
  project: CircuitProject;
  modules: Record<string, CircuitModule>;
  module_previews: Record<string, {
    svg: string;
    svgPath: string;
    netlistPath: string;
    netlist: string;
    notebook: string;
    notebookPath: string;
    builtRevision?: number;
  }>;
  project_root: string;
}

export interface CircuitCommand {
  schema: 'actoviq.command.v1';
  command_id: string;
  actor: 'user' | 'claude-code' | 'codex' | string;
  project_id: string;
  base_revision: number;
  message: string;
  operations: Array<Record<string, unknown>>;
}

export interface CircuitBuildState {
  manifest: {
    schema: string;
    project_id: string;
    revision: number;
    built_at: string;
    status: string;
    netlist?: string;
  };
  simulation: {
    ok: boolean;
    metrics?: Array<{ name: string; value: number | null; unit: string; pass: boolean }>;
    stderr?: string;
  } | null;
  report?: string;
}

export interface SavedDesignMemorySummary {
  ok: true;
  id: string;
  kind: 'template' | 'flow';
  name: string;
  rootPath: string;
  relativePath: string;
  guidePath?: string;
  templatePath?: string;
  flowPath?: string;
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
