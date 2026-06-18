import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useAppStore } from '../../store/appStore';
import type {
  CircuitCommand,
  CircuitConnection,
  CircuitModule,
  CircuitModuleRef,
  CircuitPort,
} from '../../types';

interface Props {
  onCreateProject: (demo: boolean) => void;
  onReloadProject: () => Promise<void>;
}

interface ModuleEditorState {
  mode: 'add' | 'edit';
  id: string;
  name: string;
  kind: string;
  functionText: string;
  parametersText: string;
  position: { x: number; y: number };
}

function commandId(): string {
  return `gui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function prepareSvg(svg: string): string {
  const sanitized = svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
    // Drop external/script-bearing refs (js:, data:, http(s):, protocol-relative);
    // netlistsvg only uses internal "#id" references, which are preserved.
    .replace(/\s(?:href|xlink:href)\s*=\s*["']\s*(?:javascript:|data:|https?:|\/\/)[^"']*["']/gi, '');
  return sanitized.replace(
    /<svg\b([^>]*)>/i,
    (_match, attributes: string) => {
      const cleanedAttributes = attributes
        .replace(/\sstyle\s*=\s*["'][^"']*["']/gi, '')
        .replace(/\spreserveAspectRatio\s*=\s*["'][^"']*["']/gi, '');
      return `<svg${cleanedAttributes} style="width:100%;height:100%;display:block" preserveAspectRatio="xMidYMid meet">`;
    },
  );
}

function isGround(port: CircuitPort): boolean {
  const value = `${port.name} ${port.net}`.toLowerCase();
  return port.signal_type === 'ground' || /(?:^|\s)[adp]?gnd(?:\s|$)/.test(value);
}

function visibleInterfaces(module: CircuitModuleRef): {
  inputs: CircuitPort[];
  outputs: CircuitPort[];
  grounds: CircuitPort[];
} {
  return {
    inputs: module.ports.filter((port) => !isGround(port) && port.direction === 'input'),
    outputs: module.ports.filter((port) => !isGround(port) && port.direction === 'output'),
    grounds: module.ports.filter(isGround),
  };
}

interface SystemNetwork {
  label: string;
  endpoints: string[];
}

type SystemNetworkMap = Record<string, SystemNetwork>;

function endpointKey(moduleId: string, portId: string): string {
  return `${moduleId}::${portId}`;
}

function resolveSystemNetworks(
  modules: CircuitModuleRef[],
  connections: CircuitConnection[],
): SystemNetworkMap {
  const parents = new Map<string, string>();
  const ports = new Map<string, { moduleId: string; port: CircuitPort }>();
  const find = (value: string): string => {
    if (!parents.has(value)) parents.set(value, value);
    const parent = parents.get(value) ?? value;
    if (parent === value) return value;
    const root = find(parent);
    parents.set(value, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot);
  };

  for (const module of modules) {
    for (const port of module.ports) {
      const key = endpointKey(module.id, port.id);
      ports.set(key, { moduleId: module.id, port });
      find(key);
    }
  }
  for (const connection of connections) {
    union(
      endpointKey(connection.from.module_id, connection.from.port_id),
      endpointKey(connection.to.module_id, connection.to.port_id),
    );
  }

  const groups = new Map<string, Array<{ key: string; moduleId: string; port: CircuitPort }>>();
  for (const [key, value] of ports) {
    const root = find(key);
    groups.set(root, [...(groups.get(root) ?? []), { key, ...value }]);
  }
  const explicitLabels = new Map<string, string[]>();
  for (const connection of connections) {
    const network = connection.network?.trim();
    if (!network) continue;
    const root = find(endpointKey(connection.from.module_id, connection.from.port_id));
    explicitLabels.set(root, [...new Set([...(explicitLabels.get(root) ?? []), network])]);
  }

  const resolved: SystemNetworkMap = {};
  for (const [root, members] of groups) {
    const source = members.find(({ port }) => port.direction === 'output');
    const ground = members.find(({ port }) => isGround(port));
    const label = explicitLabels.get(root)?.[0]
      ?? ground?.port.network
      ?? (/^(?:AGND|DGND|PGND)$/i.test(ground?.port.name ?? '') ? ground?.port.name : undefined)
      ?? source?.port.network
      ?? source?.port.net
      ?? source?.port.name
      ?? members[0]?.port.network
      ?? members[0]?.port.net
      ?? 'UNNAMED';
    const endpoints = members.map(({ moduleId, port }) => `${moduleId}.${port.id}`);
    for (const member of members) {
      resolved[member.key] = { label, endpoints };
    }
  }
  return resolved;
}

function interfaceNetworks(
  moduleId: string,
  ports: CircuitPort[],
  tone: 'input' | 'output' | 'ground',
  systemNetworks: SystemNetworkMap,
): string[] {
  return [...new Set(ports.map((port) => {
    const systemNetwork = systemNetworks[endpointKey(moduleId, port.id)];
    if (systemNetwork) return systemNetwork.label;
    if (tone === 'ground' && /^(?:AGND|DGND|PGND)$/i.test(port.name)) {
      if (port.net === '0') return port.name;
      if (port.name.toLowerCase() === port.net.toLowerCase()) return port.net;
      return `${port.name} (${port.net})`;
    }
    return port.net;
  }))];
}

function fallbackParameters(module: CircuitModule | undefined): Record<string, string> {
  if (!module) return {};
  return Object.fromEntries(
    module.components.slice(0, 5).map((component) => [component.name, component.value]),
  );
}

function formatParameters(parameters: Record<string, string> | undefined): string {
  return Object.entries(parameters ?? {})
    .map(([name, value]) => `${name} = ${value}`)
    .join('\n');
}

function parseParameters(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.includes('=') ? '=' : ':';
        const index = line.indexOf(separator);
        if (index < 1) throw new Error(`Invalid parameter line: ${line}`);
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}

export function CircuitWorkbench({ onCreateProject, onReloadProject }: Props) {
  const bundle = useAppStore((state) => state.circuitProject);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const activeModuleId = useAppStore((state) => state.activeModuleId);
  const setActiveModuleId = useAppStore((state) => state.setActiveModuleId);
  const build = useAppStore((state) => state.circuitBuild);
  const busy = useAppStore((state) => state.circuitBusy);
  const error = useAppStore((state) => state.circuitError);
  const setBusy = useAppStore((state) => state.setCircuitBusy);
  const setError = useAppStore((state) => state.setCircuitError);
  const setBuild = useAppStore((state) => state.setCircuitBuild);
  const [view, setView] = useState<'board' | 'module'>('board');
  const [zoom, setZoom] = useState(65);
  const [notice, setNotice] = useState('');
  const [copiedId, setCopiedId] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [isPanning, setIsPanning] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    moduleId?: string;
    boardPosition: { x: number; y: number };
  } | null>(null);
  const [moduleEditor, setModuleEditor] = useState<ModuleEditorState | null>(null);
  const [moduleEditorError, setModuleEditorError] = useState('');
  const canvasPanelRef = useRef<HTMLDivElement | null>(null);
  const [modulePreviewPositions, setModulePreviewPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [modulePreviewSizes, setModulePreviewSizes] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const [moduleSimulation, setModuleSimulation] = useState<{
    ok: boolean;
    module_id: string;
    metrics: Array<{ name: string; value: number; unit: string; pass: boolean }>;
  } | null>(null);

  const project = bundle?.project ?? null;
  const systemNetworks = useMemo(
    () => resolveSystemNetworks(project?.modules ?? [], project?.connections ?? []),
    [project],
  );
  const selectedRef = project?.modules.find((module) => module.id === activeModuleId) ?? null;
  const selectedModule = activeModuleId ? bundle?.modules[activeModuleId] : undefined;
  const selectedPreview = activeModuleId ? bundle?.module_previews[activeModuleId] : undefined;

  useEffect(() => {
    if (!project) return;
    const currentExists = activeModuleId && project.modules.some((entry) => entry.id === activeModuleId);
    if (!currentExists) setActiveModuleId(project.modules[0]?.id ?? null);
  }, [activeModuleId, project, setActiveModuleId]);

  useEffect(() => {
    setNoteDraft(selectedRef?.notes ?? '');
    setModuleSimulation(null);
  }, [selectedRef?.id, selectedRef?.notes]);

  useEffect(() => {
    setModulePreviewPositions({});
    setModulePreviewSizes({});
  }, [activeProjectId]);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('pointerdown', closeMenu);
    return () => {
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('pointerdown', closeMenu);
    };
  }, []);

  useEffect(() => {
    const panel = canvasPanelRef.current;
    if (!panel || view !== 'board') return;
    const listener = (event: WheelEvent) => handleCanvasWheel(event);
    panel.addEventListener('wheel', listener, { passive: false });
    return () => panel.removeEventListener('wheel', listener);
  }, [view, zoom, project?.project_id]);

  async function applyOperations(
    message: string,
    operations: Array<Record<string, unknown>>,
  ): Promise<boolean> {
    if (!project || !activeProjectId) return false;
    const command: CircuitCommand = {
      schema: 'actoviq.command.v1',
      command_id: commandId(),
      actor: 'user',
      project_id: project.project_id,
      base_revision: project.revision,
      message,
      operations,
    };
    setBusy(true);
    setError('');
    try {
      await window.electronAPI.applyCircuitCommand(activeProjectId, command);
      await onReloadProject();
      setNotice(message);
      return true;
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : String(commandError));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function buildModulePreview(moduleId: string, showNotice = true): Promise<boolean> {
    if (!activeProjectId) return false;
    setBusy(true);
    setError('');
    if (showNotice) setNotice('Rendering module with netlistsvg...');
    try {
      const result = await window.electronAPI.compileCircuitModule(activeProjectId, moduleId);
      if (!result.schematic_path) {
        throw new Error('netlistsvg did not produce a module SVG.');
      }
      await onReloadProject();
      if (showNotice) setNotice('Module SVG updated');
      return true;
    } catch (buildError) {
      setError(buildError instanceof Error ? buildError.message : String(buildError));
      setNotice('');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function openModule(moduleId: string): Promise<void> {
    setActiveModuleId(moduleId);
    setView('module');
    if (!bundle?.module_previews[moduleId]) {
      await buildModulePreview(moduleId);
    }
  }

  async function togglePreview(module: CircuitModuleRef): Promise<void> {
    const enabled = !(module.preview_enabled ?? true);
    await applyOperations(enabled ? 'Show module preview' : 'Hide module preview', [{
      op: 'set_module_preview',
      module_id: module.id,
      enabled,
    }]);
    if (enabled && !bundle?.module_previews[module.id]) {
      await buildModulePreview(module.id, false);
    }
  }

  async function runBuild(simulate: boolean) {
    if (!activeProjectId || !project) return;
    setBusy(true);
    setError('');
    setNotice(simulate ? 'Running system simulation...' : 'Building netlist and module SVG previews...');
    try {
      if (simulate) {
        await window.electronAPI.simulateCircuitProject(activeProjectId);
      } else {
        await window.electronAPI.compileCircuitProject(activeProjectId);
        for (const module of project.modules) {
          await window.electronAPI.compileCircuitModule(activeProjectId, module.id);
        }
      }
      setBuild(await window.electronAPI.readCircuitBuild(activeProjectId));
      await onReloadProject();
      setNotice(simulate ? 'System simulation complete' : 'Netlist and previews updated');
    } catch (buildError) {
      setError(buildError instanceof Error ? buildError.message : String(buildError));
      setNotice('');
    } finally {
      setBusy(false);
    }
  }

  async function runModuleSimulation() {
    if (!activeProjectId || !activeModuleId) return;
    setBusy(true);
    setError('');
    setNotice('Running module testbench...');
    try {
      const result = await window.electronAPI.simulateCircuitModule(activeProjectId, activeModuleId);
      setModuleSimulation(result);
      await onReloadProject();
      setNotice('Module simulation complete');
    } catch (simulationError) {
      setError(simulationError instanceof Error ? simulationError.message : String(simulationError));
      setNotice('');
    } finally {
      setBusy(false);
    }
  }

  async function copyModuleId(moduleId: string) {
    try {
      await navigator.clipboard.writeText(moduleId);
      setCopiedId(moduleId);
      window.setTimeout(() => setCopiedId(''), 1400);
    } catch {
      setError('Could not copy the module ID to the clipboard.');
    }
  }

  function beginModuleDrag(event: ReactPointerEvent, module: CircuitModuleRef) {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button, input, textarea, label, [data-resize-handle]')) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = modulePreviewPositions[module.id] ?? module.position;
    let moved = false;
    const scale = zoom / 100;
    const move = (moveEvent: PointerEvent) => {
      if (!moved && Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) < 12) return;
      moved = true;
      setModulePreviewPositions((current) => ({
        ...current,
        [module.id]: {
          x: Math.max(40, origin.x + (moveEvent.clientX - startX) / scale),
          y: Math.max(40, origin.y + (moveEvent.clientY - startY) / scale),
        },
      }));
    };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) return;
      const position = {
        x: Math.max(40, origin.x + (upEvent.clientX - startX) / scale),
        y: Math.max(40, origin.y + (upEvent.clientY - startY) / scale),
      };
      void applyOperations(`Move module ${module.name}`, [{
        op: 'move_module',
        module_id: module.id,
        x: Math.round(position.x),
        y: Math.round(position.y),
      }]).then((saved) => {
        if (!saved) return;
        setModulePreviewPositions((current) => {
          const next = { ...current };
          delete next[module.id];
          return next;
        });
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }

  function beginModuleResize(event: ReactPointerEvent, module: CircuitModuleRef) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = modulePreviewSizes[module.id] ?? module.size;
    const scale = zoom / 100;
    let resized = false;
    const nextSize = (clientX: number, clientY: number) => ({
      width: Math.max(260, Math.min(760, origin.width + (clientX - startX) / scale)),
      height: Math.max(220, Math.min(640, origin.height + (clientY - startY) / scale)),
    });
    const move = (moveEvent: PointerEvent) => {
      if (!resized && Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) < 6) return;
      resized = true;
      setModulePreviewSizes((current) => ({
        ...current,
        [module.id]: nextSize(moveEvent.clientX, moveEvent.clientY),
      }));
    };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!resized) return;
      const size = nextSize(upEvent.clientX, upEvent.clientY);
      void applyOperations(`Resize module ${module.name}`, [{
        op: 'resize_module',
        module_id: module.id,
        width: Math.round(size.width),
        height: Math.round(size.height),
      }]).then((saved) => {
        if (!saved) return;
        setModulePreviewSizes((current) => {
          const next = { ...current };
          delete next[module.id];
          return next;
        });
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }

  async function arrangeModules() {
    if (!project) return;
    const operations = project.modules.map((module, index) => ({
      op: 'move_module',
      module_id: module.id,
      x: 100 + (index % 3) * 400,
      y: 110 + Math.floor(index / 3) * 340,
    }));
    await applyOperations('Arrange module canvas', operations);
  }

  function handleCanvasWheel(event: WheelEvent) {
    if (view !== 'board' || !event.ctrlKey) return;
    event.preventDefault();
    const panel = canvasPanelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const oldScale = zoom / 100;
    const nextZoom = Math.max(35, Math.min(110, zoom + (event.deltaY < 0 ? 10 : -10)));
    if (nextZoom === zoom) return;
    const boardX = (panel.scrollLeft + event.clientX - rect.left) / oldScale;
    const boardY = (panel.scrollTop + event.clientY - rect.top) / oldScale;
    setZoom(nextZoom);
    window.requestAnimationFrame(() => {
      const nextScale = nextZoom / 100;
      panel.scrollLeft = boardX * nextScale - (event.clientX - rect.left);
      panel.scrollTop = boardY * nextScale - (event.clientY - rect.top);
    });
  }

  function beginCanvasPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (view !== 'board' || event.button !== 1) return;
    const panel = canvasPanelRef.current;
    if (!panel) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = panel.scrollLeft;
    const startTop = panel.scrollTop;
    setIsPanning(true);
    const move = (moveEvent: PointerEvent) => {
      panel.scrollLeft = startLeft - (moveEvent.clientX - startX);
      panel.scrollTop = startTop - (moveEvent.clientY - startY);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setIsPanning(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }

  function openCanvasContextMenu(
    event: ReactMouseEvent,
    moduleId?: string,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const panel = canvasPanelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const scale = zoom / 100;
    setContextMenu({
      // Clamp to the viewport so the menu never opens partly off-screen near an edge.
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 200)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 150)),
      moduleId,
      boardPosition: {
        x: Math.max(40, Math.round((panel.scrollLeft + event.clientX - rect.left - 20) / scale)),
        y: Math.max(40, Math.round((panel.scrollTop + event.clientY - rect.top - 20) / scale)),
      },
    });
  }

  function openAddModuleEditor(position: { x: number; y: number }) {
    setContextMenu(null);
    setModuleEditorError('');
    setModuleEditor({
      mode: 'add',
      id: `module-${Date.now().toString(36)}`,
      name: 'New circuit module',
      kind: 'module',
      functionText: '',
      parametersText: '',
      position,
    });
  }

  function openEditModuleEditor(module: CircuitModuleRef) {
    setContextMenu(null);
    setActiveModuleId(module.id);
    setModuleEditorError('');
    setModuleEditor({
      mode: 'edit',
      id: module.id,
      name: module.name,
      kind: module.kind,
      functionText: module.function ?? '',
      parametersText: formatParameters(module.parameters),
      position: module.position,
    });
  }

  async function saveModuleEditor() {
    if (!moduleEditor || !project) return;
    const id = moduleEditor.id.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
      setModuleEditorError('ID may contain lowercase letters, numbers, hyphens, and underscores.');
      return;
    }
    if (!moduleEditor.name.trim() || !moduleEditor.kind.trim()) {
      setModuleEditorError('Name and kind are required.');
      return;
    }
    if (moduleEditor.mode === 'add' && project.modules.some((module) => module.id === id)) {
      setModuleEditorError(`Module ID "${id}" already exists.`);
      return;
    }
    let parameters: Record<string, string>;
    try {
      parameters = parseParameters(moduleEditor.parametersText);
    } catch (parameterError) {
      setModuleEditorError(parameterError instanceof Error ? parameterError.message : String(parameterError));
      return;
    }
    const operation = moduleEditor.mode === 'add'
      ? {
          op: 'upsert_module',
          module_ref: {
            id,
            name: moduleEditor.name.trim(),
            kind: moduleEditor.kind.trim(),
            function: moduleEditor.functionText.trim(),
            parameters,
            notes: '',
            preview_enabled: false,
            source: `modules/${id}/module.circuit.json`,
            position: moduleEditor.position,
            size: { width: 320, height: 250 },
            ports: [
              { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
              { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
              { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
            ],
          },
          module: {
            schema: 'actoviq.module.v1',
            module_id: id,
            name: moduleEditor.name.trim(),
            revision: 0,
            ports: [
              { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
              { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
              { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
            ],
            components: [],
            wires: [],
            annotations: [],
          },
        }
      : {
          op: 'set_module_metadata',
          module_id: id,
          name: moduleEditor.name.trim(),
          kind: moduleEditor.kind.trim(),
          function: moduleEditor.functionText.trim(),
          parameters,
        };
    const saved = await applyOperations(
      moduleEditor.mode === 'add' ? `Add module ${id}` : `Edit module ${id}`,
      [operation],
    );
    if (saved) {
      setActiveModuleId(id);
      setModuleEditor(null);
      setModuleEditorError('');
    }
  }

  if (!project || !bundle) {
    return (
      <div style={styles.empty} data-testid="circuit-empty-state">
        <div style={styles.emptyBadge}>SCHEMATIC HUB</div>
        <h1 style={styles.emptyTitle}>Start a modular circuit project</h1>
        <p style={styles.emptyText}>
          Claude Code, Codex, and this desktop share the same module netlists and netlistsvg output.
        </p>
        <div style={styles.actionRow}>
          <button style={styles.primaryButton} onClick={() => onCreateProject(true)} data-testid="create-demo-project">
            Create three-module demo
          </button>
          <button style={styles.secondaryButton} onClick={() => onCreateProject(false)} data-testid="create-blank-project">
            Create blank project
          </button>
        </div>
      </div>
    );
  }

  const displayedModules = project.modules.map((module) => ({
    ...module,
    position: modulePreviewPositions[module.id] ?? module.position,
    size: modulePreviewSizes[module.id] ?? module.size,
  }));

  return (
    <div style={styles.root} data-testid="circuit-workbench">
      <header style={styles.header}>
        <div style={styles.titleBlock}>
          <div style={styles.eyebrow}>Schematic Module Hub</div>
          <div style={styles.projectTitle}>{project.name}</div>
          <div style={styles.projectMeta}>
            revision {project.revision} | {project.modules.length} modules
            {build ? ` | ${build.manifest.status}` : ''}
          </div>
        </div>
        <div style={styles.toolbar}>
          {view === 'module' ? (
            <button style={styles.secondaryButton} onClick={() => setView('board')} data-testid="back-to-board">
              Back to canvas
            </button>
          ) : (
            <>
              <button style={styles.secondaryButton} onClick={arrangeModules} disabled={busy}>
                Arrange
              </button>
              <div style={styles.zoomControl}>
                <button
                  style={styles.zoomButton}
                  onClick={() => setZoom((value) => Math.max(35, value - 10))}
                  title="Zoom out"
                >
                  -
                </button>
                <span style={styles.zoomValue} data-testid="canvas-zoom">{zoom}%</span>
                <button
                  style={styles.zoomButton}
                  onClick={() => setZoom((value) => Math.min(110, value + 10))}
                  title="Zoom in"
                >
                  +
                </button>
              </div>
            </>
          )}
          <button style={styles.secondaryButton} onClick={() => runBuild(false)} disabled={busy} data-testid="build-project">
            Refresh SVGs
          </button>
          <button style={styles.primaryButton} onClick={() => runBuild(true)} disabled={busy} data-testid="simulate-project">
            Simulate system
          </button>
          <button
            style={styles.iconButton}
            onClick={() => window.electronAPI.openCircuitProjectFolder(project.project_id)}
            title="Open project folder"
          >
            Folder
          </button>
        </div>
      </header>

      {(error || notice) && (
        <div style={{ ...styles.notice, ...(error ? styles.noticeError : {}) }} role={error ? 'alert' : 'status'}>
          {error || notice}
        </div>
      )}

      <div style={styles.body}>
        <div
          ref={canvasPanelRef}
          style={{ ...styles.canvasPanel, cursor: isPanning ? 'grabbing' : 'default' }}
          onPointerDown={beginCanvasPan}
          onContextMenu={(event) => openCanvasContextMenu(event)}
          data-testid="canvas-panel"
        >
          {view === 'board' ? (
            <ModuleBoard
              modules={displayedModules}
              moduleData={bundle.modules}
              previews={bundle.module_previews}
              systemNetworks={systemNetworks}
              selectedId={activeModuleId}
              zoom={zoom}
              onSelect={setActiveModuleId}
              onOpen={openModule}
              onTogglePreview={togglePreview}
              onCopyId={copyModuleId}
              copiedId={copiedId}
              onDragStart={beginModuleDrag}
              onResizeStart={beginModuleResize}
              onContextMenu={openCanvasContextMenu}
            />
          ) : selectedRef ? (
            <ModuleSchematic
              module={selectedRef}
              svg={selectedPreview?.svg ?? ''}
              busy={busy}
              onBuild={() => buildModulePreview(selectedRef.id)}
            />
          ) : null}
        </div>

        <ModuleInspector
          module={selectedRef}
          moduleData={selectedModule}
          systemNetworks={systemNetworks}
          noteDraft={noteDraft}
          onNoteChange={setNoteDraft}
          onSaveNote={() => {
            if (!selectedRef) return;
            void applyOperations('Update module Agent note', [{
              op: 'set_module_note',
              module_id: selectedRef.id,
              notes: noteDraft,
            }]);
          }}
          onCopyId={copyModuleId}
          copied={copiedId === selectedRef?.id}
          onOpen={() => selectedRef && openModule(selectedRef.id)}
          onSimulate={runModuleSimulation}
          moduleSimulation={moduleSimulation}
          systemSimulation={build?.simulation ?? null}
          busy={busy}
        />
      </div>

      {contextMenu ? (
        <div
          style={{ ...styles.contextMenu, left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          data-testid="canvas-context-menu"
        >
          {contextMenu.moduleId ? (
            <>
              <button
                style={styles.contextMenuItem}
                onClick={() => {
                  const module = project.modules.find((entry) => entry.id === contextMenu.moduleId);
                  if (module) openEditModuleEditor(module);
                }}
                data-testid="context-edit-module"
              >
                Edit module details
              </button>
              <button
                style={styles.contextMenuItem}
                onClick={() => contextMenu.moduleId && void openModule(contextMenu.moduleId)}
              >
                Open schematic
              </button>
            </>
          ) : null}
          <button
            style={styles.contextMenuItem}
            onClick={() => openAddModuleEditor(contextMenu.boardPosition)}
            data-testid="context-add-module"
          >
            Add module here
          </button>
        </div>
      ) : null}

      {moduleEditor ? (
        <div style={styles.modalBackdrop} data-testid="module-editor">
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <div>
                <span style={styles.moduleKind}>{moduleEditor.mode === 'add' ? 'New module' : 'Edit module'}</span>
                <h2 style={styles.modalTitle}>{moduleEditor.mode === 'add' ? 'Add circuit module' : moduleEditor.id}</h2>
              </div>
              <button style={styles.modalClose} onClick={() => setModuleEditor(null)}>Close</button>
            </div>
            <label style={styles.fieldLabel}>
              Stable ID
              <input
                style={styles.fieldInput}
                value={moduleEditor.id}
                disabled={moduleEditor.mode === 'edit'}
                onChange={(event) => setModuleEditor({ ...moduleEditor, id: event.target.value })}
                data-testid="module-editor-id"
              />
            </label>
            <div style={styles.fieldGrid}>
              <label style={styles.fieldLabel}>
                Name
                <input
                  style={styles.fieldInput}
                  value={moduleEditor.name}
                  onChange={(event) => setModuleEditor({ ...moduleEditor, name: event.target.value })}
                  data-testid="module-editor-name"
                />
              </label>
              <label style={styles.fieldLabel}>
                Kind
                <input
                  style={styles.fieldInput}
                  value={moduleEditor.kind}
                  onChange={(event) => setModuleEditor({ ...moduleEditor, kind: event.target.value })}
                  data-testid="module-editor-kind"
                />
              </label>
            </div>
            <label style={styles.fieldLabel}>
              Function
              <textarea
                style={{ ...styles.fieldInput, minHeight: 74, resize: 'vertical' }}
                value={moduleEditor.functionText}
                onChange={(event) => setModuleEditor({ ...moduleEditor, functionText: event.target.value })}
                data-testid="module-editor-function"
              />
            </label>
            <label style={styles.fieldLabel}>
              Parameters, one name = value per line
              <textarea
                style={{ ...styles.fieldInput, minHeight: 100, resize: 'vertical', fontFamily: 'Consolas, monospace' }}
                value={moduleEditor.parametersText}
                onChange={(event) => setModuleEditor({ ...moduleEditor, parametersText: event.target.value })}
                data-testid="module-editor-parameters"
              />
            </label>
            {moduleEditorError ? <div style={styles.modalError}>{moduleEditorError}</div> : null}
            <div style={styles.modalActions}>
              <button style={styles.secondaryButton} onClick={() => setModuleEditor(null)}>Cancel</button>
              <button
                style={styles.primaryButton}
                onClick={() => void saveModuleEditor()}
                disabled={busy}
                data-testid="save-module-editor"
              >
                {moduleEditor.mode === 'add' ? 'Add module' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ModuleBoard({
  modules,
  moduleData,
  previews,
  systemNetworks,
  selectedId,
  zoom,
  onSelect,
  onOpen,
  onTogglePreview,
  onCopyId,
  copiedId,
  onDragStart,
  onResizeStart,
  onContextMenu,
}: {
  modules: CircuitModuleRef[];
  moduleData: Record<string, CircuitModule>;
  previews: Record<string, { svg: string }>;
  systemNetworks: SystemNetworkMap;
  selectedId: string | null;
  zoom: number;
  onSelect: (moduleId: string) => void;
  onOpen: (moduleId: string) => void;
  onTogglePreview: (module: CircuitModuleRef) => void;
  onCopyId: (moduleId: string) => void;
  copiedId: string;
  onDragStart: (event: ReactPointerEvent, module: CircuitModuleRef) => void;
  onResizeStart: (event: ReactPointerEvent, module: CircuitModuleRef) => void;
  onContextMenu: (event: ReactMouseEvent, moduleId?: string) => void;
}) {
  const boardWidth = Math.max(
    1440,
    ...modules.map((module) => module.position.x + module.size.width + 100),
  );
  const boardHeight = Math.max(
    900,
    ...modules.map((module) => module.position.y + module.size.height + 100),
  );
  const scale = zoom / 100;
  return (
    <div
      style={{
        ...styles.boardViewport,
        minWidth: boardWidth * scale,
        minHeight: boardHeight * scale,
      }}
      data-testid="system-canvas"
    >
      <div
        style={{
          ...styles.board,
          width: boardWidth,
          height: boardHeight,
          transform: `scale(${scale})`,
        }}
      >
        <div style={styles.boardGuide}>
          Drag modules anywhere | double-click to open the netlistsvg schematic
        </div>
        {modules.map((module) => (
          <ModuleCard
            key={module.id}
            module={module}
            moduleData={moduleData[module.id]}
            svg={previews[module.id]?.svg ?? ''}
            systemNetworks={systemNetworks}
            selected={selectedId === module.id}
            copied={copiedId === module.id}
            onSelect={() => onSelect(module.id)}
            onOpen={() => onOpen(module.id)}
            onTogglePreview={() => onTogglePreview(module)}
            onCopyId={() => onCopyId(module.id)}
            onDragStart={(event) => onDragStart(event, module)}
            onResizeStart={(event) => onResizeStart(event, module)}
            onContextMenu={(event) => onContextMenu(event, module.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ModuleCard({
  module,
  moduleData,
  svg,
  systemNetworks,
  selected,
  copied,
  onSelect,
  onOpen,
  onTogglePreview,
  onCopyId,
  onDragStart,
  onResizeStart,
  onContextMenu,
}: {
  module: CircuitModuleRef;
  moduleData?: CircuitModule;
  svg: string;
  systemNetworks: SystemNetworkMap;
  selected: boolean;
  copied: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onTogglePreview: () => void;
  onCopyId: () => void;
  onDragStart: (event: ReactPointerEvent) => void;
  onResizeStart: (event: ReactPointerEvent) => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const previewEnabled = module.preview_enabled ?? true;
  const interfaces = visibleInterfaces(module);
  const parameters = module.parameters && Object.keys(module.parameters).length > 0
    ? module.parameters
    : fallbackParameters(moduleData);
  return (
    <article
      style={{
        ...styles.moduleCard,
        left: module.position.x,
        top: module.position.y,
        width: module.size.width || 320,
        height: module.size.height || 250,
        ...(selected ? styles.moduleCardSelected : {}),
      }}
      onClick={(event) => {
        onSelect();
        if (event.detail === 2) onOpen();
      }}
      onPointerDown={onDragStart}
      onContextMenu={onContextMenu}
      data-testid={`module-card-${module.id}`}
    >
      <div style={styles.moduleCardHeader}>
        <div style={styles.moduleTitleGroup}>
          <span style={styles.moduleKind}>{module.kind}</span>
          <strong style={styles.moduleName}>{module.name}</strong>
        </div>
        <label style={styles.previewToggle} title="Show SVG preview on canvas">
          <input
            type="checkbox"
            checked={previewEnabled}
            onChange={(event) => {
              event.stopPropagation();
              onTogglePreview();
            }}
            data-testid={`preview-toggle-${module.id}`}
          />
          Preview
        </label>
      </div>

      {previewEnabled ? (
        <div style={styles.previewBody}>
          {svg ? (
            <div
              style={styles.svgPreview}
              dangerouslySetInnerHTML={{ __html: prepareSvg(svg) }}
              data-testid={`module-preview-${module.id}`}
            />
          ) : (
            <div style={styles.previewMissing}>
              <span>SVG preview not built</span>
              <small>Double-click to render with netlistsvg</small>
            </div>
          )}
        </div>
      ) : (
        <div style={styles.summaryBody} data-testid={`module-summary-${module.id}`}>
          <p style={styles.functionText}>{module.function || 'No function summary yet.'}</p>
          <div style={styles.parameterGrid}>
            {Object.entries(parameters).slice(0, 4).map(([name, value]) => (
              <div key={name} style={styles.parameterRow}>
                <span>{name}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={styles.interfaceStrip}>
        <InterfaceBadge moduleId={module.id} label="IN" ports={interfaces.inputs} tone="input" systemNetworks={systemNetworks} />
        <InterfaceBadge moduleId={module.id} label="OUT" ports={interfaces.outputs} tone="output" systemNetworks={systemNetworks} />
        <InterfaceBadge moduleId={module.id} label="GND" ports={interfaces.grounds} tone="ground" systemNetworks={systemNetworks} />
      </div>

      <div style={styles.cardFooter}>
        <button
          style={styles.idButton}
          onClick={(event) => {
            event.stopPropagation();
            onCopyId();
          }}
          data-testid={`copy-id-${module.id}`}
        >
          {copied ? 'Copied' : `ID: ${module.id}`}
        </button>
        <div style={styles.cardFlags}>
          {module.notes?.trim() ? <span>Agent note</span> : null}
          <span>Double-click</span>
        </div>
      </div>
      <div
        style={styles.resizeHandle}
        onPointerDown={onResizeStart}
        data-resize-handle
        data-testid={`resize-module-${module.id}`}
        title="Drag to resize module"
      />
    </article>
  );
}

function InterfaceBadge({
  moduleId,
  label,
  ports,
  tone,
  systemNetworks,
}: {
  moduleId: string;
  label: string;
  ports: CircuitPort[];
  tone: 'input' | 'output' | 'ground';
  systemNetworks: SystemNetworkMap;
}) {
  if (ports.length === 0) return null;
  const networks = interfaceNetworks(moduleId, ports, tone, systemNetworks);
  const endpoints = [...new Set(ports.flatMap((port) => (
    systemNetworks[endpointKey(moduleId, port.id)]?.endpoints ?? [`${moduleId}.${port.id}`]
  )))];
  return (
    <span
      style={{ ...styles.interfaceBadge, ...styles[`interface_${tone}`] }}
      data-testid={`interface-${tone}`}
      title={`System network endpoints: ${endpoints.join(', ')}`}
    >
      <b>{label}:</b>
      {' '}
      <span style={styles.interfaceNetworks}>{networks.join(', ')}</span>
    </span>
  );
}

function ModuleSchematic({
  module,
  svg,
  busy,
  onBuild,
}: {
  module: CircuitModuleRef;
  svg: string;
  busy: boolean;
  onBuild: () => void;
}) {
  return (
    <div style={styles.moduleViewer} data-testid="module-canvas">
      <div style={styles.moduleViewerHeader}>
        <div>
          <span style={styles.moduleKind}>{module.kind}</span>
          <h2 style={styles.moduleViewerTitle}>{module.name}</h2>
          <span style={styles.moduleViewerId}>Module ID: {module.id}</span>
        </div>
        <button style={styles.secondaryButton} onClick={onBuild} disabled={busy} data-testid="rebuild-module-svg">
          Rebuild SVG
        </button>
      </div>
      <div style={styles.fullSvgStage}>
        {svg ? (
          <div
            style={styles.fullSvg}
            dangerouslySetInnerHTML={{ __html: prepareSvg(svg) }}
            data-testid="module-netlistsvg"
          />
        ) : (
          <div style={styles.fullSvgEmpty}>
            <strong>No module SVG yet</strong>
            <span>Build the module to run the existing netlist to netlistsvg pipeline.</span>
            <button style={styles.primaryButton} onClick={onBuild} disabled={busy}>Build preview</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ModuleInspector({
  module,
  moduleData,
  systemNetworks,
  noteDraft,
  onNoteChange,
  onSaveNote,
  onCopyId,
  copied,
  onOpen,
  onSimulate,
  moduleSimulation,
  systemSimulation,
  busy,
}: {
  module: CircuitModuleRef | null;
  moduleData?: CircuitModule;
  systemNetworks: SystemNetworkMap;
  noteDraft: string;
  onNoteChange: (value: string) => void;
  onSaveNote: () => void;
  onCopyId: (moduleId: string) => void;
  copied: boolean;
  onOpen: () => void;
  onSimulate: () => void;
  moduleSimulation: {
    ok: boolean;
    module_id: string;
    metrics: Array<{ name: string; value: number; unit: string; pass: boolean }>;
  } | null;
  systemSimulation: {
    ok: boolean;
    metrics?: Array<{ name: string; value: number; unit: string; pass: boolean }>;
  } | null;
  busy: boolean;
}) {
  if (!module) {
    return (
      <aside style={styles.inspector} data-testid="circuit-inspector">
        <div style={styles.inspectorEmpty}>Select a module to inspect it.</div>
      </aside>
    );
  }
  const interfaces = visibleInterfaces(module);
  const parameters = module.parameters && Object.keys(module.parameters).length > 0
    ? module.parameters
    : fallbackParameters(moduleData);
  return (
    <aside style={styles.inspector} data-testid="circuit-inspector">
      <div style={styles.inspectorHeading}>
        <div>
          <span style={styles.moduleKind}>{module.kind}</span>
          <h2 style={styles.inspectorTitle}>{module.name}</h2>
        </div>
        <button style={styles.copyButton} onClick={() => onCopyId(module.id)} data-testid="copy-selected-module-id">
          {copied ? 'Copied' : 'Copy ID'}
        </button>
      </div>
      <code style={styles.moduleId}>{module.id}</code>

      <div style={styles.sectionTitle}>Function</div>
      <p style={styles.inspectorFunction}>{module.function || 'No function summary yet.'}</p>

      <div style={styles.sectionTitle}>Interfaces</div>
      <div style={styles.inspectorInterfaces}>
        <InterfaceBadge moduleId={module.id} label="IN" ports={interfaces.inputs} tone="input" systemNetworks={systemNetworks} />
        <InterfaceBadge moduleId={module.id} label="OUT" ports={interfaces.outputs} tone="output" systemNetworks={systemNetworks} />
        <InterfaceBadge moduleId={module.id} label="GND" ports={interfaces.grounds} tone="ground" systemNetworks={systemNetworks} />
      </div>

      <div style={styles.sectionTitle}>Parameters</div>
      <div style={styles.inspectorParameters}>
        {Object.entries(parameters).map(([name, value]) => (
          <div key={name} style={styles.inspectorParameterRow}>
            <span>{name}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <div style={styles.sectionTitle}>Agent modification note</div>
      <textarea
        value={noteDraft}
        onChange={(event) => onNoteChange(event.target.value)}
        placeholder={`Tell the Agent how to modify module "${module.id}"...`}
        style={styles.noteInput}
        data-testid="module-note"
      />
      <button
        style={styles.primaryButton}
        onClick={onSaveNote}
        disabled={busy || noteDraft === (module.notes ?? '')}
        data-testid="save-module-note"
      >
        Save note
      </button>

      <div style={styles.inspectorActions}>
        <button style={styles.secondaryButton} onClick={onOpen}>Open schematic</button>
        <button style={styles.secondaryButton} onClick={onSimulate} disabled={busy} data-testid="simulate-module">
          Simulate module
        </button>
      </div>

      {moduleSimulation ? (
        <SimulationMetrics title={`${moduleSimulation.module_id} module`} data={moduleSimulation} />
      ) : null}
      {systemSimulation ? <SimulationMetrics title="System" data={systemSimulation} /> : null}
    </aside>
  );
}

function SimulationMetrics({
  title,
  data,
}: {
  title: string;
  data: {
    ok: boolean;
    metrics?: Array<{ name: string; value: number; unit: string; pass: boolean }>;
  };
}) {
  return (
    <div style={styles.simulationBlock}>
      <div style={styles.sectionTitle}>{title} simulation</div>
      <div style={styles.simStatus}>{data.ok ? 'ngspice passed' : 'ngspice failed'}</div>
      {data.metrics?.map((metric) => (
        <div key={metric.name} style={styles.metricRow}>
          <span>{metric.name}</span>
          <strong>{Number.isFinite(metric.value) ? metric.value.toFixed(2) : '—'} {metric.unit}</strong>
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  root: { height: '100%', display: 'flex', flexDirection: 'column', background: '#f3f4f6', color: '#20242a' },
  header: {
    minHeight: 66,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 16px',
    gap: 16,
    background: '#ffffff',
    borderBottom: '1px solid #d8dce2',
  },
  titleBlock: { minWidth: 0 },
  eyebrow: { fontSize: 10, color: '#7a818b', textTransform: 'uppercase', fontWeight: 750 },
  projectTitle: { fontSize: 18, fontWeight: 760, marginTop: 2 },
  projectMeta: { fontSize: 11, color: '#7a818b', marginTop: 2 },
  toolbar: { display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' },
  zoomControl: {
    height: 32,
    display: 'flex',
    alignItems: 'center',
    border: '1px solid #cbd0d7',
    borderRadius: 6,
    overflow: 'hidden',
    background: '#fff',
  },
  zoomButton: {
    width: 28,
    height: 30,
    border: 0,
    background: '#fff',
    color: '#525b66',
    cursor: 'pointer',
    fontSize: 15,
  },
  zoomValue: {
    minWidth: 42,
    textAlign: 'center',
    color: '#525b66',
    fontSize: 11,
    borderLeft: '1px solid #e1e4e8',
    borderRight: '1px solid #e1e4e8',
  },
  primaryButton: {
    border: '1px solid #2563eb',
    borderRadius: 6,
    background: '#2563eb',
    color: '#fff',
    padding: '7px 12px',
    cursor: 'pointer',
    fontWeight: 680,
    fontSize: 12,
  },
  secondaryButton: {
    border: '1px solid #c5cbd3',
    borderRadius: 6,
    background: '#fff',
    color: '#303741',
    padding: '7px 12px',
    cursor: 'pointer',
    fontWeight: 650,
    fontSize: 12,
  },
  iconButton: {
    border: '1px solid #c5cbd3',
    borderRadius: 6,
    background: '#fff',
    color: '#525b66',
    padding: '7px 9px',
    cursor: 'pointer',
    fontSize: 11,
  },
  notice: { padding: '6px 14px', background: '#e9f7ee', color: '#23653e', borderBottom: '1px solid #c2e2ce', fontSize: 12 },
  noticeError: { background: '#fbe9e9', color: '#9c2525', borderBottomColor: '#e9b7b7' },
  body: { flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 310px' },
  canvasPanel: { overflow: 'auto', position: 'relative', background: '#f3f4f6', minWidth: 0 },
  boardViewport: { position: 'relative', padding: 20 },
  board: {
    position: 'relative',
    transformOrigin: 'top left',
    backgroundColor: '#fbfbfc',
    backgroundImage: 'radial-gradient(circle, #d7dbe0 1px, transparent 1px)',
    backgroundSize: '24px 24px',
    border: '1px solid #e0e3e8',
    boxShadow: '0 1px 3px rgba(24, 32, 44, 0.06)',
  },
  boardGuide: {
    position: 'absolute',
    top: 24,
    left: 28,
    color: '#9aa1aa',
    fontSize: 13,
    userSelect: 'none',
  },
  moduleCard: {
    position: 'absolute',
    display: 'flex',
    flexDirection: 'column',
    background: '#fff',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: '#d2d7de',
    borderRadius: 8,
    boxShadow: '0 5px 18px rgba(27, 38, 51, 0.10)',
    overflow: 'hidden',
    cursor: 'grab',
    userSelect: 'none',
    touchAction: 'none',
  },
  moduleCardSelected: {
    borderColor: '#2563eb',
    boxShadow: '0 0 0 3px rgba(37, 99, 235, 0.13), 0 8px 24px rgba(27, 38, 51, 0.12)',
  },
  moduleCardHeader: {
    minHeight: 50,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    padding: '9px 11px',
    borderBottom: '1px solid #e5e7eb',
    background: '#fff',
  },
  moduleTitleGroup: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  moduleKind: { color: '#8a929d', fontSize: 9, textTransform: 'uppercase', fontWeight: 800 },
  moduleName: { fontSize: 13, color: '#20242a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  previewToggle: { display: 'flex', alignItems: 'center', gap: 4, color: '#69727d', fontSize: 10, cursor: 'pointer' },
  previewBody: { flex: 1, minHeight: 80, padding: 9, background: '#f7f8fa' },
  svgPreview: { width: '100%', height: '100%', overflow: 'hidden', background: '#fff', border: '1px solid #e5e7eb' },
  previewMissing: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 5,
    border: '1px dashed #c7cdd5',
    color: '#77818d',
    fontSize: 12,
  },
  summaryBody: { flex: 1, minHeight: 80, padding: 12, background: '#fff', overflowY: 'auto' },
  functionText: { minHeight: 44, margin: 0, color: '#4f5965', fontSize: 11, lineHeight: 1.5 },
  parameterGrid: { marginTop: 8, borderTop: '1px solid #eceff2' },
  parameterRow: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 0', color: '#77818d', fontSize: 10 },
  interfaceStrip: { display: 'flex', gap: 5, flexWrap: 'wrap', padding: '8px 10px', borderTop: '1px solid #e8ebef' },
  interfaceBadge: { display: 'inline-flex', maxWidth: '100%', gap: 4, alignItems: 'center', borderRadius: 4, padding: '3px 6px', fontSize: 9 },
  interfaceNetworks: { minWidth: 0, overflowWrap: 'anywhere', fontFamily: 'Consolas, monospace' },
  interface_input: { background: '#eaf3ff', color: '#245a9b' },
  interface_output: { background: '#ebf7ee', color: '#2f6d40' },
  interface_ground: { background: '#f0f1f3', color: '#555f69' },
  cardFooter: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '7px 20px 7px 10px', background: '#fafbfc' },
  resizeHandle: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    width: 15,
    height: 15,
    cursor: 'nwse-resize',
    borderRight: '2px solid #8e98a4',
    borderBottom: '2px solid #8e98a4',
    borderRadius: 1,
    zIndex: 3,
    touchAction: 'none',
  },
  idButton: { border: 0, background: 'transparent', color: '#2563eb', fontFamily: 'Consolas, monospace', fontSize: 9, cursor: 'pointer', padding: 0 },
  cardFlags: { display: 'flex', gap: 7, color: '#9aa1aa', fontSize: 9 },
  inspector: { background: '#fff', borderLeft: '1px solid #d8dce2', padding: 15, overflowY: 'auto' },
  inspectorHeading: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  inspectorTitle: { margin: '3px 0 0', fontSize: 16, color: '#20242a' },
  copyButton: { border: '1px solid #cbd0d7', borderRadius: 5, background: '#fff', color: '#4e5965', padding: '5px 8px', cursor: 'pointer', fontSize: 10 },
  moduleId: { display: 'block', marginTop: 8, padding: '6px 8px', background: '#f3f5f7', color: '#2563eb', fontSize: 10, wordBreak: 'break-all' },
  sectionTitle: { margin: '18px 0 7px', color: '#7b8490', fontSize: 10, textTransform: 'uppercase', fontWeight: 800 },
  inspectorFunction: { margin: 0, color: '#4f5965', fontSize: 12, lineHeight: 1.55 },
  inspectorInterfaces: { display: 'flex', flexWrap: 'wrap', gap: 5 },
  inspectorParameters: { borderTop: '1px solid #eceff2' },
  inspectorParameterRow: { display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: '1px solid #eceff2', color: '#69727d', fontSize: 11 },
  noteInput: { width: '100%', minHeight: 110, resize: 'vertical', border: '1px solid #c8ced6', borderRadius: 6, padding: 9, color: '#303741', fontFamily: 'inherit', fontSize: 11, lineHeight: 1.5, marginBottom: 8 },
  inspectorActions: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, marginTop: 12 },
  inspectorEmpty: { color: '#8a929d', fontSize: 12, textAlign: 'center', marginTop: 80 },
  simulationBlock: { marginTop: 8 },
  simStatus: { color: '#277448', fontSize: 11, fontWeight: 750, marginBottom: 5 },
  metricRow: { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 0', fontSize: 9, borderBottom: '1px solid #eceff2' },
  moduleViewer: { minWidth: 720, minHeight: '100%', display: 'flex', flexDirection: 'column', padding: 16 },
  moduleViewerHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  moduleViewerTitle: { margin: '2px 0', fontSize: 18 },
  moduleViewerId: { color: '#7b8490', fontFamily: 'Consolas, monospace', fontSize: 10 },
  fullSvgStage: { flex: 1, minHeight: 520, display: 'flex', background: '#fff', border: '1px solid #d9dde3', boxShadow: '0 2px 8px rgba(27, 38, 51, 0.08)', overflow: 'auto' },
  fullSvg: { flex: 1, minWidth: 680, minHeight: 500, padding: 18 },
  fullSvgEmpty: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 10, color: '#7b8490', fontSize: 12 },
  contextMenu: {
    position: 'fixed',
    zIndex: 40,
    minWidth: 180,
    padding: 5,
    border: '1px solid #c8ced6',
    borderRadius: 6,
    background: '#fff',
    boxShadow: '0 10px 30px rgba(26, 35, 48, 0.20)',
  },
  contextMenuItem: {
    display: 'block',
    width: '100%',
    padding: '8px 10px',
    border: 0,
    borderRadius: 4,
    background: '#fff',
    color: '#303741',
    textAlign: 'left',
    cursor: 'pointer',
    fontSize: 11,
  },
  modalBackdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 50,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    background: 'rgba(20, 27, 38, 0.36)',
  },
  modal: {
    width: 'min(520px, 100%)',
    maxHeight: 'calc(100vh - 48px)',
    overflowY: 'auto',
    padding: 18,
    border: '1px solid #cbd0d7',
    borderRadius: 8,
    background: '#fff',
    boxShadow: '0 18px 50px rgba(20, 27, 38, 0.24)',
  },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 },
  modalTitle: { margin: '3px 0 0', color: '#20242a', fontSize: 18 },
  modalClose: { border: 0, background: 'transparent', color: '#69727d', cursor: 'pointer', fontSize: 11 },
  fieldGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 11, color: '#69727d', fontSize: 10, fontWeight: 700 },
  fieldInput: { width: '100%', border: '1px solid #c8ced6', borderRadius: 5, padding: '8px 9px', color: '#303741', background: '#fff', fontFamily: 'inherit', fontSize: 12, fontWeight: 400 },
  modalError: { marginBottom: 10, padding: '7px 9px', borderRadius: 5, background: '#fbe9e9', color: '#9c2525', fontSize: 11 },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  empty: { height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', background: '#f5f6f8', color: '#334155', padding: 32, textAlign: 'center' },
  emptyBadge: { border: '1px solid #b9c0c9', borderRadius: 5, padding: '8px 14px', fontSize: 10, fontWeight: 800, color: '#2563eb' },
  emptyTitle: { fontSize: 24, margin: '18px 0 4px' },
  emptyText: { maxWidth: 560, color: '#69727d', lineHeight: 1.6, fontSize: 13 },
  actionRow: { display: 'flex', gap: 8, marginTop: 14 },
};
