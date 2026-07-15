import { create } from 'zustand';
import type {
  ChatMessage,
  CircuitBuildState,
  CircuitProjectBundle,
  CircuitProjectSummary,
  ConversationSummary,
  ModuleManifest,
  ReferenceDocument,
  SimulationProbeRequest,
  StageState,
  ToolCallEntry,
  WorkspaceSummary,
} from '../types';

export type TabKey = 'design' | 'netlist' | 'svg' | 'simulation' | 'report';
export type ApprovalPolicy = 'manual' | 'execution' | 'all';
export type ThemeMode = 'dark' | 'light';

export interface SimulationMetric {
  name: string;
  target: string;
  measured: string;
  pass: boolean;
}

interface AppState {
  // UI
  activeTab: TabKey;
  chatOpen: boolean;
  sidebarCollapsed: boolean;
  stagePanelCollapsed: boolean;
  settingsOpen: boolean;
  setupWizardOpen: boolean;
  theme: ThemeMode;

  // Job
  activeJobId: string | null;
  activeProjectId: string | null;
  activeModuleId: string | null;
  activeWorkspace: WorkspaceSummary | null;
  workspaces: WorkspaceSummary[];
  referenceDocuments: ReferenceDocument[];
  circuitProjects: CircuitProjectSummary[];
  circuitProject: CircuitProjectBundle | null;
  circuitBuild: CircuitBuildState | null;
  circuitBusy: boolean;
  circuitError: string;

  // Workflow
  messages: ChatMessage[];
  stages: StageState[];
  toolCalls: ToolCallEntry[];
  isRunning: boolean;
  outputText: string;
  conversationId: string;

  // Conversations
  conversations: ConversationSummary[];
  conversationMessages: Record<string, ChatMessage[]>;

  // Content
  netlistContent: string;
  svgContent: string;
  reportContent: string;
  simulationData: SimulationMetric[] | null;
  simulationProbeRequest: SimulationProbeRequest | null;
  moduleManifest: ModuleManifest | null;

  // Settings
  approvalPolicy: ApprovalPolicy;

  // Actions
  setActiveTab: (tab: TabKey) => void;
  setChatOpen: (open: boolean) => void;
  toggleChatOpen: () => void;
  toggleSidebar: () => void;
  toggleStagePanel: () => void;
  setSettingsOpen: (open: boolean) => void;
  setSetupWizardOpen: (open: boolean) => void;
  setTheme: (theme: ThemeMode) => void;
  setActiveJobId: (id: string | null) => void;
  setActiveProjectId: (id: string | null) => void;
  setActiveModuleId: (id: string | null) => void;
  setActiveWorkspace: (workspace: WorkspaceSummary | null) => void;
  setWorkspaces: (workspaces: WorkspaceSummary[]) => void;
  setReferenceDocuments: (documents: ReferenceDocument[]) => void;
  setCircuitProjects: (projects: CircuitProjectSummary[]) => void;
  setCircuitProject: (project: CircuitProjectBundle | null) => void;
  setCircuitBuild: (build: CircuitBuildState | null) => void;
  setCircuitBusy: (busy: boolean) => void;
  setCircuitError: (error: string) => void;
  setApprovalPolicy: (policy: ApprovalPolicy) => void;
  setIsRunning: (running: boolean) => void;
  addMessage: (msg: ChatMessage) => void;
  clearMessages: () => void;
  setStages: (stages: StageState[]) => void;
  updateStage: (key: string, status: StageState['status']) => void;
  addToolCall: (tc: ToolCallEntry) => void;
  clearToolCalls: () => void;
  appendOutput: (text: string) => void;
  clearOutput: () => void;
  setNetlistContent: (content: string) => void;
  setSvgContent: (content: string) => void;
  setReportContent: (content: string) => void;
  setSimulationData: (data: SimulationMetric[] | null) => void;
  setSimulationProbeRequest: (request: SimulationProbeRequest | null) => void;
  setModuleManifest: (manifest: ModuleManifest | null) => void;
  resetWorkflow: (options?: { preserveMessages?: boolean }) => void;
  setConversationId: (id: string) => void;
  setConversationJobId: (jobId: string, conversationId?: string) => void;
  newConversation: () => string;
  upsertConversation: (conv: ConversationSummary) => void;
  setConversations: (convs: ConversationSummary[]) => void;
  renameConversation: (id: string, title: string) => void;
  deleteConversation: (id: string) => void;
  clearAllConversations: () => void;
  hydrateChatHistory: (snapshot: {
    conversationId: string;
    conversations: ConversationSummary[];
    conversationMessages: Record<string, ChatMessage[]>;
  }) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeTab: 'design',
  chatOpen: false,
  sidebarCollapsed: false,
  stagePanelCollapsed: true,
  settingsOpen: false,
  setupWizardOpen: false,
  theme: 'light',
  activeJobId: null,
  activeProjectId: null,
  activeModuleId: null,
  activeWorkspace: null,
  workspaces: [],
  referenceDocuments: [],
  circuitProjects: [],
  circuitProject: null,
  circuitBuild: null,
  circuitBusy: false,
  circuitError: '',
  messages: [],
  stages: [],
  toolCalls: [],
  isRunning: false,
  outputText: '',
  conversationId: '',
  conversations: [],
  conversationMessages: {},
  netlistContent: '',
  svgContent: '',
  reportContent: '',
  simulationData: null,
  simulationProbeRequest: null,
  moduleManifest: null,
  approvalPolicy: 'execution',

  setActiveTab: (tab) => set({ activeTab: tab }),
  setChatOpen: (open) => set({ chatOpen: open }),
  toggleChatOpen: () => set((s) => ({ chatOpen: !s.chatOpen })),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleStagePanel: () => set((s) => ({ stagePanelCollapsed: !s.stagePanelCollapsed })),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setSetupWizardOpen: (open) => set({ setupWizardOpen: open }),
  setTheme: (theme) => set({ theme }),
  setActiveJobId: (id) => set({ activeJobId: id }),
  setActiveProjectId: (id) => set({ activeProjectId: id }),
  setActiveModuleId: (id) => set({ activeModuleId: id }),
  setActiveWorkspace: (workspace) => set({ activeWorkspace: workspace }),
  setWorkspaces: (workspaces) => set({ workspaces }),
  setReferenceDocuments: (documents) => set({ referenceDocuments: documents }),
  setCircuitProjects: (projects) => set({ circuitProjects: projects }),
  setCircuitProject: (project) => set({ circuitProject: project }),
  setCircuitBuild: (build) => set({ circuitBuild: build }),
  setCircuitBusy: (busy) => set({ circuitBusy: busy }),
  setCircuitError: (error) => set({ circuitError: error }),
  setApprovalPolicy: (policy) => set({ approvalPolicy: policy }),
  setIsRunning: (running) => set({ isRunning: running }),
  addMessage: (msg) =>
    set((s) => {
      const conversationId = msg.conversationId ?? s.conversationId;
      const message = conversationId ? { ...msg, conversationId } : msg;
      const messages = !conversationId || conversationId === s.conversationId
        ? [...s.messages, message]
        : s.messages;
      if (!conversationId) {
        return { messages };
      }

      const savedMessages = [...(s.conversationMessages[conversationId] ?? []), message];
      const existing = s.conversations.find((conv) => conv.id === conversationId);
      const autoTitle = savedMessages.find((entry) => entry.role === 'user')?.content
        || existing?.title
        || 'New conversation';
      const summary: ConversationSummary = {
        id: conversationId,
        title: (existing?.titleLocked ? existing.title : autoTitle).slice(0, 50),
        lastMessage: message.content,
        messageCount: savedMessages.length,
        updatedAt: message.timestamp,
        jobId: existing?.jobId,
        titleLocked: existing?.titleLocked,
      };

      return {
        messages,
        conversationMessages: {
          ...s.conversationMessages,
          [conversationId]: savedMessages,
        },
        conversations: [
          summary,
          ...s.conversations.filter((conv) => conv.id !== conversationId),
        ].slice(0, 50),
      };
    }),
  clearMessages: () => set({ messages: [] }),
  setStages: (stages) => set({ stages }),
  updateStage: (key, status) =>
    set((s) => ({
      stages: s.stages.map((st) => (st.key === key ? { ...st, status } : st)),
    })),
  addToolCall: (tc) =>
    set((s) => ({ toolCalls: [tc, ...s.toolCalls].slice(0, 50) })),
  clearToolCalls: () => set({ toolCalls: [] }),
  appendOutput: (text) => set((s) => ({ outputText: s.outputText + text })),
  clearOutput: () => set({ outputText: '' }),
  setNetlistContent: (content) => set({ netlistContent: content }),
  setSvgContent: (content) => set({ svgContent: content }),
  setReportContent: (content) => set({ reportContent: content }),
  setSimulationData: (data) => set({ simulationData: data }),
  setSimulationProbeRequest: (request) => set({ simulationProbeRequest: request }),
  setModuleManifest: (manifest) => set({ moduleManifest: manifest }),
  resetWorkflow: (options) =>
    set({
      outputText: '',
      toolCalls: [],
      netlistContent: '',
      svgContent: '',
      reportContent: '',
      simulationData: null,
      simulationProbeRequest: null,
      moduleManifest: null,
      ...(options?.preserveMessages ? {} : { messages: [] }),
      stages: [],
    }),
  setConversationId: (id) =>
    set((s) => ({
      conversationId: id,
      messages: s.conversationMessages[id] ?? [],
    })),
  setConversationJobId: (jobId, conversationId) =>
    set((s) => {
      const targetId = conversationId ?? s.conversationId;
      if (!targetId) {
        return {};
      }
      return {
        conversations: s.conversations.map((conv) =>
          conv.id === targetId ? { ...conv, jobId } : conv,
        ),
      };
    }),
  newConversation: () => {
    const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set({ conversationId: id, messages: [] });
    return id;
  },
  upsertConversation: (conv) =>
    set((s) => ({
      conversations: [
        {
          ...s.conversations.find((existing) => existing.id === conv.id),
          ...conv,
        },
        ...s.conversations.filter((c) => c.id !== conv.id),
      ].slice(0, 50),
    })),
  setConversations: (convs) => set({ conversations: convs }),
  renameConversation: (id, title) =>
    set((s) => {
      const nextTitle = title.trim().slice(0, 80);
      if (!nextTitle) return {};
      return {
        conversations: s.conversations.map((conv) => (
          conv.id === id
            ? { ...conv, title: nextTitle, titleLocked: true, updatedAt: Date.now() }
            : conv
        )),
      };
    }),
  deleteConversation: (id) =>
    set((s) => {
      const conversations = s.conversations.filter((conv) => conv.id !== id);
      const { [id]: _removed, ...conversationMessages } = s.conversationMessages;
      if (s.conversationId !== id) {
        return { conversations, conversationMessages };
      }
      const next = conversations[0];
      return {
        conversations,
        conversationMessages,
        conversationId: next?.id ?? '',
        messages: next ? (conversationMessages[next.id] ?? []) : [],
      };
    }),
  clearAllConversations: () =>
    set({
      conversationId: '',
      messages: [],
      conversations: [],
      conversationMessages: {},
    }),
  hydrateChatHistory: (snapshot) =>
    set({
      conversationId: snapshot.conversationId,
      conversations: snapshot.conversations,
      conversationMessages: snapshot.conversationMessages,
      messages: snapshot.conversationId
        ? (snapshot.conversationMessages[snapshot.conversationId] ?? [])
        : [],
    }),
}));
