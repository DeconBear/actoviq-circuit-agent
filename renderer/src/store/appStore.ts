import { create } from 'zustand';
import type { ChatMessage, StageState, ToolCallEntry } from '../types';

export type TabKey = 'chat' | 'netlist' | 'svg' | 'simulation' | 'report';
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
  sidebarCollapsed: boolean;
  stagePanelCollapsed: boolean;
  settingsOpen: boolean;
  welcomeOpen: boolean;
  setupWizardOpen: boolean;
  theme: ThemeMode;

  // Job
  activeJobId: string | null;

  // Workflow
  messages: ChatMessage[];
  stages: StageState[];
  toolCalls: ToolCallEntry[];
  isRunning: boolean;
  outputText: string;

  // Content
  netlistContent: string;
  svgContent: string;
  reportContent: string;
  simulationData: SimulationMetric[] | null;

  // Settings
  approvalPolicy: ApprovalPolicy;

  // Actions
  setActiveTab: (tab: TabKey) => void;
  toggleSidebar: () => void;
  toggleStagePanel: () => void;
  setSettingsOpen: (open: boolean) => void;
  setWelcomeOpen: (open: boolean) => void;
  setSetupWizardOpen: (open: boolean) => void;
  setTheme: (theme: ThemeMode) => void;
  setActiveJobId: (id: string | null) => void;
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
  resetWorkflow: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeTab: 'chat',
  sidebarCollapsed: false,
  stagePanelCollapsed: false,
  settingsOpen: false,
  welcomeOpen: true,
  setupWizardOpen: false,
  theme: 'dark',
  activeJobId: null,
  messages: [],
  stages: [],
  toolCalls: [],
  isRunning: false,
  outputText: '',
  netlistContent: '',
  svgContent: '',
  reportContent: '',
  simulationData: null,
  approvalPolicy: 'execution',

  setActiveTab: (tab) => set({ activeTab: tab }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleStagePanel: () => set((s) => ({ stagePanelCollapsed: !s.stagePanelCollapsed })),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setWelcomeOpen: (open) => set({ welcomeOpen: open }),
  setSetupWizardOpen: (open) => set({ setupWizardOpen: open }),
  setTheme: (theme) => set({ theme }),
  setActiveJobId: (id) => set({ activeJobId: id }),
  setApprovalPolicy: (policy) => set({ approvalPolicy: policy }),
  setIsRunning: (running) => set({ isRunning: running }),
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
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
  resetWorkflow: () =>
    set({
      outputText: '',
      toolCalls: [],
      netlistContent: '',
      svgContent: '',
      reportContent: '',
      simulationData: null,
      messages: [],
      stages: [],
    }),
}));
