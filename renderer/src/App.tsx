import { useCallback, useEffect, useState } from 'react';
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

  // Listen for workflow events
  useEffect(() => {
    if (!window.electronAPI) return;

    const cleanup = window.electronAPI.onWorkflowEvent((event) => {
      switch (event.type) {
        case 'stage-list': {
          const list = (event.data as { stageList: StageDef[] }).stageList;
          store.setStages(list.map((s) => ({ key: s.key, name: s.name, status: 'waiting' as const })));
          break;
        }
        case 'stage-start': {
          store.updateStage(event.stageKey!, 'running');
          store.setIsRunning(true);
          store.addMessage({
            id: `stage-${event.stageKey}-${Date.now()}`,
            role: 'system',
            content: `Starting: ${event.stageName}`,
            timestamp: event.timestamp,
          });
          break;
        }
        case 'stage-complete': {
          store.updateStage(event.stageKey!, 'done');
          const output = (event.data as { output: string } | undefined)?.output ?? '';
          if (output) store.appendOutput(output);
          break;
        }
        case 'stage-error': {
          store.updateStage(event.stageKey!, 'error');
          const errMsg = (event.data as { error: string } | undefined)?.error ?? 'Unknown error';
          store.addMessage({
            id: `error-${Date.now()}`,
            role: 'system',
            content: `Error in ${event.stageName}: ${errMsg}`,
            timestamp: event.timestamp,
            isError: true,
          });
          break;
        }
        case 'output': {
          const text = (event.data as { text: string }).text;
          store.appendOutput(text);
          break;
        }
        case 'tool-call': {
          const data = event.data as { tool?: string; stageKey?: string };
          if (data?.tool) {
            store.addToolCall({ tool: data.tool!, stageKey: data.stageKey ?? '', timestamp: event.timestamp });
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
          store.addMessage({
            id: `confirm-skip-${Date.now()}`,
            role: 'system',
            content: `Skipped stage transition: ${cjData?.currentStage ?? ''} → ${cjData?.nextStage ?? ''}`,
            timestamp: event.timestamp,
          });
          break;
        }
        case 'workflow-complete': {
          store.setIsRunning(false);
          const exitCode = (event.data as { exitCode?: number; stopped?: boolean } | undefined);
          if (exitCode?.stopped) {
            store.addMessage({
              id: `stopped-${Date.now()}`,
              role: 'system',
              content: 'Workflow stopped by user.',
              timestamp: event.timestamp,
            });
          } else if (exitCode?.exitCode !== 0 && store.stages.length === 0) {
            store.addMessage({
              id: `config-error-${Date.now()}`,
              role: 'system',
              content: 'Workflow failed to start. Please check your API and ngspice configuration in Settings (⚙). If this is your first time, run the Setup Wizard.',
              timestamp: event.timestamp,
              isError: true,
            });
            store.setSettingsOpen(true);
          } else {
            store.setStages(store.stages.map((s) => ({
              ...s,
              status: s.status === 'running' ? 'done' : s.status,
            })));
            store.addMessage({
              id: `complete-${Date.now()}`,
              role: 'system',
              content: exitCode?.exitCode === 0 ? 'Workflow complete.' : `Workflow exited with code ${exitCode?.exitCode}.`,
              timestamp: event.timestamp,
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

  // Refresh job artifacts when a job is selected
  const refreshJobArtifacts = useCallback(async (jobId: string) => {
    store.setActiveJobId(jobId);
    try {
      const netlist = await window.electronAPI.readJobFile(jobId, 'design/design.final.cir');
      store.setNetlistContent(netlist || '');
    } catch { store.setNetlistContent(''); }
    try {
      const svg = await window.electronAPI.readJobFile(jobId, 'render/netlistsvg.svg');
      store.setSvgContent(svg || '');
    } catch { store.setSvgContent(''); }
    try {
      const report = await window.electronAPI.readJobFile(jobId, 'reports/final-summary.md');
      store.setReportContent(report || '');
    } catch { store.setReportContent(''); }
  }, []);

  // "New Design" — reset and go to chat
  const handleNewDesign = useCallback(() => {
    store.resetWorkflow();
    store.setActiveJobId(null);
    store.setActiveTab('chat');
  }, []);

  // Send a chat message — first checks intent, then decides chat vs workflow
  const handleSendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Add user message to chat
    store.addMessage({
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    });

    // If workflow is already running, no intent check needed
    if (store.isRunning) {
      return;
    }

    // Otherwise, ask the LLM to screen the message
    if (!window.electronAPI) {
      store.addMessage({
        id: `error-${Date.now()}`,
        role: 'system',
        content: 'Cannot connect to backend.',
        timestamp: Date.now(),
        isError: true,
      });
      return;
    }

    try {
      const result = await window.electronAPI.sendChatMessage(trimmed);

      // Show the agent's chat response
      store.addMessage({
        id: `agent-${Date.now()}`,
        role: 'system',
        content: result.text,
        timestamp: Date.now(),
      });

      // If it's a design request, trigger the workflow
      if (result.isDesignRequest) {
        const requirement = result.formalizedRequirement || trimmed;
        store.setIsRunning(true);
        store.setWelcomeOpen(false);
        store.setActiveTab('chat');

        window.electronAPI.startWorkflow({
          requirement,
          approvalPolicy: store.approvalPolicy,
          jobName: undefined,
        });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      store.addMessage({
        id: `error-${Date.now()}`,
        role: 'system',
        content: `Chat error: ${errorMessage}`,
        timestamp: Date.now(),
        isError: true,
      });
    }
  }, [store.approvalPolicy, store.isRunning]);

  return (
    <ErrorBoundary>
      <div style={styles.appShell} className={`theme-${store.theme}`}>
        <Sidebar
          collapsed={store.sidebarCollapsed}
          onToggle={store.toggleSidebar}
          activeJobId={store.activeJobId}
          onSelectJob={refreshJobArtifacts}
          onNewDesign={handleNewDesign}
        />

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
              <select
                value={store.approvalPolicy}
                onChange={(e) => store.setApprovalPolicy(e.target.value as typeof store.approvalPolicy)}
                style={styles.policySelect}
              >
                <option value="manual">Manual</option>
                <option value="execution">Execution</option>
                <option value="all">All Auto</option>
              </select>
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
              <ChatView onSend={handleSendMessage} />
            )}
            {store.activeTab === 'netlist' && <NetlistEditor />}
            {store.activeTab === 'svg' && <SvgViewer />}
            {store.activeTab === 'simulation' && <SimulationTab />}
            {store.activeTab === 'report' && <ReportPreview />}
          </div>
        </div>

        <StagePanel
          collapsed={store.stagePanelCollapsed}
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
};
