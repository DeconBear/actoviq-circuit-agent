import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatView } from './components/chat/ChatView';
import { NetlistEditor } from './components/netlist/NetlistEditor';
import { SvgViewer } from './components/schematic/SvgViewer';
import { SimulationTab } from './components/simulation/SimulationTab';
import { ReportPreview } from './components/report/ReportPreview';
import { Sidebar } from './components/layout/Sidebar';
import { StagePanel } from './components/layout/StagePanel';
import { StageConfirmDialog } from './components/common/StageConfirmDialog';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { SetupWizard } from './components/settings/SetupWizard';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { useAppStore, type TabKey } from './store/appStore';
import type { StageDef } from './types';

const tabLabels: Record<TabKey, string> = {
  chat: 'Chat',
  netlist: 'Netlist',
  svg: 'SVG',
  simulation: 'Sim',
  report: 'Report',
};

export function App() {
  const store = useAppStore();
  const [confirmState, setConfirmState] = useState<{
    currentStage: string;
    nextStage: string;
  } | null>(null);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const currentJobIdRef = useRef<string | null>(null);
  const [isChatPending, setIsChatPending] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [stagePanelWidth, setStagePanelWidth] = useState(280);
  const resizing = useRef<'sidebar' | 'stage' | null>(null);
  const workflowConversationIdRef = useRef<string | null>(null);
  const setJobId = useCallback((id: string | null) => {
    setCurrentJobId(id);
    currentJobIdRef.current = id;
  }, []);

  // Retry file read with backoff — agent files may not be flushed to disk yet
  async function readFileWithRetry(jobId: string, relPath: string, maxRetries = 3): Promise<string | null> {
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 500 * i));
      try {
        const content = await window.electronAPI!.readJobFile(jobId, relPath);
        if (content) return content;
      } catch { /* retry */ }
    }
    return null;
  }

  // Listen for workflow events
  useEffect(() => {
    if (!window.electronAPI) return;

    const cleanup = window.electronAPI.onWorkflowEvent((event) => {
      const state = useAppStore.getState();
      const workflowConversationId = workflowConversationIdRef.current ?? state.conversationId;
      switch (event.type) {
        case 'stage-list': {
          const list = (event.data as { stageList: StageDef[] }).stageList;
          state.setStages(list.map((s) => ({ key: s.key, name: s.name, status: 'waiting' as const })));
          break;
        }
        case 'job-info': {
          const jiData = event.data as { jobId: string };
          if (jiData?.jobId) {
            setJobId(jiData.jobId);
            state.setActiveJobId(jiData.jobId);
            state.setConversationJobId(jiData.jobId, workflowConversationId);
          }
          break;
        }
        case 'stage-start': {
          state.updateStage(event.stageKey!, 'running');
          state.setIsRunning(true);
          state.addMessage({
            id: `stage-${event.stageKey}-${Date.now()}`,
            role: 'system',
            content: `Starting: ${event.stageName}`,
            timestamp: event.timestamp,
            conversationId: workflowConversationId,
          });
          break;
        }
        case 'stage-complete': {
          state.updateStage(event.stageKey!, 'done');
          // Auto-refresh relevant artifact for the completed stage
          const jid = currentJobIdRef.current;
          if (jid && window.electronAPI) {
            const key = event.stageKey;
            if (key === 'netlist-designer') {
              readFileWithRetry(jid, 'design/design.final.cir').then((c) => { if (c) useAppStore.getState().setNetlistContent(c); });
            } else if (key === 'netlistsvg-renderer') {
              readFileWithRetry(jid, 'render/netlistsvg.svg').then((c) => { if (c) useAppStore.getState().setSvgContent(c); });
            } else if (key === 'simulation-verifier') {
              readFileWithRetry(jid, 'verification/final-simulation/metrics.json').then((raw) => {
                if (raw) {
                  try {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) useAppStore.getState().setSimulationData(parsed);
                  } catch { useAppStore.getState().setSimulationData(null); }
                }
              });
            } else if (key === 'workflow-lead') {
              readFileWithRetry(jid, 'reports/final-summary.md').then((c) => { if (c) useAppStore.getState().setReportContent(c); });
            }
          }
          break;
        }
        case 'stage-error': {
          state.updateStage(event.stageKey!, 'error');
          const errMsg = (event.data as { error: string } | undefined)?.error ?? 'Unknown error';
          state.addMessage({
            id: `error-${Date.now()}`,
            role: 'system',
            content: `Error in ${event.stageName}: ${errMsg}`,
            timestamp: event.timestamp,
            isError: true,
            conversationId: workflowConversationId,
          });
          break;
        }
        case 'output': {
          const text = (event.data as { text: string }).text;
          state.appendOutput(text);
          break;
        }
        case 'tool-call': {
          const data = event.data as { tool?: string; stageKey?: string };
          if (data?.tool) {
            state.addToolCall({ tool: data.tool!, stageKey: data.stageKey ?? '', timestamp: event.timestamp });
          }
          break;
        }
        case 'confirm-request': {
          const crData = event.data as { currentStage: string; nextStage: string };
          if (crData?.currentStage && crData?.nextStage) {
            setConfirmState({ currentStage: crData.currentStage, nextStage: crData.nextStage });
          }
          break;
        }
        case 'confirm-rejected': {
          const cjData = event.data as { currentStage: string; nextStage: string } | undefined;
          state.addMessage({
            id: `confirm-skip-${Date.now()}`,
            role: 'system',
            content: `Skipped stage transition: ${cjData?.currentStage ?? ''} → ${cjData?.nextStage ?? ''}`,
            timestamp: event.timestamp,
            conversationId: workflowConversationId,
          });
          break;
        }
        case 'workflow-complete': {
          state.setIsRunning(false);
          const exitCode = (event.data as { exitCode?: number; stopped?: boolean } | undefined);
          if (exitCode?.stopped) {
            state.setStages(state.stages.map((s) => ({
              ...s,
              status: s.status === 'running' ? 'error' : s.status,
            })));
            state.addMessage({
              id: `stopped-${Date.now()}`,
              role: 'system',
              content: 'Workflow stopped by user.',
              timestamp: event.timestamp,
              isError: true,
              conversationId: workflowConversationId,
            });
          } else if (exitCode?.exitCode !== 0 && state.stages.length === 0) {
            state.addMessage({
              id: `config-error-${Date.now()}`,
              role: 'system',
              content: 'Workflow failed to start. Please check your API and ngspice configuration in Settings (⚙). If this is your first time, run the Setup Wizard.',
              timestamp: event.timestamp,
              isError: true,
              conversationId: workflowConversationId,
            });
            state.setSettingsOpen(true);
          } else {
            const succeeded = exitCode?.exitCode === 0;
            state.setStages(state.stages.map((s) => ({
              ...s,
              status: s.status === 'running' ? (succeeded ? 'done' : 'error') : s.status,
            })));
            state.addMessage({
              id: `complete-${Date.now()}`,
              role: 'system',
              content: exitCode?.exitCode === 0 ? 'Workflow complete.' : `Workflow exited with code ${exitCode?.exitCode}.`,
              timestamp: event.timestamp,
              isError: !succeeded,
              conversationId: workflowConversationId,
            });
          }
          workflowConversationIdRef.current = null;
          // Refresh all artifacts after workflow ends
          if (currentJobIdRef.current && window.electronAPI) {
            const jid = currentJobIdRef.current;
            readFileWithRetry(jid, 'design/design.final.cir').then((c) => { if (c) useAppStore.getState().setNetlistContent(c); });
            readFileWithRetry(jid, 'render/netlistsvg.svg').then((c) => { if (c) useAppStore.getState().setSvgContent(c); });
            readFileWithRetry(jid, 'reports/final-summary.md').then((c) => { if (c) useAppStore.getState().setReportContent(c); });
            readFileWithRetry(jid, 'verification/final-simulation/metrics.json').then((raw) => {
              if (raw) {
                try {
                  const parsed = JSON.parse(raw);
                  if (Array.isArray(parsed)) useAppStore.getState().setSimulationData(parsed);
                } catch { useAppStore.getState().setSimulationData(null); }
              }
            });
          }
          break;
        }
      }
    });

    return cleanup;
  }, []);

  // Check if settings are configured on first mount — show wizard if no API token
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.getSettings().then((s) => {
      if (!s.actoviqAuthToken.trim()) {
        store.setSetupWizardOpen(true);
      }
    }).catch(() => {
      store.setSetupWizardOpen(true);
    });
  }, []);

  // Handle resize drag
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (resizing.current === 'sidebar') {
        setSidebarWidth(Math.max(160, Math.min(400, e.clientX)));
      } else if (resizing.current === 'stage') {
        setStagePanelWidth(Math.max(180, Math.min(500, window.innerWidth - e.clientX)));
      }
    };
    const handleMouseUp = () => {
      resizing.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Refresh job artifacts when a job is selected
  const refreshJobArtifacts = useCallback(async (jobId: string) => {
    const state = useAppStore.getState();
    state.setActiveJobId(jobId);
    setJobId(jobId);
    state.setNetlistContent('');
    state.setSvgContent('');
    state.setReportContent('');
    state.setSimulationData(null);
    try {
      const netlist = await window.electronAPI.readJobFile(jobId, 'design/design.final.cir');
      useAppStore.getState().setNetlistContent(netlist || '');
    } catch { useAppStore.getState().setNetlistContent(''); }
    try {
      const svg = await window.electronAPI.readJobFile(jobId, 'render/netlistsvg.svg');
      useAppStore.getState().setSvgContent(svg || '');
    } catch { useAppStore.getState().setSvgContent(''); }
    try {
      const report = await window.electronAPI.readJobFile(jobId, 'reports/final-summary.md');
      useAppStore.getState().setReportContent(report || '');
    } catch { useAppStore.getState().setReportContent(''); }
    try {
      const metricsRaw = await window.electronAPI.readJobFile(jobId, 'verification/final-simulation/metrics.json');
      if (metricsRaw) {
        const parsed = JSON.parse(metricsRaw);
        if (Array.isArray(parsed)) {
          useAppStore.getState().setSimulationData(parsed);
        } else {
          useAppStore.getState().setSimulationData(null);
        }
      } else {
        useAppStore.getState().setSimulationData(null);
      }
    } catch { useAppStore.getState().setSimulationData(null); }
  }, []);

  // "New Design" — reset and go to chat
  const handleNewDesign = useCallback(() => {
    const state = useAppStore.getState();
    state.resetWorkflow();
    state.setActiveJobId(null);
    state.newConversation();
    workflowConversationIdRef.current = null;
    setJobId(null);
    state.setActiveTab('chat');
  }, []);

  // Send a chat message — first checks intent, then decides chat vs workflow
  const handleSendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isChatPending) return;

    const state = useAppStore.getState();
    const workflowWasRunning = state.isRunning;

    // Auto-create conversation if none exists
    let cid = state.conversationId;
    if (!cid) {
      cid = state.newConversation();
    }

    // Add user message to chat
    state.addMessage({
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
      conversationId: cid,
    });

    if (!window.electronAPI) {
      useAppStore.getState().addMessage({
        id: `error-${Date.now()}`,
        role: 'system',
        content: 'Cannot connect to backend.',
        timestamp: Date.now(),
        isError: true,
        conversationId: cid,
      });
      return;
    }

    setIsChatPending(true);
    try {
      // Build conversation history for context
      const history = state.messages.map((m) => ({
        role: m.role === 'user' ? 'user' as const : 'assistant' as const,
        content: m.content,
      }));
      const result = await window.electronAPI.sendChatMessage(trimmed, history);

      // Show the agent's chat response
      useAppStore.getState().addMessage({
        id: `agent-${Date.now()}`,
        role: 'system',
        content: result.text,
        timestamp: Date.now(),
        isError: result.isError,
        conversationId: cid,
      });

      // If it's a design request, trigger the workflow
      if (result.isDesignRequest && workflowWasRunning) {
        useAppStore.getState().addMessage({
          id: `workflow-busy-${Date.now()}`,
          role: 'system',
          content: 'A design workflow is already running. I kept your note in this conversation and will not start a second workflow until the current one finishes.',
          timestamp: Date.now(),
          conversationId: cid,
        });
      } else if (result.isDesignRequest) {
        const requirement = result.formalizedRequirement || trimmed;
        const latest = useAppStore.getState();
        latest.resetWorkflow({ preserveMessages: true });
        latest.setIsRunning(true);
        latest.setActiveTab('chat');
        workflowConversationIdRef.current = cid;

        window.electronAPI.startWorkflow({
          requirement,
          approvalPolicy: latest.approvalPolicy,
          jobName: undefined,
        });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      useAppStore.getState().addMessage({
        id: `error-${Date.now()}`,
        role: 'system',
        content: `Chat error: ${errorMessage}`,
        timestamp: Date.now(),
        isError: true,
        conversationId: cid,
      });
    } finally {
      setIsChatPending(false);
    }
  }, [isChatPending]);

  return (
    <ErrorBoundary>
      <div style={styles.appShell} className={`theme-${store.theme}`}>
        <Sidebar
          collapsed={store.sidebarCollapsed}
          width={sidebarWidth}
          onToggle={store.toggleSidebar}
          activeJobId={store.activeJobId}
          onSelectJob={refreshJobArtifacts}
          onNewDesign={handleNewDesign}
        />

        {!store.sidebarCollapsed && (
          <div
            style={styles.dragHandle}
            onMouseDown={(e) => {
              e.preventDefault();
              resizing.current = 'sidebar';
              document.body.style.cursor = 'col-resize';
              document.body.style.userSelect = 'none';
            }}
          />
        )}

        <div style={styles.mainContent}>
          <div style={styles.tabBar}>
            {(Object.keys(tabLabels) as TabKey[]).map((tab) => (
              <button
                key={tab}
                onClick={() => store.setActiveTab(tab)}
                style={{
                  ...styles.tab,
                  ...(store.activeTab === tab ? styles.tabActive : {}),
                }}
              >
                {tabLabels[tab]}
              </button>
            ))}
            <div style={styles.tabBarRight}>
              {store.isRunning && (
                <button
                  onClick={() => {
                    window.electronAPI?.stopWorkflow();
                    store.setIsRunning(false);
                  }}
                  style={styles.stopBtn}
                  title="Stop workflow"
                >
                  ⏹ Stop
                </button>
              )}
              <select
                value={store.approvalPolicy}
                onChange={(e) => store.setApprovalPolicy(e.target.value as typeof store.approvalPolicy)}
                style={styles.policySelect}
                disabled={store.isRunning}
              >
                <option value="manual">Manual</option>
                <option value="execution">Execution</option>
                <option value="all">All Auto</option>
              </select>
              {currentJobId && (
                <button
                  onClick={() => window.electronAPI?.openJobFolder(currentJobId)}
                  style={styles.folderBtn}
                  title="Open working directory"
                >
                  📂
                </button>
              )}
              <button
                onClick={() => store.setSettingsOpen(true)}
                style={styles.settingsBtn}
                title="Settings"
              >
                ⚙
              </button>
            </div>
          </div>

          <div style={styles.tabContent}>
            {store.activeTab === 'chat' && (
              <ChatView onSend={handleSendMessage} isPending={isChatPending} />
            )}
            {store.activeTab === 'netlist' && <NetlistEditor />}
            {store.activeTab === 'svg' && <SvgViewer />}
            {store.activeTab === 'simulation' && <SimulationTab />}
            {store.activeTab === 'report' && <ReportPreview />}
          </div>
        </div>

        {!store.stagePanelCollapsed && (
          <div
            style={styles.dragHandle}
            onMouseDown={(e) => {
              e.preventDefault();
              resizing.current = 'stage';
              document.body.style.cursor = 'col-resize';
              document.body.style.userSelect = 'none';
            }}
          />
        )}

        <StagePanel
          collapsed={store.stagePanelCollapsed}
          width={stagePanelWidth}
          onToggle={store.toggleStagePanel}
        />

        {store.settingsOpen && (
          <SettingsDialog onClose={() => store.setSettingsOpen(false)} />
        )}

        {store.setupWizardOpen && (
          <SetupWizard onClose={() => store.setSetupWizardOpen(false)} />
        )}

        {confirmState && (
          <StageConfirmDialog
            currentStage={confirmState.currentStage}
            nextStage={confirmState.nextStage}
            onApprove={() => {
              window.electronAPI?.sendConfirmResponse('y');
              setConfirmState(null);
            }}
            onReject={() => {
              window.electronAPI?.sendConfirmResponse('n');
              setConfirmState(null);
            }}
          />
        )}
      </div>
    </ErrorBoundary>
  );
}

const styles: Record<string, React.CSSProperties> = {
  appShell: {
    display: 'flex',
    height: '100vh',
    width: '100vw',
    backgroundColor: '#1a1a2e',
    color: '#e0e0e0',
  },
  mainContent: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  tabBar: {
    display: 'flex',
    alignItems: 'center',
    height: 36,
    backgroundColor: '#16213e',
    borderBottom: '1px solid #0f3460',
    paddingLeft: 8,
    gap: 2,
  },
  tab: {
    padding: '6px 16px',
    border: 'none',
    background: 'transparent',
    color: '#a0a0b0',
    cursor: 'pointer',
    fontSize: 13,
    borderBottom: '2px solid transparent',
    transition: 'all 0.15s',
  },
  tabActive: {
    color: '#e94560',
    borderBottomColor: '#e94560',
  },
  tabBarRight: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    paddingRight: 8,
  },
  policySelect: {
    background: '#1a1a2e',
    color: '#e0e0e0',
    border: '1px solid #0f3460',
    borderRadius: 4,
    padding: '3px 8px',
    fontSize: 12,
  },
  stopBtn: {
    padding: '4px 12px',
    backgroundColor: '#e94560',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  folderBtn: {
    background: 'transparent',
    border: 'none',
    color: '#a0a0b0',
    cursor: 'pointer',
    fontSize: 14,
    padding: '2px 6px',
  },
  settingsBtn: {
    background: 'transparent',
    border: 'none',
    color: '#a0a0b0',
    cursor: 'pointer',
    fontSize: 16,
    padding: '2px 6px',
  },
  tabContent: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
  },
  dragHandle: {
    width: 4,
    cursor: 'col-resize',
    backgroundColor: '#0f3460',
    transition: 'background-color 0.15s',
    flexShrink: 0,
  },
};
