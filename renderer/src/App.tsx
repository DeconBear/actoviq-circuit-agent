import { useCallback, useEffect, useState } from 'react';
import { ChatView } from './components/chat/ChatView';
import { NetlistEditor } from './components/netlist/NetlistEditor';
import { SvgViewer } from './components/schematic/SvgViewer';
import { SimulationTab } from './components/simulation/SimulationTab';
import { ReportPreview } from './components/report/ReportPreview';
import { Sidebar } from './components/layout/Sidebar';
import { StagePanel } from './components/layout/StagePanel';
import { WelcomeScreen } from './components/common/WelcomeScreen';
import { SettingsDialog } from './components/settings/SettingsDialog';
import type { ChatMessage, StageState, ToolCallEntry } from './types';

type TabKey = 'chat' | 'netlist' | 'svg' | 'simulation' | 'report';

export function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('chat');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [stagePanelCollapsed, setStagePanelCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(true);

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [stages, setStages] = useState<StageState[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [outputText, setOutputText] = useState('');
  const [netlistContent, setNetlistContent] = useState('');
  const [svgContent, setSvgContent] = useState('');
  const [reportContent, setReportContent] = useState('');
  const [approvalPolicy, setApprovalPolicy] = useState<'manual' | 'execution' | 'all'>('execution');
  const [simulationData, setSimulationData] = useState<{
    metrics: { name: string; target: string; measured: string; pass: boolean }[];
    pass: boolean;
  } | null>(null);

  // Listen for workflow events
  useEffect(() => {
    if (!window.electronAPI) return;

    const cleanup = window.electronAPI.onWorkflowEvent((event) => {
      switch (event.type) {
        case 'stage-list': {
          const list = (event.data as { stageList: StageDef[] }).stageList;
          setStages(list.map((s) => ({ key: s.key, name: s.name, status: 'waiting' })));
          break;
        }
        case 'stage-start': {
          setStages((prev) =>
            prev.map((s) =>
              s.key === event.stageKey ? { ...s, status: 'running' } : s,
            ),
          );
          setIsRunning(true);
          setWelcomeOpen(false);
          const msg: ChatMessage = {
            id: `stage-${event.stageKey}-${Date.now()}`,
            role: 'system',
            content: `Starting: ${event.stageName}`,
            timestamp: event.timestamp,
          };
          setMessages((prev) => [...prev, msg]);
          break;
        }
        case 'stage-complete': {
          setStages((prev) =>
            prev.map((s) =>
              s.key === event.stageKey ? { ...s, status: 'done' } : s,
            ),
          );
          const output = (event.data as { output: string } | undefined)?.output ?? '';
          setOutputText((prev) => prev + output);
          break;
        }
        case 'stage-error': {
          setStages((prev) =>
            prev.map((s) =>
              s.key === event.stageKey ? { ...s, status: 'error' } : s,
            ),
          );
          const errMsg = (event.data as { error: string } | undefined)?.error ?? 'Unknown error';
          setMessages((prev) => [
            ...prev,
            {
              id: `error-${Date.now()}`,
              role: 'system',
              content: `Error in ${event.stageName}: ${errMsg}`,
              timestamp: event.timestamp,
              isError: true,
            },
          ]);
          break;
        }
        case 'output': {
          const text = (event.data as { text: string }).text;
          setOutputText((prev) => prev + text);
          break;
        }
        case 'tool-call': {
          const data = event.data as { tool?: string; stageKey?: string };
          if (data?.tool) {
            setToolCalls((prev) =>
              [
                { tool: data.tool!, stageKey: data.stageKey ?? '', timestamp: event.timestamp },
                ...prev,
              ].slice(0, 50),
            );
          }
          break;
        }
        case 'workflow-complete': {
          setIsRunning(false);
          setStages((prev) => prev.map((s) => ({
            ...s,
            status: s.status === 'running' ? 'done' : s.status,
          })));
          setMessages((prev) => [
            ...prev,
            {
              id: `complete-${Date.now()}`,
              role: 'system',
              content: 'Workflow complete.',
              timestamp: event.timestamp,
            },
          ]);
          break;
        }
      }
    });

    return cleanup;
  }, []);

  // Refresh job artifacts when a job is selected
  const refreshJobArtifacts = useCallback(async (jobId: string) => {
    setActiveJobId(jobId);
    try {
      const netlist = await window.electronAPI.readJobFile(jobId, 'design/design.final.cir');
      setNetlistContent(netlist || '');
    } catch { setNetlistContent(''); }
    try {
      const svg = await window.electronAPI.readJobFile(jobId, 'render/netlistsvg.svg');
      setSvgContent(svg || '');
    } catch { setSvgContent(''); }
    try {
      const report = await window.electronAPI.readJobFile(jobId, 'reports/final-summary.md');
      setReportContent(report || '');
    } catch { setReportContent(''); }
  }, []);

  const handleStartDesign = useCallback((requirement: string) => {
    setOutputText('');
    setToolCalls([]);
    setNetlistContent('');
    setSvgContent('');
    setReportContent('');
    setSimulationData(null);
    setMessages([
      {
        id: `user-${Date.now()}`,
        role: 'user',
        content: requirement,
        timestamp: Date.now(),
      },
    ]);

    window.electronAPI.startWorkflow({
      requirement,
      approvalPolicy,
      jobName: undefined,
    });
  }, [approvalPolicy]);

  const handleSelectJob = useCallback((jobId: string) => {
    refreshJobArtifacts(jobId);
  }, [refreshJobArtifacts]);

  return (
    <div style={styles.appShell}>
      {/* Left Sidebar */}
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        activeJobId={activeJobId}
        onSelectJob={handleSelectJob}
        onNewDesign={() => setWelcomeOpen(true)}
      />

      {/* Main Content */}
      <div style={styles.mainContent}>
        {/* Tab Bar */}
        <div style={styles.tabBar}>
          {(['chat', 'netlist', 'svg', 'simulation', 'report'] as TabKey[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                ...styles.tab,
                ...(activeTab === tab ? styles.tabActive : {}),
              }}
            >
              {tabLabels[tab]}
            </button>
          ))}
          <div style={styles.tabBarRight}>
            <select
              value={approvalPolicy}
              onChange={(e) => setApprovalPolicy(e.target.value as typeof approvalPolicy)}
              style={styles.policySelect}
            >
              <option value="manual">Manual</option>
              <option value="execution">Execution</option>
              <option value="all">All Auto</option>
            </select>
            <button
              onClick={() => setSettingsOpen(true)}
              style={styles.settingsBtn}
              title="Settings"
            >
              ⚙
            </button>
          </div>
        </div>

        {/* Tab Content */}
        <div style={styles.tabContent}>
          {activeTab === 'chat' && (
            <ChatView
              messages={messages}
              outputText={outputText}
              isRunning={isRunning}
              onSend={handleStartDesign}
            />
          )}
          {activeTab === 'netlist' && (
            <NetlistEditor content={netlistContent} jobId={activeJobId} />
          )}
          {activeTab === 'svg' && (
            <SvgViewer svgContent={svgContent} />
          )}
          {activeTab === 'simulation' && (
            <SimulationTab data={simulationData} />
          )}
          {activeTab === 'report' && (
            <ReportPreview content={reportContent} />
          )}
          {welcomeOpen && !isRunning && (
            <WelcomeScreen
              onStart={handleStartDesign}
              onClose={() => setWelcomeOpen(false)}
            />
          )}
        </div>
      </div>

      {/* Right Stage Panel */}
      <StagePanel
        collapsed={stagePanelCollapsed}
        onToggle={() => setStagePanelCollapsed(!stagePanelCollapsed)}
        stages={stages}
        toolCalls={toolCalls}
        isRunning={isRunning}
      />

      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}

const tabLabels: Record<TabKey, string> = {
  chat: 'Chat',
  netlist: 'Netlist',
  svg: 'SVG',
  simulation: 'Sim',
  report: 'Report',
};

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
