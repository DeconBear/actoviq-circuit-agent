export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  isError?: boolean;
  conversationId?: string;
  runId?: string;
  sessionId?: string;
  model?: string;
  usage?: Record<string, unknown>;
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
  projectName?: string;
  projectOperations?: Array<Record<string, unknown>>;
  compileAfterApply?: boolean;
  simulateAfterApply?: boolean;
  isError?: boolean;
  runId?: string;
  sessionId?: string;
  model?: string;
  usage?: Record<string, unknown>;
}

export interface DesktopAgentEvent {
  type:
    | 'run-started'
    | 'status'
    | 'text-progress'
    | 'thinking-delta'
    | 'tool-call'
    | 'tool-result'
    | 'compacted'
    | 'model-fallback'
    | 'retry'
    | 'usage'
    | 'completed'
    | 'cancelled'
    | 'error';
  conversationId: string;
  sequence: number;
  timestamp: number;
  runId?: string;
  sessionId?: string;
  model?: string;
  text?: string;
  delta?: string;
  label?: string;
  iteration?: number;
  toolName?: string;
  toolUseId?: string;
  usage?: Record<string, unknown>;
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
  position?: CircuitPosition;
  net_id?: string;
  inferred?: boolean;
  network?: string;
}

export interface CircuitNet {
  id: string;
  name: string;
  kind?: SignalType | 'signal';
  aliases?: string[];
  conflict?: boolean;
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
  schema: 'actoviq.project.v1' | 'actoviq.project.v2';
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
  net_id?: string;
  side?: 'left' | 'right' | 'top' | 'bottom';
  order?: number;
}

export interface CircuitBlockStyle {
  width?: number;
  height?: number;
}

export interface CircuitSpiceSource {
  models?: string[];
  directives?: string[];
  opaque?: string[];
  source?: string;
  generated_testbench?: boolean;
}

export interface CircuitWireEndpoint {
  x: number;
  y: number;
  component_id?: string;
  pin_id?: string;
  port_id?: string;
}

export interface CircuitWire {
  id: string;
  points: CircuitPosition[];
  from?: CircuitWireEndpoint;
  to?: CircuitWireEndpoint;
  net?: string;
  net_id?: string;
  source?: 'stored' | 'net';
}

export interface CircuitComponent {
  id: string;
  type: 'R' | 'C' | 'L' | 'D' | 'Q' | 'M' | 'V' | 'I' | 'E' | 'BLOCK';
  name: string;
  value: string;
  position: CircuitPosition;
  rotation: number;
  pins: CircuitPin[];
  block?: CircuitBlockStyle;
  spice?: { raw?: string; simulated?: boolean };
}

export interface CircuitModule {
  schema: 'actoviq.module.v1' | 'actoviq.module.v2';
  module_id: string;
  name: string;
  revision: number;
  nets?: CircuitNet[];
  spice?: CircuitSpiceSource;
  ports: CircuitPort[];
  components: CircuitComponent[];
  wires: CircuitWire[];
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

export interface CircuitTrashItem extends CircuitProjectSummary {
  trashId: string;
  deletedAt: string;
  originalPath: string;
  trashPath: string;
}

export interface CircuitHistoryEntry {
  revision: number;
  baseRevision: number;
  actor: string;
  message: string;
  createdAt: string;
  documentHash?: string;
  restorable: boolean;
  buildStatus?: string;
  netlistDiff: { added: string[]; removed: string[] };
}

export interface CircuitErcDiagnostic {
  id: string;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  module_id?: string;
  component_id?: string;
  pin_id?: string;
  port_id?: string;
  net_id?: string;
  model?: string;
}

export interface CircuitErcResult {
  schema: 'actoviq.erc.v1';
  source_revision: number;
  document_hash: string;
  status: 'clean' | 'warning' | 'error';
  blocking: boolean;
  summary: { errors: number; warnings: number; infos: number };
  diagnostics: CircuitErcDiagnostic[];
  checked_at: string;
}

export interface SchematicOverrideItem {
  x: number;
  y: number;
  locked?: boolean;
}

export interface SchematicOverrides {
  schema: 'actoviq.schematic-overrides.v1';
  project_id: string;
  module_id: string;
  updated_at?: string;
  items: Record<string, SchematicOverrideItem>;
}

export interface CircuitProjectBundle {
  ok: true;
  project: CircuitProject;
  modules: Record<string, CircuitModule>;
  erc: CircuitErcResult;
  module_previews: Record<string, {
    svg: string;
    svgPath: string;
    netlistPath: string;
    netlist: string;
    notebook: string;
    notebookPath: string;
    builtRevision?: number;
    schematicOverrides?: SchematicOverrides;
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
    source_revision?: number;
    document_hash?: string;
    built_at: string;
    status: string;
    netlist?: string;
  };
  erc?: CircuitErcResult | null;
  simulation: SimulationRun | null;
  sourceMap?: {
    components?: Record<string, { module_id?: string; component_id?: string }>;
    nodes?: Record<string, { module_id?: string; local_net?: string }>;
  } | null;
  report?: string;
  technicalReport?: Record<string, unknown> | null;
}

export interface TechnicalReportResult {
  ok: true;
  report: string;
  metadata: {
    schema: 'actoviq.technical-report.v1';
    project_id: string;
    source_revision: number;
    document_hash?: string;
    generated_at: string;
    generator: 'actoviq-agent-sdk';
    model: string;
    run_id: string;
    report_sha256: string;
    usage?: Record<string, unknown>;
  };
}

export interface SimulationProbeRequest {
  id: number;
  projectId: string;
  moduleId: string;
  kind: 'voltage' | 'current';
  label: string;
  candidates: string[];
}

export interface SimulationRunMetric {
  name: string;
  value: number | null;
  unit: string;
  pass?: boolean;
  measurement_status?: 'measured' | 'failed';
  specification_status?: 'not_evaluated' | 'passed' | 'failed' | 'missing';
  specification?: { minimum: number | null; maximum: number | null; unit: string };
  source?: string;
}

export interface SimulationAnalysisSummary {
  id: string;
  type:
    | 'op'
    | 'dc'
    | 'ac'
    | 'tran'
    | 'sparameter'
    | 'noise'
    | 'pz'
    | 'fft'
    | 'parameter_sweep'
    | 'monte_carlo'
    | string;
  directive: string;
  status: 'completed' | 'failed' | 'configuration_error' | string;
  execution_status: string;
  measurement_status: string;
  specification_status: string;
  diagnostics?: string[];
  metrics?: SimulationRunMetric[];
  dataset?: {
    path: string;
    id: string;
    plotname: string;
    point_count: number;
    x_name: string;
    x_unit: string;
    traces: Array<{ name: string; unit: string; complex: boolean }>;
  } | null;
}

export interface SimulationRun {
  schema?: string;
  run_id?: string;
  scope?: string;
  source_revision?: number;
  document_hash?: string;
  ok: boolean;
  execution_status?: string;
  measurement_status?: string;
  specification_status?: string;
  verified?: boolean;
  specifications?: Array<{
    metric: string;
    minimum: number | null;
    maximum: number | null;
    unit: string;
    value: number | null;
    status: 'passed' | 'failed' | 'missing';
  }>;
  specification_diagnostics?: string[];
  analysis_count?: number;
  analyses?: SimulationAnalysisSummary[];
  metrics?: SimulationRunMetric[];
  stderr?: string;
  simulated_at?: string;
}

export interface CircuitAgentContext {
  ok: true;
  protocol_version: 'actoviq.project-agent.v2';
  project_id: string;
  project_root: string;
  workspace_root: string;
  base_revision: number;
  document_hash: string;
  project: CircuitProject;
  modules: Record<string, CircuitModule>;
  erc: CircuitErcResult;
  build: { state: 'current' | 'stale' | 'missing'; manifest: Record<string, unknown> | null };
  simulation: { state: 'current' | 'stale' | 'missing'; run: SimulationRun | null };
  next_action: 'fix_erc' | 'compile' | 'simulate' | 'evaluate_specifications' | 'ready';
  transaction: {
    schema: 'actoviq.command.v1';
    project_id: string;
    base_revision: number;
    allowed_operations: string[];
  };
}

export interface SimulationDatasetTrace {
  name: string;
  unit: string;
  real: number[];
  imag?: number[];
  magnitude?: number[];
  db?: number[];
  phase_deg?: number[];
}

export interface SimulationDataset {
  schema: string;
  id: string;
  analysis_id: string;
  analysis_type: string;
  plotname: string;
  point_count: number;
  total_point_count?: number;
  x: { name: string; unit: string; values: number[] };
  traces: SimulationDatasetTrace[];
}

export interface DesignMemoryItem {
  id: string;
  kind: 'template' | 'flow';
  name: string;
  rootPath: string;
  relativePath: string;
  sourceProjectId?: string;
  sourceRevision?: number;
  sourceDocumentHash?: string;
  createdAt?: string;
  circuitFamilies?: string[];
  validationStatus?: string;
  preferredForAgentReuse?: boolean;
  simulationCoverage?: string[];
  guidePath?: string;
  templatePath?: string;
  flowPath?: string;
}

export interface SavedDesignMemorySummary extends DesignMemoryItem {
  ok: true;
}

export type EdaExportTarget = 'kicad' | 'altium' | 'orcad' | 'virtuoso';

export interface EdaExportRequest {
  scope: 'project' | 'module';
  moduleId?: string;
  targets: EdaExportTarget[];
  view: 'design' | 'simulation';
  mappingFile?: string;
  nativeConvert: 'auto' | 'never' | 'required';
  strictLayout: boolean;
  sourceRevision: number;
}

export interface EdaExportResult {
  ok: true;
  export_id: string;
  export_root: string;
  layout_quality: {
    readability_score: number;
    lexicographic_cost: number[];
  };
  targets: Partial<Record<EdaExportTarget, {
    status: 'native' | 'import_ready' | 'warning' | 'failed';
    connectivity_hash: string;
    files: string[];
  }>>;
}

export interface ReferenceDocument {
  name: string;
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  updatedAt: string;
  ocrTextPath?: string;
}

export type ActoviqProvider = 'anthropic' | 'openai';
export type ActoviqProviderPreset = 'anthropic' | 'deepseek' | 'openai-compatible';
export type SecretStorageMode = 'encrypted' | 'plaintext-fallback' | 'environment' | 'none';

export interface AppSettings {
  actoviqProvider: ActoviqProvider;
  actoviqProviderPreset: ActoviqProviderPreset;
  actoviqBaseUrl: string;
  /** New API key input only; saved values are never returned to the renderer. */
  actoviqAuthToken: string;
  hasActoviqAuthToken: boolean;
  maskedActoviqAuthToken: string;
  clearActoviqAuthToken?: boolean;
  actoviqAuthTokenStorage: SecretStorageMode;
  chatModel: string;
  reasoningModel: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  ngspiceBin: string;
  workspaceRoot: string;
  yunzhishengOcrBaseUrl: string;
  yunzhishengOcrApiKey: string;
  yunzhishengOcrModel: string;
}

export interface ProviderTestResult {
  ok: boolean;
  provider: ActoviqProvider;
  model: string;
  latencyMs: number;
  error?: string;
}

export interface CircuitSkillStatus {
  sourcePath: string;
  sourceVersion: string;
  protocolVersion: string;
  current: boolean;
  targets: Array<{
    agent: 'codex' | 'claude';
    path: string;
    effectivePath: string;
    status: 'current' | 'outdated' | 'missing';
    installedVersion?: string;
  }>;
}
