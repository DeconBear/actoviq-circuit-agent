import { create } from 'zustand';
import type {
  ChatMessage,
  ChatMessageTool,
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
import {
  conversationHasContent,
} from './chatHistoryPersistence';

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
  activeConversationByProject: Record<string, string>;

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
  patchMessage: (id: string, patch: Partial<ChatMessage> | ((msg: ChatMessage) => Partial<ChatMessage>)) => void;
  upsertMessageTool: (messageId: string, tool: ChatMessageTool) => void;
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
  newConversation: (projectId?: string | null) => string;
  upsertConversation: (conv: ConversationSummary) => void;
  setConversations: (convs: ConversationSummary[]) => void;
  renameConversation: (id: string, title: string) => void;
  deleteConversation: (id: string) => void;
  clearAllConversations: () => void;
  clearConversationsForProject: (projectId: string | null) => void;
  /** Attach an existing conversation to a project without switching the active thread. */
  bindConversationToProject: (conversationId: string, projectId: string) => void;
  switchProjectChatContext: (projectId: string | null) => string;
  hydrateChatHistory: (snapshot: {
    conversationId: string;
    conversations: ConversationSummary[];
    conversationMessages: Record<string, ChatMessage[]>;
    activeConversationByProject?: Record<string, string>;
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
  activeConversationByProject: {},
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
      if (!conversationId) {
        return { messages: [...s.messages, message] };
      }

      // Prefer the longer of live vs stored history so a wiped `messages` array
      // cannot truncate conversationMessages (and the visible transcript) to the
      // latest turn only on the next append.
      const stored = s.conversationMessages[conversationId] ?? [];
      const live = conversationId === s.conversationId ? s.messages : [];
      const prior = stored.length >= live.length ? stored : live;
      const savedMessages = [...prior, message];
      const messages = conversationId === s.conversationId ? savedMessages : s.messages;
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
        projectId: existing?.projectId ?? s.activeProjectId ?? null,
      };

      const activeConversationByProject = { ...s.activeConversationByProject };
      if (summary.projectId) {
        activeConversationByProject[summary.projectId] = conversationId;
      }

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
        activeConversationByProject,
      };
    }),
  patchMessage: (id, patch) =>
    set((s) => {
      const apply = (msg: ChatMessage): ChatMessage => {
        const nextPatch = typeof patch === 'function' ? patch(msg) : patch;
        return { ...msg, ...nextPatch };
      };
      const conversationMessages: Record<string, ChatMessage[]> = {};
      for (const [conversationId, entries] of Object.entries(s.conversationMessages)) {
        conversationMessages[conversationId] = entries.map((msg) => (msg.id === id ? apply(msg) : msg));
      }
      const messagesApplied = s.messages.map((msg) => (msg.id === id ? apply(msg) : msg));
      const activeId = s.conversationId;
      const canonical = activeId ? conversationMessages[activeId] : undefined;
      const messages = canonical && canonical.length >= messagesApplied.length
        ? canonical
        : messagesApplied;
      return { messages, conversationMessages };
    }),
  upsertMessageTool: (messageId, tool) =>
    set((s) => {
      const apply = (msg: ChatMessage): ChatMessage => {
        if (msg.id !== messageId) return msg;
        const tools = [
          ...(msg.tools ?? []).filter((entry) => entry.id !== tool.id),
          tool,
        ];
        return { ...msg, tools };
      };
      const conversationMessages: Record<string, ChatMessage[]> = {};
      for (const [conversationId, entries] of Object.entries(s.conversationMessages)) {
        conversationMessages[conversationId] = entries.map(apply);
      }
      const messagesApplied = s.messages.map(apply);
      const activeId = s.conversationId;
      const canonical = activeId ? conversationMessages[activeId] : undefined;
      const messages = canonical && canonical.length >= messagesApplied.length
        ? canonical
        : messagesApplied;
      return { messages, conversationMessages };
    }),
  clearMessages: () =>
    set((s) => {
      const conversationId = s.conversationId;
      if (!conversationId) return { messages: [] };
      return {
        messages: [],
        conversationMessages: {
          ...s.conversationMessages,
          [conversationId]: [],
        },
      };
    }),
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
    set((s) => {
      const conv = s.conversations.find((entry) => entry.id === id);
      const activeConversationByProject = { ...s.activeConversationByProject };
      let conversations = s.conversations;
      let claimedProjectId = conv?.projectId ?? null;
      // Opening an unscoped legacy chat while a project is active claims it for that project.
      if (conv && conv.projectId == null && s.activeProjectId) {
        claimedProjectId = s.activeProjectId;
        conversations = conversations.map((entry) => (
          entry.id === id ? { ...entry, projectId: s.activeProjectId } : entry
        ));
      }
      if (claimedProjectId) {
        activeConversationByProject[claimedProjectId] = id;
      }
      return {
        conversationId: id,
        messages: s.conversationMessages[id] ?? [],
        conversations,
        activeConversationByProject,
      };
    }),
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
  newConversation: (projectId) => {
    const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    let createdId = id;
    set((s) => {
      const scopedProjectId = projectId === undefined ? (s.activeProjectId ?? null) : projectId;
      const summary: ConversationSummary = {
        id,
        title: 'New conversation',
        lastMessage: '',
        messageCount: 0,
        updatedAt: now,
        titleLocked: false,
        projectId: scopedProjectId,
      };
      const activeConversationByProject = { ...s.activeConversationByProject };
      if (scopedProjectId) {
        activeConversationByProject[scopedProjectId] = id;
      }
      createdId = id;
      return {
        conversationId: id,
        messages: [],
        conversations: [summary, ...s.conversations.filter((conv) => conv.id !== id)].slice(0, 50),
        conversationMessages: { ...s.conversationMessages, [id]: [] },
        activeConversationByProject,
      };
    });
    return createdId;
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
      const activeConversationByProject = Object.fromEntries(
        Object.entries(s.activeConversationByProject).filter(([, conversationId]) => conversationId !== id),
      );
      const sameScope = (entry: ConversationSummary) => {
        const deleted = s.conversations.find((conv) => conv.id === id);
        if (!deleted) return true;
        return (entry.projectId ?? null) === (deleted.projectId ?? null);
      };
      if (s.conversationId !== id) {
        return { conversations, conversationMessages, activeConversationByProject };
      }
      const next = conversations.find(sameScope) ?? conversations[0];
      return {
        conversations,
        conversationMessages,
        activeConversationByProject,
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
      activeConversationByProject: {},
    }),
  bindConversationToProject: (conversationId, projectId) =>
    set((s) => {
      if (!conversationId || !projectId) return s;
      const conversations = s.conversations.map((entry) => (
        entry.id === conversationId ? { ...entry, projectId } : entry
      ));
      return {
        conversations,
        activeConversationByProject: {
          ...s.activeConversationByProject,
          [projectId]: conversationId,
        },
      };
    }),
  clearConversationsForProject: (projectId) =>
    set((s) => {
      const keep = s.conversations.filter((entry) => (entry.projectId ?? null) !== (projectId ?? null));
      const removeIds = new Set(
        s.conversations
          .filter((entry) => (entry.projectId ?? null) === (projectId ?? null))
          .map((entry) => entry.id),
      );
      const conversationMessages = { ...s.conversationMessages };
      for (const id of removeIds) {
        delete conversationMessages[id];
      }
      const activeConversationByProject = { ...s.activeConversationByProject };
      if (projectId) {
        delete activeConversationByProject[projectId];
      }
      const stillActive = s.conversationId && !removeIds.has(s.conversationId);
      if (stillActive) {
        return { conversations: keep, conversationMessages, activeConversationByProject };
      }
      return {
        conversations: keep,
        conversationMessages,
        activeConversationByProject,
        conversationId: '',
        messages: [],
      };
    }),
  switchProjectChatContext: (projectId) => {
    let nextId = '';
    set((s) => {
      const scoped = s.conversations.filter((entry) => (entry.projectId ?? null) === (projectId ?? null));
      const withContent = scoped.filter((entry) => conversationHasContent(entry, s.conversationMessages));
      const remembered = projectId ? s.activeConversationByProject[projectId] : undefined;
      const rememberedEntry = remembered
        ? scoped.find((entry) => entry.id === remembered)
        : undefined;
      const rememberedOk = Boolean(
        rememberedEntry && conversationHasContent(rememberedEntry, s.conversationMessages),
      );

      let pickId = rememberedOk ? remembered : withContent[0]?.id;
      let conversations = s.conversations;

      // Restore unscoped legacy history instead of opening a blank thread.
      if (!pickId && projectId) {
        const legacy = s.conversations
          .filter((entry) => entry.projectId == null && conversationHasContent(entry, s.conversationMessages))
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (legacy) {
          pickId = legacy.id;
          conversations = conversations.map((entry) => (
            entry.id === legacy.id ? { ...entry, projectId } : entry
          ));
        }
      }

      if (pickId) {
        nextId = pickId;
        const activeConversationByProject = { ...s.activeConversationByProject };
        if (projectId) {
          activeConversationByProject[projectId] = pickId;
        }
        return {
          conversations,
          conversationId: pickId,
          messages: s.conversationMessages[pickId] ?? [],
          activeConversationByProject,
        };
      }

      const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();
      const summary: ConversationSummary = {
        id,
        title: 'New conversation',
        lastMessage: '',
        messageCount: 0,
        updatedAt: now,
        titleLocked: false,
        projectId: projectId ?? null,
      };
      const activeConversationByProject = { ...s.activeConversationByProject };
      if (projectId) {
        activeConversationByProject[projectId] = id;
      }
      nextId = id;
      return {
        conversationId: id,
        messages: [],
        conversations: [summary, ...conversations].slice(0, 50),
        conversationMessages: { ...s.conversationMessages, [id]: [] },
        activeConversationByProject,
      };
    });
    return nextId;
  },
  hydrateChatHistory: (snapshot) =>
    set({
      conversationId: snapshot.conversationId,
      conversations: snapshot.conversations,
      conversationMessages: snapshot.conversationMessages,
      activeConversationByProject: snapshot.activeConversationByProject ?? {},
      messages: snapshot.conversationId
        ? (snapshot.conversationMessages[snapshot.conversationId] ?? [])
        : [],
    }),
}));
