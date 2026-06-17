import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatView } from './components/chat/ChatView';
import { NetlistEditor } from './components/netlist/NetlistEditor';
import { SvgViewer } from './components/schematic/SvgViewer';
import { SimulationTab } from './components/simulation/SimulationTab';
import { ReportPreview } from './components/report/ReportPreview';
import { Sidebar } from './components/layout/Sidebar';
import { StagePanel } from './components/layout/StagePanel';
import { ResultWorkbench } from './components/layout/ResultWorkbench';
import { CircuitWorkbench } from './components/canvas/CircuitWorkbench';
import { StageConfirmDialog } from './components/common/StageConfirmDialog';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { SetupWizard } from './components/settings/SetupWizard';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { useAppStore, type SimulationMetric, type TabKey } from './store/appStore';
import type { ModuleManifest, StageDef } from './types';

const tabLabels: Record<TabKey, string> = {
  design: 'Design',
  netlist: 'Netlist',
  svg: 'SVG',
  simulation: 'Sim',
  report: 'Report',
};

type WorkflowStartParams = Parameters<Window['electronAPI']['startWorkflow']>[0];

interface DisplayDescriptor {
  schematic_svg?: string;
  netlist?: string;
  summary?: string;
  simulation_metrics?: string;
  module_manifest?: string | null;
}

function parseJson<T>(content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function isSimulationMetricArray(value: unknown): value is SimulationMetric[] {
  return Array.isArray(value) && value.every((entry) => (
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as SimulationMetric).name === 'string' &&
    typeof (entry as SimulationMetric).target === 'string' &&
    typeof (entry as SimulationMetric).measured === 'string' &&
    typeof (entry as SimulationMetric).pass === 'boolean'
  ));
}

const workflowStageKeys = [
  'solution-analyst',
  'doc-writer',
  'librarian',
  'architect',
  'netlist-designer',
  'simulation-verifier',
  'netlistsvg-renderer',
  'workflow-lead',
];

function normalizeWorkflowStage(stage?: string): string | undefined {
  if (!stage) return undefined;
  const normalized = stage.trim().toLowerCase();
  return workflowStageKeys.find((key) => key === normalized);
}

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
  const suppressAutoLoadRef = useRef(false);
  const latestDiscoveredJobRef = useRef<string | null>(null);
  const circuitLoadRequestRef = useRef(0);
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
          const data = event.data as { stageList: StageDef[]; rerunFromStage?: string };
          const list = data.stageList;
          const rerunIndex = data.rerunFromStage
            ? list.findIndex((s) => s.key === data.rerunFromStage)
            : -1;
          state.setStages(list.map((s, index) => ({
            key: s.key,
            name: s.name,
            status: rerunIndex > 0 && index < rerunIndex ? 'done' as const : 'waiting' as const,
          })));
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

  // Load workspace state on first mount. Provider API keys are optional.
  const refreshReferences = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const docs = await window.electronAPI.listReferenceDocuments();
      useAppStore.getState().setReferenceDocuments(docs);
    } catch {
      useAppStore.getState().setReferenceDocuments([]);
    }
  }, []);

  const refreshWorkspaces = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const [workspaces, activeWorkspace] = await Promise.all([
        window.electronAPI.listWorkspaces(),
        window.electronAPI.getActiveWorkspace(),
      ]);
      const state = useAppStore.getState();
      state.setWorkspaces(workspaces);
      state.setActiveWorkspace(activeWorkspace);
      const projects = await window.electronAPI.listCircuitProjects();
      state.setCircuitProjects(projects);
      await refreshReferences();
    } catch {
      useAppStore.getState().setWorkspaces([]);
    }
  }, [refreshReferences]);

  const refreshCircuitProjects = useCallback(async () => {
    if (!window.electronAPI) return;
    const projects = await window.electronAPI.listCircuitProjects();
    useAppStore.getState().setCircuitProjects(projects);
  }, []);

  const loadCircuitProject = useCallback(async (projectId: string, openDesign = true) => {
    if (!window.electronAPI) return;
    const requestId = ++circuitLoadRequestRef.current;
    const state = useAppStore.getState();
    state.setCircuitBusy(true);
    state.setCircuitError('');
    state.setActiveProjectId(projectId);
    state.setActiveJobId(null);
    setJobId(null);
    if (openDesign) state.setActiveTab('design');
    try {
      const bundle = await window.electronAPI.getCircuitProject(projectId);
      if (requestId !== circuitLoadRequestRef.current) return;
      const latest = useAppStore.getState();
      latest.setCircuitProject(bundle);
      latest.setActiveModuleId(
        bundle.project.modules.some((module) => module.id === latest.activeModuleId)
          ? latest.activeModuleId
          : bundle.project.modules[0]?.id ?? null,
      );
      latest.setCircuitBuild(await window.electronAPI.readCircuitBuild(projectId));
      await window.electronAPI.watchCircuitProject(projectId);
      await refreshCircuitProjects();
    } catch (error) {
      if (requestId === circuitLoadRequestRef.current) {
        useAppStore.getState().setCircuitError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestId === circuitLoadRequestRef.current) {
        useAppStore.getState().setCircuitBusy(false);
      }
    }
  }, [refreshCircuitProjects, setJobId]);

  useEffect(() => {
    if (!window.electronAPI) return;
    return window.electronAPI.onCircuitProjectChanged((event) => {
      const state = useAppStore.getState();
      if (event.projectId === state.activeProjectId && !state.circuitBusy) {
        void loadCircuitProject(event.projectId, false);
      }
      void refreshCircuitProjects();
    });
  }, [loadCircuitProject, refreshCircuitProjects]);

  useEffect(() => {
    const state = useAppStore.getState();
    if (!state.activeProjectId && state.circuitProjects[0]?.projectId) {
      void loadCircuitProject(state.circuitProjects[0].projectId);
    }
  }, [store.circuitProjects, loadCircuitProject]);

  const handleCreateCircuitProject = useCallback(async (demo: boolean) => {
    if (!window.electronAPI) return;
    const name = window.prompt('Circuit project name', demo ? 'Modular analog chain' : 'New circuit project');
    if (!name?.trim()) return;
    const state = useAppStore.getState();
    state.setCircuitBusy(true);
    state.setCircuitError('');
    try {
      const bundle = await window.electronAPI.createCircuitProject({ name: name.trim(), demo });
      for (const module of bundle.project.modules) {
        await window.electronAPI.compileCircuitModule(bundle.project.project_id, module.id);
      }
      await refreshCircuitProjects();
      await loadCircuitProject(bundle.project.project_id);
    } catch (error) {
      state.setCircuitError(error instanceof Error ? error.message : String(error));
    } finally {
      state.setCircuitBusy(false);
    }
  }, [loadCircuitProject, refreshCircuitProjects]);

  useEffect(() => {
    if (!window.electronAPI) return;
    refreshWorkspaces();
  }, [refreshWorkspaces]);

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
    suppressAutoLoadRef.current = false;
    state.setActiveProjectId(null);
    state.setCircuitProject(null);
    state.setCircuitBuild(null);
    state.setActiveJobId(jobId);
    setJobId(jobId);
    state.setNetlistContent('');
    state.setSvgContent('');
    state.setReportContent('');
    state.setSimulationData(null);
    state.setModuleManifest(null);

    const descriptorRaw = await window.electronAPI.readJobFile(jobId, 'reports/actoviq-display.json');
    const descriptor = descriptorRaw ? parseJson<DisplayDescriptor>(descriptorRaw) : null;
    const netlistPath = descriptor?.netlist ?? 'design/design.final.cir';
    const svgPath = descriptor?.schematic_svg ?? 'render/netlistsvg.svg';
    const summaryPath = descriptor?.summary ?? 'reports/final-summary.md';
    const metricsPath = descriptor?.simulation_metrics ?? 'verification/final-simulation/gui-metrics.json';
    const moduleManifestPath = descriptor?.module_manifest ?? 'design/module-manifest.json';

    const [netlist, svg, report, metricsRaw, moduleManifestRaw] = await Promise.all([
      window.electronAPI.readJobFile(jobId, netlistPath),
      window.electronAPI.readJobFile(jobId, svgPath),
      window.electronAPI.readJobFile(jobId, summaryPath),
      window.electronAPI.readJobFile(jobId, metricsPath),
      moduleManifestPath ? window.electronAPI.readJobFile(jobId, moduleManifestPath) : Promise.resolve(''),
    ]);
    const latestState = useAppStore.getState();
    latestState.setNetlistContent(netlist || '');
    latestState.setSvgContent(svg || '');
    latestState.setReportContent(report || '');

    let metrics = metricsRaw ? parseJson<unknown>(metricsRaw) : null;
    if (!isSimulationMetricArray(metrics)) {
      const legacyMetricsRaw = await window.electronAPI.readJobFile(
        jobId,
        'verification/final-simulation/metrics.json',
      );
      metrics = legacyMetricsRaw ? parseJson<unknown>(legacyMetricsRaw) : null;
    }
    latestState.setSimulationData(isSimulationMetricArray(metrics) ? metrics : null);
    const moduleManifest = moduleManifestRaw
      ? parseJson<ModuleManifest>(moduleManifestRaw)
      : null;
    latestState.setModuleManifest(moduleManifest);
  }, [setJobId]);

  // Auto-load newly published external agent results without overriding manual job selection.
  useEffect(() => {
    if (!window.electronAPI) return;
    let cancelled = false;
    latestDiscoveredJobRef.current = null;
    const loadLatestAgentJob = async () => {
      const state = useAppStore.getState();
      if (suppressAutoLoadRef.current || state.isRunning || state.activeProjectId) {
        return;
      }
      const jobs = await window.electronAPI!.listJobs();
      if (cancelled || jobs.length === 0) {
        return;
      }
      const latestState = useAppStore.getState();
      if (latestState.activeProjectId || latestState.isRunning) {
        return;
      }
      const latest = jobs[0];
      if (latest?.jobId) {
        const previousLatest = latestDiscoveredJobRef.current;
        latestDiscoveredJobRef.current = latest.jobId;
        if (!latestState.activeJobId || (previousLatest !== null && previousLatest !== latest.jobId)) {
          await refreshJobArtifacts(latest.jobId);
        }
      }
    };
    loadLatestAgentJob();
    const interval = window.setInterval(loadLatestAgentJob, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [refreshJobArtifacts, store.activeWorkspace?.id]);

  const handleNewDesign = useCallback(() => {
    const state = useAppStore.getState();
    state.resetWorkflow();
    state.setActiveJobId(null);
    suppressAutoLoadRef.current = true;
    state.newConversation();
    workflowConversationIdRef.current = null;
    setJobId(null);
    state.setActiveTab('design');
    state.setChatOpen(true);
  }, []);

  const startWorkflowRun = useCallback((params: WorkflowStartParams, conversationId: string) => {
    if (!window.electronAPI) return;
    const latest = useAppStore.getState();
    latest.resetWorkflow({ preserveMessages: true });
    latest.setIsRunning(true);
    latest.setActiveTab('design');
    latest.setChatOpen(true);
    workflowConversationIdRef.current = conversationId;
    window.electronAPI.startWorkflow({
      ...params,
      approvalPolicy: params.approvalPolicy ?? latest.approvalPolicy,
    });
  }, []);

  const handleValidateActiveJob = useCallback(() => {
    const state = useAppStore.getState();
    const jobId = currentJobIdRef.current ?? state.activeJobId;
    let cid = state.conversationId;
    if (!cid) {
      cid = state.newConversation();
    }

    if (!jobId) {
      state.addMessage({
        id: `validate-no-job-${Date.now()}`,
        role: 'system',
        content: 'Select a job before running validation.',
        timestamp: Date.now(),
        isError: true,
        conversationId: cid,
      });
      return;
    }

    if (state.isRunning) {
      state.addMessage({
        id: `validate-busy-${Date.now()}`,
        role: 'system',
        content: 'A workflow is already running. Stop it or wait for it to finish before starting validation.',
        timestamp: Date.now(),
        conversationId: cid,
      });
      return;
    }

    state.addMessage({
      id: `validate-start-${Date.now()}`,
      role: 'system',
      content: `Starting quick validation from Simulation Verifier for ${jobId}.`,
      timestamp: Date.now(),
      conversationId: cid,
    });
    startWorkflowRun({
      resumeJob: jobId,
      rerunFromStage: 'simulation-verifier',
      approvalPolicy: state.approvalPolicy,
    }, cid);
  }, [startWorkflowRun]);

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
      const activeJobId = currentJobIdRef.current ?? state.activeJobId;
      const result = await window.electronAPI.sendChatMessage(trimmed, history, { activeJobId });

      // Show the agent's chat response
      useAppStore.getState().addMessage({
        id: `agent-${Date.now()}`,
        role: 'system',
        content: result.text,
        timestamp: Date.now(),
        isError: result.isError,
        conversationId: cid,
      });

      const wantsWorkflow = result.isDesignRequest || result.isRevisionRequest;

      // If it is a design or revision request, trigger the workflow
      if (wantsWorkflow && workflowWasRunning) {
        useAppStore.getState().addMessage({
          id: `workflow-busy-${Date.now()}`,
          role: 'system',
          content: 'A design workflow is already running. I kept your note in this conversation and will not start a second workflow until the current one finishes.',
          timestamp: Date.now(),
          conversationId: cid,
        });
      } else if (result.isRevisionRequest) {
        const latest = useAppStore.getState();
        const baseJobId = activeJobId ?? latest.activeJobId;
        if (!baseJobId) {
          latest.addMessage({
            id: `revision-no-job-${Date.now()}`,
            role: 'system',
            content: 'Select a completed job first, then ask for the change again.',
            timestamp: Date.now(),
            isError: true,
            conversationId: cid,
          });
          return;
        }
        const targetStage = normalizeWorkflowStage(result.targetStage);
        const revisionText = `${trimmed}\n${result.revisionRequest ?? ''}`;
        const rerunOnly =
          targetStage !== undefined &&
          /rerun|validate|verify|simulation|simulate|render|summary|重跑|重新|验证|仿真|渲染|总结/i.test(revisionText) &&
          !/modify|change|fix|tune|optimi[sz]e|adjust|修改|改成|调整|优化|修复|替换|增加|删除/i.test(revisionText);
        latest.addMessage({
          id: `revision-start-${Date.now()}`,
          role: 'system',
          content: rerunOnly
            ? `Rerunning ${targetStage} for ${baseJobId}.`
            : `Starting a revision workflow from ${baseJobId}${targetStage ? `, focusing on ${targetStage}` : ''}.`,
          timestamp: Date.now(),
          conversationId: cid,
        });
        if (rerunOnly) {
          startWorkflowRun({
            resumeJob: baseJobId,
            rerunFromStage: targetStage,
            approvalPolicy: latest.approvalPolicy,
          }, cid);
        } else {
          startWorkflowRun({
            requirement: result.revisionRequest || trimmed,
            revisionBaseJob: baseJobId,
            approvalPolicy: latest.approvalPolicy,
          }, cid);
        }
      } else if (result.isDesignRequest) {
        const requirement = result.formalizedRequirement || trimmed;
        const latest = useAppStore.getState();
        startWorkflowRun({
          requirement,
          approvalPolicy: latest.approvalPolicy,
          jobName: undefined,
        }, cid);
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
  }, [isChatPending, startWorkflowRun]);

  const handleSelectWorkspace = useCallback(async (id: string) => {
    if (!window.electronAPI) return;
    const workspace = await window.electronAPI.selectWorkspace(id);
    const state = useAppStore.getState();
    suppressAutoLoadRef.current = false;
    state.setActiveWorkspace(workspace);
    state.setActiveJobId(null);
    state.setActiveProjectId(null);
    state.setCircuitProject(null);
    state.setCircuitBuild(null);
    state.resetWorkflow();
    setJobId(null);
    await refreshWorkspaces();
  }, [refreshWorkspaces, setJobId]);

  const handleCreateWorkspace = useCallback(async () => {
    if (!window.electronAPI) return;
    const name = window.prompt('Workspace name');
    if (!name?.trim()) return;
    const root = await window.electronAPI.chooseWorkspaceRoot();
    const workspace = await window.electronAPI.createWorkspace({ name, root: root ?? undefined });
    const state = useAppStore.getState();
    suppressAutoLoadRef.current = false;
    state.setActiveWorkspace(workspace);
    state.setActiveJobId(null);
    state.setActiveProjectId(null);
    state.setCircuitProject(null);
    state.setCircuitBuild(null);
    state.resetWorkflow();
    setJobId(null);
    await refreshWorkspaces();
  }, [refreshWorkspaces, setJobId]);

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
          activeWorkspace={store.activeWorkspace}
          workspaces={store.workspaces}
          referenceDocuments={store.referenceDocuments}
          onSelectWorkspace={handleSelectWorkspace}
          onCreateWorkspace={handleCreateWorkspace}
          onRefreshReferences={refreshReferences}
          circuitProjects={store.circuitProjects}
          activeProjectId={store.activeProjectId}
          onSelectProject={loadCircuitProject}
          onCreateProject={handleCreateCircuitProject}
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
              <button
                onClick={store.toggleChatOpen}
                style={{
                  ...styles.chatToggleBtn,
                  ...(store.chatOpen ? styles.chatToggleBtnActive : {}),
                }}
                title={store.chatOpen ? 'Hide chat' : 'Open chat'}
              >
                {store.chatOpen ? 'Hide Chat' : 'Chat'}
              </button>
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
            {store.activeTab === 'design' && (
              <CircuitWorkbench
                onCreateProject={handleCreateCircuitProject}
                onReloadProject={async () => {
                  const projectId = useAppStore.getState().activeProjectId;
                  if (projectId) await loadCircuitProject(projectId, false);
                }}
              />
            )}
            {store.activeTab === 'netlist' && (
              <NetlistEditor
                onValidate={handleValidateActiveJob}
                isWorkflowRunning={store.isRunning}
                onReloadProject={async () => {
                  const projectId = useAppStore.getState().activeProjectId;
                  if (projectId) await loadCircuitProject(projectId, false);
                }}
              />
            )}
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

        {store.chatOpen && (
          <div style={styles.chatDrawer}>
            <div style={styles.chatDrawerHeader}>
              <span style={styles.chatDrawerTitle}>Chat Workflow</span>
              <button onClick={() => store.setChatOpen(false)} style={styles.chatCloseBtn}>Close</button>
            </div>
            <div style={styles.chatDrawerBody}>
              <ChatView onSend={handleSendMessage} isPending={isChatPending} />
            </div>
          </div>
        )}

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
    backgroundColor: '#f3f5f7',
    color: '#28313b',
    position: 'relative',
    overflow: 'hidden',
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
    backgroundColor: '#ffffff',
    borderBottom: '1px solid #dfe3e8',
    paddingLeft: 8,
    gap: 2,
  },
  tab: {
    padding: '6px 16px',
    border: 'none',
    background: 'transparent',
    color: '#69727d',
    cursor: 'pointer',
    fontSize: 13,
    borderBottomWidth: 2,
    borderBottomStyle: 'solid',
    borderBottomColor: 'transparent',
    transition: 'all 0.15s',
  },
  tabActive: {
    color: '#2563eb',
    borderBottomColor: '#2563eb',
  },
  tabBarRight: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    paddingRight: 8,
  },
  policySelect: {
    background: '#ffffff',
    color: '#3f4a56',
    border: '1px solid #c8cfd7',
    borderRadius: 4,
    padding: '3px 8px',
    fontSize: 12,
  },
  chatToggleBtn: {
    padding: '4px 12px',
    backgroundColor: '#ffffff',
    color: '#3f4a56',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: '#c8cfd7',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
  },
  chatToggleBtnActive: {
    borderColor: '#2563eb',
    color: '#1f5fbf',
  },
  stopBtn: {
    padding: '4px 12px',
    backgroundColor: '#c73b4a',
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
    color: '#69727d',
    cursor: 'pointer',
    fontSize: 14,
    padding: '2px 6px',
  },
  settingsBtn: {
    background: 'transparent',
    border: 'none',
    color: '#69727d',
    cursor: 'pointer',
    fontSize: 16,
    padding: '2px 6px',
  },
  tabContent: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
    overflow: 'hidden',
  },
  chatDrawer: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 'min(420px, calc(100vw - 64px))',
    minWidth: 0,
    height: '100%',
    backgroundColor: '#ffffff',
    borderLeft: '1px solid #dfe3e8',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '-8px 0 24px rgba(32,42,56,0.12)',
    zIndex: 20,
  },
  chatDrawerHeader: {
    height: 36,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0 10px 0 14px',
    borderBottom: '1px solid #dfe3e8',
    backgroundColor: '#ffffff',
  },
  chatDrawerTitle: {
    fontSize: 12,
    color: '#69727d',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  chatCloseBtn: {
    background: 'transparent',
    border: 'none',
    color: '#2563eb',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
  },
  chatDrawerBody: {
    flex: 1,
    minHeight: 0,
  },
  dragHandle: {
    width: 4,
    cursor: 'col-resize',
    backgroundColor: '#dfe3e8',
    transition: 'background-color 0.15s',
    flexShrink: 0,
  },
};
