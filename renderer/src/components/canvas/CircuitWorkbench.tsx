import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent as ReactUIEvent,
} from 'react';
import { useAppStore } from '../../store/appStore';
import type {
  CircuitCommand,
  CircuitConnection,
  DesignMemoryItem,
  CircuitModule,
  CircuitModuleRef,
  CircuitPort,
  SchematicOverrides,
} from '../../types';
import { SchematicEditor } from './SchematicEditor';
import { SchematicDocumentSvg } from '../../schematic/SchematicDocumentSvg';
import { createSchematicDocument } from '../../schematic/schematicDocument';

interface Props {
  onCreateProject: (demo: boolean, name: string) => Promise<void>;
  onCreateProjectFromTemplate: (templateId: string, defaultName: string) => Promise<void>;
  onReloadProject: () => Promise<void>;
  onReferencesChanged?: () => Promise<void>;
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

interface EmptyProjectFormState {
  demo: boolean;
  name: string;
}

function commandId(): string {
  return `gui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampCanvasZoom(value: number): number {
  return Math.max(35, Math.min(160, value));
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, button, [contenteditable="true"]'));
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

function sanitizeSpiceToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'node';
}

function componentSpiceName(moduleId: string, component: CircuitModule['components'][number]): string {
  let name = sanitizeSpiceToken(`${moduleId}_${component.name}`);
  if (!name.toUpperCase().startsWith(component.type)) {
    name = `${component.type}${name}`;
  }
  return name;
}

function moduleToSpiceNetlist(moduleId: string, moduleData: CircuitModule): string {
  const lines = [
    `* ${moduleData.name}`,
    '* Editable schematic netlist generated from actoviq.module.v1',
  ];
  for (const component of moduleData.components) {
    const nodes = component.pins.map((pin) => sanitizeSpiceToken(pin.net || `n_${component.id}_${pin.id}`));
    lines.push([
      componentSpiceName(moduleId, component),
      ...nodes,
      component.value.trim() || '1',
    ].join(' '));
  }
  lines.push('.end');
  return `${lines.join('\n')}\n`;
}

function moduleNotebookMarkdown(moduleId: string, moduleData: CircuitModule): string {
  return [
    `# ${moduleData.name}`,
    '',
    'Editable schematic source. Applying schematic edits rewrites this SPICE block and refreshes the netlistsvg preview.',
    '',
    '```spice',
    moduleToSpiceNetlist(moduleId, moduleData).trim(),
    '```',
    '',
  ].join('\n');
}

export function CircuitWorkbench({
  onCreateProject,
  onCreateProjectFromTemplate,
  onReloadProject,
  onReferencesChanged,
}: Props) {
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
  const [spacePanActive, setSpacePanActive] = useState(false);
  const [canvasScroll, setCanvasScroll] = useState({ left: 0, top: 0 });
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    moduleId?: string;
    boardPosition: { x: number; y: number };
  } | null>(null);
  const [moduleEditor, setModuleEditor] = useState<ModuleEditorState | null>(null);
  const [moduleEditorError, setModuleEditorError] = useState('');
  const [emptyProjectForm, setEmptyProjectForm] = useState<EmptyProjectFormState | null>(null);
  const canvasPanelRef = useRef<HTMLDivElement | null>(null);
  const [modulePreviewPositions, setModulePreviewPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [modulePreviewSizes, setModulePreviewSizes] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const [modulePreviewBusy, setModulePreviewBusy] = useState<Record<string, boolean>>({});
  const modulePreviewBusyRef = useRef<Set<string>>(new Set());
  const [moduleSimulation, setModuleSimulation] = useState<{
    ok: boolean;
    module_id: string;
    metrics: Array<{ name: string; value: number | null; unit: string; pass: boolean }>;
  } | null>(null);
  const [designMemory, setDesignMemory] = useState<{
    templates: DesignMemoryItem[];
    flows: DesignMemoryItem[];
  }>({ templates: [], flows: [] });
  const [designMemoryLoading, setDesignMemoryLoading] = useState(false);

  const project = bundle?.project ?? null;
  const currentProjectId = project?.project_id ?? activeProjectId;
  const systemNetworks = useMemo(
    () => resolveSystemNetworks(project?.modules ?? [], project?.connections ?? []),
    [project],
  );
  const selectedRef = project?.modules.find((module) => module.id === activeModuleId) ?? null;
  const selectedModule = activeModuleId ? bundle?.modules[activeModuleId] : undefined;
  const selectedPreview = activeModuleId ? bundle?.module_previews[activeModuleId] : undefined;
  const selectedPreviewBusy = activeModuleId ? Boolean(modulePreviewBusy[activeModuleId]) : false;
  const anyPreviewBusy = Object.keys(modulePreviewBusy).length > 0;

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
    setModulePreviewBusy({});
    modulePreviewBusyRef.current = new Set();
  }, [activeProjectId]);

  const refreshDesignMemory = useCallback(async () => {
    setDesignMemoryLoading(true);
    try {
      setDesignMemory(await window.electronAPI.listCircuitDesignMemory());
    } catch {
      setDesignMemory({ templates: [], flows: [] });
    } finally {
      setDesignMemoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshDesignMemory();
  }, [refreshDesignMemory, activeProjectId]);

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
    if (!project || !currentProjectId) return false;
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
      await window.electronAPI.applyCircuitCommand(currentProjectId, command);
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

  function setModulePreviewBuildBusy(moduleId: string, value: boolean) {
    const next = new Set(modulePreviewBusyRef.current);
    if (value) {
      next.add(moduleId);
    } else {
      next.delete(moduleId);
    }
    modulePreviewBusyRef.current = next;
    setModulePreviewBusy(Object.fromEntries([...next].map((id) => [id, true])));
  }

  async function waitForModulePreviewBuilds(): Promise<boolean> {
    const deadline = Date.now() + 60_000;
    while (modulePreviewBusyRef.current.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return modulePreviewBusyRef.current.size === 0;
  }

  async function buildModulePreview(moduleId: string, showNotice = true): Promise<boolean> {
    if (!currentProjectId) return false;
    if (modulePreviewBusyRef.current.has(moduleId)) return false;
    setModulePreviewBuildBusy(moduleId, true);
    setError('');
    if (showNotice) setNotice('Rendering module with netlistsvg...');
    try {
      const result = await window.electronAPI.compileCircuitModule(currentProjectId, moduleId);
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
      setModulePreviewBuildBusy(moduleId, false);
    }
  }

  async function moveSchematicItem(moduleId: string, itemId: string, x: number, y: number): Promise<void> {
    const saved = await applyOperations(`Move schematic item ${itemId}`, [{
      op: 'move_schematic_item',
      module_id: moduleId,
      item_id: itemId,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
    }]);
    if (saved) {
      await buildModulePreview(moduleId, false);
      setNotice(`Moved ${itemId}`);
    }
  }

  async function resetSchematicItem(moduleId: string, itemId: string): Promise<void> {
    const saved = await applyOperations(`Reset schematic item ${itemId}`, [{
      op: 'reset_schematic_item',
      module_id: moduleId,
      item_id: itemId,
    }]);
    if (saved) {
      await buildModulePreview(moduleId, false);
      setNotice(`Reset ${itemId}`);
    }
  }

  async function resetSchematicLayout(moduleId: string, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) {
      setNotice('No schematic layout overrides to reset');
      return;
    }
    const saved = await applyOperations('Reset schematic layout', itemIds.map((itemId) => ({
      op: 'reset_schematic_item',
      module_id: moduleId,
      item_id: itemId,
    })));
    if (saved) {
      await buildModulePreview(moduleId, false);
      setNotice('Reset schematic layout');
    }
  }

  async function saveModuleSchematic(moduleId: string, moduleData: CircuitModule): Promise<void> {
    if (!currentProjectId) return;
    const saved = await applyOperations(`Edit schematic ${moduleId}`, [{
      op: 'set_module_schematic',
      module_id: moduleId,
      components: moduleData.components,
      ports: moduleData.ports,
      wires: moduleData.wires ?? [],
      annotations: moduleData.annotations ?? [],
    }]);
    if (saved) {
      setBusy(true);
      setError('');
      setNotice('Applying schematic netlist and rebuilding SVG...');
      try {
        const result = await window.electronAPI.saveCircuitModuleNotebook(
          currentProjectId,
          moduleId,
          moduleNotebookMarkdown(moduleId, moduleData),
        );
        if (!result.render.ok) {
          throw new Error(result.render.error || 'netlistsvg could not render the applied schematic netlist.');
        }
        await onReloadProject();
        setNotice('Applied netlist and SVG rebuilt');
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : String(saveError));
        setNotice('');
      } finally {
        setBusy(false);
      }
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
    if (!currentProjectId || !project) return;
    if (!(await waitForModulePreviewBuilds())) {
      setError('Timed out waiting for module preview build to finish.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice(simulate ? 'Running system simulation...' : 'Building netlist and module SVG previews...');
    try {
      // Project compile assembles the system netlist and refreshes every module
      // SVG before returning, so the manifest never exposes a half-built module set.
      await window.electronAPI.compileCircuitProject(currentProjectId);
      if (simulate) {
        await window.electronAPI.simulateCircuitProject(currentProjectId);
      }
      setBuild(await window.electronAPI.readCircuitBuild(currentProjectId));
      await onReloadProject();
      setNotice(simulate ? 'System simulation complete' : 'Netlist and previews updated');
    } catch (buildError) {
      setError(buildError instanceof Error ? buildError.message : String(buildError));
      setNotice('');
    } finally {
      setBusy(false);
    }
  }

  async function saveDesignMemory(kind: 'template' | 'flow') {
    if (!currentProjectId) return;
    if (!(await waitForModulePreviewBuilds())) {
      setError('Timed out waiting for module preview build to finish.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice(kind === 'template' ? 'Saving reusable design template...' : 'Saving design flow...');
    try {
      if (kind === 'template') {
        await window.electronAPI.compileCircuitProject(currentProjectId);
        setBuild(await window.electronAPI.readCircuitBuild(currentProjectId));
        await onReloadProject();
      }
      const result = kind === 'template'
        ? await window.electronAPI.saveCircuitDesignTemplate(currentProjectId)
        : await window.electronAPI.saveCircuitDesignFlow(currentProjectId);
      await refreshDesignMemory();
      await onReferencesChanged?.();
      setNotice(
        kind === 'template'
          ? `Saved template ${result.id}`
          : `Saved flow ${result.id}`,
      );
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      setNotice('');
    } finally {
      setBusy(false);
    }
  }

  async function openDesignMemoryItem(kind: 'template' | 'flow', id: string): Promise<void> {
    setError('');
    try {
      const result = await window.electronAPI.openCircuitDesignMemory({ kind, id });
      if (result) throw new Error(result);
      setNotice(`Opened ${kind} ${id}`);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    }
  }

  async function openProjectFolder(): Promise<void> {
    if (!currentProjectId) return;
    setError('');
    setNotice('');
    try {
      const openedPath = await window.electronAPI.openCircuitProjectFolder(currentProjectId);
      setNotice(`Opened project folder: ${openedPath}`);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    }
  }

  async function createProjectFromSavedTemplate(template: DesignMemoryItem): Promise<void> {
    setError('');
    try {
      await onCreateProjectFromTemplate(template.id, `${template.name} copy`);
      await refreshDesignMemory();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  async function runModuleSimulation() {
    if (!currentProjectId || !activeModuleId) return;
    setBusy(true);
    setError('');
    setNotice('Running module testbench...');
    try {
      const result = await window.electronAPI.simulateCircuitModule(currentProjectId, activeModuleId);
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
    if (event.altKey || spacePanActive) return;
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
    const nextZoom = clampCanvasZoom(zoom + (event.deltaY < 0 ? 10 : -10));
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

  function zoomCanvasAtPanelCenter(nextZoom: number) {
    const panel = canvasPanelRef.current;
    const clampedZoom = clampCanvasZoom(nextZoom);
    if (!panel || clampedZoom === zoom) return;
    const oldScale = zoom / 100;
    const rect = panel.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const boardX = (panel.scrollLeft + centerX) / oldScale;
    const boardY = (panel.scrollTop + centerY) / oldScale;
    setZoom(clampedZoom);
    window.requestAnimationFrame(() => {
      const nextScale = clampedZoom / 100;
      panel.scrollLeft = boardX * nextScale - centerX;
      panel.scrollTop = boardY * nextScale - centerY;
      setCanvasScroll({ left: panel.scrollLeft, top: panel.scrollTop });
    });
  }

  function resetCanvasView() {
    setZoom(65);
    const panel = canvasPanelRef.current;
    if (!panel) return;
    window.requestAnimationFrame(() => {
      panel.scrollLeft = 0;
      panel.scrollTop = 0;
      setCanvasScroll({ left: 0, top: 0 });
    });
  }

  function handleCanvasKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (view !== 'board' || isEditableTarget(event.target)) return;
    if (event.key === ' ') {
      event.preventDefault();
      setSpacePanActive(true);
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomCanvasAtPanelCenter(zoom + 10);
      return;
    }
    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomCanvasAtPanelCenter(zoom - 10);
      return;
    }
    if (event.key === 'Home' || event.key === '0') {
      event.preventDefault();
      resetCanvasView();
    }
  }

  function handleCanvasKeyUp(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === ' ') {
      event.preventDefault();
      setSpacePanActive(false);
    }
  }

  function handleCanvasScroll(event: ReactUIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    setCanvasScroll({ left: target.scrollLeft, top: target.scrollTop });
  }

  function beginCanvasPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (view !== 'board') return;
    const leftTemporaryPan = event.button === 0 && (event.altKey || spacePanActive);
    if (event.button !== 1 && !leftTemporaryPan) return;
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
      setCanvasScroll({ left: panel.scrollLeft, top: panel.scrollTop });
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

  async function createProjectFromEmptyState() {
    if (!emptyProjectForm) return;
    const name = emptyProjectForm.name.trim();
    if (!name || busy) return;
    setError('');
    setNotice('');
    try {
      await onCreateProject(emptyProjectForm.demo, name);
      setEmptyProjectForm(null);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    }
  }

  function handleEmptyProjectFormKeyDown(event: ReactKeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void createProjectFromEmptyState();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setEmptyProjectForm(null);
    }
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
          <button
            style={styles.primaryButton}
            onClick={() => {
              setError('');
              setNotice('');
              setEmptyProjectForm({ demo: true, name: 'Modular analog chain' });
            }}
            disabled={busy}
            data-testid="create-demo-project"
          >
            Create three-module demo
          </button>
          <button
            style={styles.secondaryButton}
            onClick={() => {
              setError('');
              setNotice('');
              setEmptyProjectForm({ demo: false, name: 'New circuit project' });
            }}
            disabled={busy}
            data-testid="create-blank-project"
          >
            Create blank project
          </button>
        </div>
        {emptyProjectForm ? (
          <div
            style={styles.emptyCreatePanel}
            data-testid="empty-project-create-panel"
            onKeyDown={handleEmptyProjectFormKeyDown}
          >
            <div style={styles.emptyCreateTitle}>
              {emptyProjectForm.demo ? 'Demo project' : 'Blank project'}
            </div>
            <input
              value={emptyProjectForm.name}
              onChange={(event) => setEmptyProjectForm({ ...emptyProjectForm, name: event.target.value })}
              placeholder="Project name"
              style={styles.emptyProjectInput}
              disabled={busy}
              autoFocus
              data-testid="empty-project-name-input"
            />
            <div style={styles.emptyCreateActions}>
              <button
                type="button"
                style={styles.secondaryButton}
                onClick={() => setEmptyProjectForm(null)}
                disabled={busy}
                data-testid="empty-project-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                style={styles.primaryButton}
                onClick={() => void createProjectFromEmptyState()}
                disabled={busy || !emptyProjectForm.name.trim()}
                data-testid="empty-project-create-submit"
              >
                Create
              </button>
            </div>
          </div>
        ) : null}
        {error ? (
          <div style={{ ...styles.emptyNotice, ...styles.noticeError }} role="alert">
            {error}
          </div>
        ) : null}
      </div>
    );
  }

  const displayedModules = project.modules.map((module) => ({
    ...module,
    position: modulePreviewPositions[module.id] ?? module.position,
    size: modulePreviewSizes[module.id] ?? module.size,
  }));

  return (
    <div
      style={styles.root}
      data-testid="circuit-workbench"
      data-project-id={project.project_id}
      data-action-project-id={currentProjectId ?? ''}
    >
      <header style={styles.header}>
        <div style={styles.titleBlock}>
          <div style={styles.eyebrow}>Schematic Module Hub</div>
          <div style={styles.projectTitle} data-testid="project-title" data-project-id={project.project_id}>
            {project.name}
          </div>
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
                  onClick={() => setZoom((value) => clampCanvasZoom(value - 10))}
                  title="Zoom out"
                >
                  -
                </button>
                <span style={styles.zoomValue} data-testid="canvas-zoom">{zoom}%</span>
                <button
                  style={styles.zoomButton}
                  onClick={() => setZoom((value) => clampCanvasZoom(value + 10))}
                  title="Zoom in"
                >
                  +
                </button>
              </div>
            </>
          )}
          <button style={styles.secondaryButton} onClick={() => runBuild(false)} disabled={busy || anyPreviewBusy} data-testid="build-project">
            Refresh SVGs
          </button>
          <button style={styles.primaryButton} onClick={() => runBuild(true)} disabled={busy || anyPreviewBusy} data-testid="simulate-project">
            Simulate system
          </button>
          <button
            style={styles.secondaryButton}
            onClick={() => saveDesignMemory('template')}
            disabled={busy || anyPreviewBusy}
            data-testid="save-design-template"
          >
            Save template
          </button>
          <button
            style={styles.secondaryButton}
            onClick={() => saveDesignMemory('flow')}
            disabled={busy || anyPreviewBusy}
            data-testid="save-design-flow"
          >
            Save flow
          </button>
          <button
            style={styles.iconButton}
            onClick={() => { void openProjectFolder(); }}
            title="Open project folder"
            data-testid="open-project-folder"
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
          style={{ ...styles.canvasPanel, cursor: isPanning ? 'grabbing' : spacePanActive ? 'grab' : 'default' }}
          onPointerDown={beginCanvasPan}
          onKeyDown={handleCanvasKeyDown}
          onKeyUp={handleCanvasKeyUp}
          onBlur={() => setSpacePanActive(false)}
          onScroll={handleCanvasScroll}
          onContextMenu={(event) => openCanvasContextMenu(event)}
          tabIndex={0}
          data-testid="canvas-panel"
          data-canvas-zoom={zoom}
          data-space-pan={spacePanActive ? 'true' : 'false'}
          data-panning={isPanning ? 'true' : 'false'}
          data-canvas-scroll={JSON.stringify(canvasScroll)}
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
              moduleData={selectedModule}
              svg={selectedPreview?.svg ?? ''}
              overrides={selectedPreview?.schematicOverrides}
              busy={busy}
              previewBusy={selectedPreviewBusy}
              onBuild={() => buildModulePreview(selectedRef.id)}
              onSaveSchematic={(moduleData) => saveModuleSchematic(selectedRef.id, moduleData)}
              onMoveItem={(itemId, x, y) => moveSchematicItem(selectedRef.id, itemId, x, y)}
              onResetItem={(itemId) => resetSchematicItem(selectedRef.id, itemId)}
              onResetLayout={(itemIds) => resetSchematicLayout(selectedRef.id, itemIds)}
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
          designMemory={designMemory}
          designMemoryLoading={designMemoryLoading}
          onRefreshDesignMemory={refreshDesignMemory}
          onOpenDesignMemory={openDesignMemoryItem}
          onCreateProjectFromTemplate={createProjectFromSavedTemplate}
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
  const schematicDocument = useMemo(
    () => moduleData ? createSchematicDocument(moduleData) : null,
    [moduleData],
  );
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
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => {
              event.stopPropagation();
              onTogglePreview();
            }}
            onClick={(event) => event.stopPropagation()}
            readOnly
            data-testid={`preview-toggle-${module.id}`}
          />
          Preview
        </label>
      </div>

      {previewEnabled ? (
        <div style={styles.previewBody}>
          {schematicDocument ? (
            <div
              style={styles.svgPreview}
              data-testid={`module-preview-${module.id}`}
              data-schematic-source="document"
            >
              <SchematicDocumentSvg
                document={schematicDocument}
                testId={`module-preview-document-svg-${module.id}`}
              />
            </div>
          ) : svg ? (
            <div
              style={styles.svgPreview}
              dangerouslySetInnerHTML={{ __html: prepareSvg(svg) }}
              data-testid={`module-preview-${module.id}`}
              data-schematic-source="netlistsvg"
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
  moduleData,
  svg,
  overrides,
  busy,
  previewBusy,
  onBuild,
  onSaveSchematic,
  onMoveItem,
  onResetItem,
  onResetLayout,
}: {
  module: CircuitModuleRef;
  moduleData?: CircuitModule;
  svg: string;
  overrides?: SchematicOverrides;
  busy: boolean;
  previewBusy: boolean;
  onBuild: () => void;
  onSaveSchematic: (moduleData: CircuitModule) => Promise<void>;
  onMoveItem: (itemId: string, x: number, y: number) => Promise<void>;
  onResetItem: (itemId: string) => Promise<void>;
  onResetLayout: (itemIds: string[]) => Promise<void>;
}) {
  const [viewMode, setViewMode] = useState<'editor' | 'svg'>('editor');
  const [editLayout, setEditLayout] = useState(false);
  const [draggedItem, setDraggedItem] = useState('');
  const [selectedItem, setSelectedItem] = useState('');
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [undoStack, setUndoStack] = useState<Array<{
    itemId: string;
    from: { x: number; y: number; overridden: boolean };
    to: { x: number; y: number };
  }>>([]);
  const [redoStack, setRedoStack] = useState<Array<{
    itemId: string;
    from: { x: number; y: number; overridden: boolean };
    to: { x: number; y: number };
  }>>([]);
  const svgContainerRef = useRef<HTMLDivElement | null>(null);
  const editLayoutRef = useRef(editLayout);
  const busyRef = useRef(busy);
  const onMoveItemRef = useRef(onMoveItem);
  const onResetItemRef = useRef(onResetItem);
  const selectedItemRef = useRef(selectedItem);
  const snapToGridRef = useRef(snapToGrid);
  const overridesRef = useRef(overrides);
  const nativeDragHandlersRef = useRef<{
    node: HTMLDivElement;
    pointerDown: (event: PointerEvent) => void;
    mouseDown: (event: MouseEvent) => void;
  } | null>(null);
  const dragRef = useRef<{
    itemId: string;
    group: SVGGElement;
    startClient: { x: number; y: number };
    origin: { x: number; y: number };
    scale: { x: number; y: number };
    fromOverride?: { x: number; y: number };
  } | null>(null);

  editLayoutRef.current = editLayout;
  busyRef.current = busy;
  onMoveItemRef.current = onMoveItem;
  onResetItemRef.current = onResetItem;
  selectedItemRef.current = selectedItem;
  snapToGridRef.current = snapToGrid;
  overridesRef.current = overrides;

  const overrideItems = useMemo(
    () => Object.entries(overrides?.items ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    [overrides],
  );
  const selectedOverride = selectedItem ? overrides?.items[selectedItem] : undefined;
  const schematicDocument = useMemo(
    () => moduleData ? createSchematicDocument(moduleData) : null,
    [moduleData],
  );

  useEffect(() => {
    if (!moduleData && viewMode === 'editor') setViewMode('svg');
  }, [moduleData, viewMode]);

  function svgClientDeltaScale(svgElement: SVGSVGElement): { x: number; y: number } {
    const matrix = svgElement.getScreenCTM();
    if (!matrix) return { x: 1, y: 1 };
    const scaleX = Math.hypot(matrix.a, matrix.b);
    const scaleY = Math.hypot(matrix.c, matrix.d);
    return {
      x: scaleX > 0 ? 1 / scaleX : 1,
      y: scaleY > 0 ? 1 / scaleY : 1,
    };
  }

  function parseSvgTranslate(transform: string | null): { x: number; y: number } | null {
    const match = /translate\(\s*([-+]?\d*\.?\d+)\s*,\s*([-+]?\d*\.?\d+)\s*\)/.exec(transform ?? '');
    if (!match) return null;
    return { x: Number.parseFloat(match[1] ?? '0'), y: Number.parseFloat(match[2] ?? '0') };
  }

  function snapPosition(position: { x: number; y: number }): { x: number; y: number } {
    if (!snapToGridRef.current) return position;
    return {
      x: Math.round(position.x / 10) * 10,
      y: Math.round(position.y / 10) * 10,
    };
  }

  function groupForItem(itemId: string): SVGGElement | null {
    const container = svgContainerRef.current;
    return container?.querySelector(`svg #cell_${CSS.escape(itemId)}`) as SVGGElement | null;
  }

  function currentItemPosition(itemId: string): { x: number; y: number } | null {
    return parseSvgTranslate(groupForItem(itemId)?.getAttribute('transform') ?? null);
  }

  function findSchematicCellGroup(
    target: Element | null,
    container: HTMLDivElement,
    clientX: number,
    clientY: number,
  ): SVGGElement | null {
    const directGroup = target?.closest('g[id^="cell_"]') as SVGGElement | null;
    if (directGroup) return directGroup;

    const groups = Array.from(container.querySelectorAll('svg g[id^="cell_"]')) as SVGGElement[];
    let best: { group: SVGGElement; distance: number } | null = null;
    const padding = 8;
    for (const group of groups) {
      const rect = group.getBoundingClientRect();
      if (
        clientX < rect.left - padding ||
        clientX > rect.right + padding ||
        clientY < rect.top - padding ||
        clientY > rect.bottom + padding
      ) {
        continue;
      }
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const distance = (clientX - centerX) ** 2 + (clientY - centerY) ** 2;
      if (!best || distance < best.distance) best = { group, distance };
    }
    return best?.group ?? null;
  }

  function beginSchematicItemDrag(event: PointerEvent | MouseEvent, container: HTMLDivElement) {
    if (!editLayoutRef.current || busyRef.current || event.button !== 0) return;
    if (dragRef.current) return;
    const target = event.target instanceof Element ? event.target : null;
    const group = findSchematicCellGroup(target, container, event.clientX, event.clientY);
    const svgElement = group?.ownerSVGElement;
    if (!group || !svgElement) return;
    const cellId = group.id.replace(/^cell_/, '');
    const origin = parseSvgTranslate(group.getAttribute('transform'));
    if (!cellId || !origin) return;

    event.preventDefault();
    event.stopPropagation();
    const scale = svgClientDeltaScale(svgElement);
    const fromOverride = overridesRef.current?.items?.[cellId];
    dragRef.current = {
      itemId: cellId,
      group,
      startClient: { x: event.clientX, y: event.clientY },
      origin,
      scale,
      fromOverride,
    };
    setDraggedItem(cellId);
    setSelectedItem(cellId);

    const isPointerDrag = 'pointerId' in event;
    const moveEventName = isPointerDrag ? 'pointermove' : 'mousemove';
    const upEventName = isPointerDrag ? 'pointerup' : 'mouseup';
    let moved = false;
    const move = (moveEvent: PointerEvent | MouseEvent) => {
      const current = dragRef.current;
      if (!current) return;
      if (!moved && Math.abs(moveEvent.clientX - current.startClient.x) + Math.abs(moveEvent.clientY - current.startClient.y) < 4) return;
      moved = true;
      const next = snapPosition({
        x: current.origin.x + (moveEvent.clientX - current.startClient.x) * current.scale.x,
        y: current.origin.y + (moveEvent.clientY - current.startClient.y) * current.scale.y,
      });
      const nextX = next.x;
      const nextY = next.y;
      current.group.setAttribute('transform', `translate(${nextX.toFixed(3)},${nextY.toFixed(3)})`);
    };
    const up = (upEvent: PointerEvent | MouseEvent) => {
      window.removeEventListener(moveEventName, move as EventListener);
      window.removeEventListener(upEventName, up as EventListener);
      const current = dragRef.current;
      dragRef.current = null;
      if (!current) {
        setDraggedItem('');
        return;
      }
      if (!moved) {
        setDraggedItem('');
        return;
      }
      const next = snapPosition({
        x: current.origin.x + (upEvent.clientX - current.startClient.x) * current.scale.x,
        y: current.origin.y + (upEvent.clientY - current.startClient.y) * current.scale.y,
      });
      const nextX = next.x;
      const nextY = next.y;
      current.group.setAttribute('transform', `translate(${nextX.toFixed(3)},${nextY.toFixed(3)})`);
      setDraggedItem('');
      setUndoStack((currentStack) => [
        ...currentStack,
        {
          itemId: current.itemId,
          from: current.fromOverride
            ? { x: current.fromOverride.x, y: current.fromOverride.y, overridden: true }
            : { x: current.origin.x, y: current.origin.y, overridden: false },
          to: { x: nextX, y: nextY },
        },
      ].slice(-30));
      setRedoStack([]);
      void onMoveItemRef.current(current.itemId, nextX, nextY);
    };
    window.addEventListener(moveEventName, move as EventListener);
    window.addEventListener(upEventName, up as EventListener, { once: true });
  }

  async function moveSelectedItem(dx: number, dy: number): Promise<void> {
    if (!selectedItem || busy) return;
    const currentPosition = currentItemPosition(selectedItem);
    if (!currentPosition) return;
    const fromOverride = overrides?.items[selectedItem];
    const next = snapPosition({ x: currentPosition.x + dx, y: currentPosition.y + dy });
    groupForItem(selectedItem)?.setAttribute('transform', `translate(${next.x.toFixed(3)},${next.y.toFixed(3)})`);
    setUndoStack((currentStack) => [
      ...currentStack,
      {
        itemId: selectedItem,
        from: fromOverride
          ? { x: fromOverride.x, y: fromOverride.y, overridden: true }
          : { x: currentPosition.x, y: currentPosition.y, overridden: false },
        to: next,
      },
    ].slice(-30));
    setRedoStack([]);
    await onMoveItem(selectedItem, next.x, next.y);
  }

  async function undoLayoutMove(): Promise<void> {
    const entry = undoStack.at(-1);
    if (!entry || busy) return;
    setUndoStack((currentStack) => currentStack.slice(0, -1));
    setRedoStack((currentStack) => [...currentStack, entry].slice(-30));
    setSelectedItem(entry.itemId);
    if (entry.from.overridden) {
      await onMoveItem(entry.itemId, entry.from.x, entry.from.y);
    } else {
      await onResetItem(entry.itemId);
    }
  }

  async function redoLayoutMove(): Promise<void> {
    const entry = redoStack.at(-1);
    if (!entry || busy) return;
    setRedoStack((currentStack) => currentStack.slice(0, -1));
    setUndoStack((currentStack) => [...currentStack, entry].slice(-30));
    setSelectedItem(entry.itemId);
    await onMoveItem(entry.itemId, entry.to.x, entry.to.y);
  }

  async function resetSelectedItem(): Promise<void> {
    if (!selectedItem || busy) return;
    await onResetItem(selectedItem);
    setSelectedItem('');
    setUndoStack([]);
    setRedoStack([]);
  }

  async function resetAllItems(): Promise<void> {
    if (busy || overrideItems.length === 0) return;
    await onResetLayout(overrideItems.map(([itemId]) => itemId));
    setSelectedItem('');
    setUndoStack([]);
    setRedoStack([]);
  }

  const setSvgContainer = useCallback((node: HTMLDivElement | null) => {
    const existing = nativeDragHandlersRef.current;
    if (existing) {
      existing.node.removeEventListener('pointerdown', existing.pointerDown, true);
      existing.node.removeEventListener('mousedown', existing.mouseDown, true);
      nativeDragHandlersRef.current = null;
    }
    svgContainerRef.current = node;
    if (!node) return;

    const pointerDown = (event: PointerEvent) => beginSchematicItemDrag(event, node);
    const mouseDown = (event: MouseEvent) => beginSchematicItemDrag(event, node);
    node.addEventListener('pointerdown', pointerDown, true);
    node.addEventListener('mousedown', mouseDown, true);
    nativeDragHandlersRef.current = { node, pointerDown, mouseDown };
  }, []);

  useEffect(() => {
    const container = svgContainerRef.current;
    if (!container) return;
    const groups = Array.from(container.querySelectorAll('svg g[id^="cell_"]')) as SVGGElement[];
    for (const group of groups) {
      group.style.filter = '';
      group.style.cursor = editLayout ? 'move' : '';
      group.removeAttribute('data-actoviq-selected');
    }
    if (!selectedItem) return;
    const selected = groupForItem(selectedItem);
    if (!selected) return;
    selected.style.filter = 'drop-shadow(0 0 3px rgba(37, 99, 235, 0.95))';
    selected.setAttribute('data-actoviq-selected', 'true');
  }, [editLayout, selectedItem, svg]);

  useEffect(() => {
    if (selectedItem && svgContainerRef.current && !groupForItem(selectedItem)) {
      setSelectedItem('');
    }
  }, [selectedItem, svg]);

  return (
    <div style={styles.moduleViewer} data-testid="module-canvas" data-preview-busy={previewBusy ? 'true' : 'false'}>
      <div style={styles.moduleViewerHeader}>
        <div>
          <span style={styles.moduleKind}>{module.kind}</span>
          <h2 style={styles.moduleViewerTitle}>{module.name}</h2>
          <span style={styles.moduleViewerId}>Module ID: {module.id}</span>
        </div>
        <div style={styles.moduleViewerActions}>
          <button
            style={viewMode === 'editor' ? styles.primaryButton : styles.secondaryButton}
            onClick={() => {
              setViewMode('editor');
              setEditLayout(false);
            }}
            disabled={busy || !moduleData}
            data-testid="schematic-editor-tab"
          >
            Editable model
          </button>
          <button
            style={viewMode === 'svg' ? styles.primaryButton : styles.secondaryButton}
            onClick={() => setViewMode('svg')}
            disabled={busy}
            data-testid="schematic-svg-tab"
          >
            SVG
          </button>
          <button
            style={styles.secondaryButton}
            onClick={onBuild}
            disabled={busy || previewBusy}
            title="Refresh the legacy netlistsvg build artifact used by compile/export checks."
            data-testid="rebuild-module-svg"
          >
            {previewBusy ? 'Building netlistsvg' : 'Build netlistsvg'}
          </button>
        </div>
      </div>
      {viewMode === 'svg' && editLayout ? (
        <div style={styles.layoutToolbar} data-testid="schematic-layout-tools">
          <label style={styles.layoutCheck}>
            <input
              type="checkbox"
              checked={snapToGrid}
              onChange={(event) => setSnapToGrid(event.target.checked)}
              data-testid="schematic-snap-toggle"
            />
            Snap 10px
          </label>
          <button
            style={styles.secondaryButton}
            onClick={() => void undoLayoutMove()}
            disabled={busy || undoStack.length === 0}
            data-testid="schematic-undo"
          >
            Undo
          </button>
          <button
            style={styles.secondaryButton}
            onClick={() => void redoLayoutMove()}
            disabled={busy || redoStack.length === 0}
            data-testid="schematic-redo"
          >
            Redo
          </button>
          <button
            style={styles.secondaryButton}
            onClick={() => void resetSelectedItem()}
            disabled={busy || !selectedOverride}
            data-testid="schematic-reset-selected"
          >
            Reset selected
          </button>
          <button
            style={styles.secondaryButton}
            onClick={() => void resetAllItems()}
            disabled={busy || overrideItems.length === 0}
            data-testid="schematic-reset-all"
          >
            Reset all
          </button>
          <div style={styles.layoutNudgeGroup} data-testid="schematic-nudge-controls">
            <button style={styles.nudgeButton} onClick={() => void moveSelectedItem(0, -10)} disabled={busy || !selectedItem} title="Nudge up" data-testid="schematic-nudge-up">↑</button>
            <button style={styles.nudgeButton} onClick={() => void moveSelectedItem(-10, 0)} disabled={busy || !selectedItem} title="Nudge left" data-testid="schematic-nudge-left">←</button>
            <button style={styles.nudgeButton} onClick={() => void moveSelectedItem(10, 0)} disabled={busy || !selectedItem} title="Nudge right" data-testid="schematic-nudge-right">→</button>
            <button style={styles.nudgeButton} onClick={() => void moveSelectedItem(0, 10)} disabled={busy || !selectedItem} title="Nudge down" data-testid="schematic-nudge-down">↓</button>
          </div>
          <span style={styles.layoutSelectedText} data-testid="schematic-selected-item">
            {selectedItem ? `${selectedItem}${selectedOverride ? ` @ ${selectedOverride.x}, ${selectedOverride.y}` : ''}` : 'Select a symbol'}
          </span>
        </div>
      ) : null}
      <div style={styles.fullSvgStage}>
        {viewMode === 'editor' && moduleData ? (
          <SchematicEditor
            module={moduleData}
            busy={busy}
            buildBusy={previewBusy}
            onSave={onSaveSchematic}
            onBuild={onBuild}
          />
        ) : schematicDocument ? (
          <div
            style={styles.documentSvgPanel}
            data-testid="module-netlistsvg"
            data-schematic-source="document"
          >
            <SchematicDocumentSvg
              document={schematicDocument}
              testId="module-document-svg"
            />
          </div>
        ) : svg ? (
          <>
            <div
              style={{
                ...styles.fullSvg,
                ...(editLayout ? styles.fullSvgEditing : {}),
              }}
              ref={setSvgContainer}
              dangerouslySetInnerHTML={{ __html: prepareSvg(svg) }}
              data-testid="module-netlistsvg"
              data-layout-editing={editLayout ? 'true' : 'false'}
              data-dragged-item={draggedItem}
            />
            {editLayout ? (
              <aside style={styles.overridePanel} data-testid="schematic-overrides-panel">
                <div style={styles.overridePanelTitle}>Overrides</div>
                {overrideItems.length === 0 ? (
                  <div style={styles.overrideEmpty}>No layout overrides yet.</div>
                ) : overrideItems.map(([itemId, item]) => (
                  <div
                    key={itemId}
                    style={{
                      ...styles.overrideItem,
                      ...(selectedItem === itemId ? styles.overrideItemSelected : {}),
                    }}
                    data-testid={`schematic-override-${itemId}`}
                  >
                    <button
                      style={styles.overrideSelectButton}
                      onClick={() => setSelectedItem(itemId)}
                      data-testid={`select-schematic-override-${itemId}`}
                    >
                      <strong>{itemId}</strong>
                      <span>{item.x}, {item.y}</span>
                    </button>
                    <button
                      style={styles.memoryRefreshButton}
                      onClick={() => void onResetItem(itemId)}
                      disabled={busy}
                      data-testid={`reset-schematic-override-${itemId}`}
                    >
                      Reset
                    </button>
                  </div>
                ))}
              </aside>
            ) : null}
          </>
        ) : (
          <div style={styles.fullSvgEmpty}>
            <strong>No module SVG yet</strong>
            <span>Build the module to run the existing netlist to netlistsvg pipeline.</span>
            <button style={styles.primaryButton} onClick={onBuild} disabled={busy || previewBusy}>
              {previewBusy ? 'Building preview' : 'Build preview'}
            </button>
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
  designMemory,
  designMemoryLoading,
  onRefreshDesignMemory,
  onOpenDesignMemory,
  onCreateProjectFromTemplate,
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
    metrics: Array<{ name: string; value: number | null; unit: string; pass: boolean }>;
  } | null;
  systemSimulation: {
    ok: boolean;
    metrics?: Array<{ name: string; value: number | null; unit: string; pass: boolean }>;
  } | null;
  designMemory: { templates: DesignMemoryItem[]; flows: DesignMemoryItem[] };
  designMemoryLoading: boolean;
  onRefreshDesignMemory: () => void;
  onOpenDesignMemory: (kind: 'template' | 'flow', id: string) => Promise<void>;
  onCreateProjectFromTemplate: (template: DesignMemoryItem) => Promise<void>;
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

      <DesignMemoryPanel
        memory={designMemory}
        loading={designMemoryLoading}
        onRefresh={onRefreshDesignMemory}
        onOpen={onOpenDesignMemory}
        onUseTemplate={onCreateProjectFromTemplate}
      />

      {moduleSimulation ? (
        <SimulationMetrics title={`${moduleSimulation.module_id} module`} data={moduleSimulation} />
      ) : null}
      {systemSimulation ? <SimulationMetrics title="System" data={systemSimulation} /> : null}
    </aside>
  );
}

function formatMemoryDate(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function DesignMemoryPanel({
  memory,
  loading,
  onRefresh,
  onOpen,
  onUseTemplate,
}: {
  memory: { templates: DesignMemoryItem[]; flows: DesignMemoryItem[] };
  loading: boolean;
  onRefresh: () => void;
  onOpen: (kind: 'template' | 'flow', id: string) => Promise<void>;
  onUseTemplate: (template: DesignMemoryItem) => Promise<void>;
}) {
  const templates = memory.templates.slice(0, 4);
  const flows = memory.flows.slice(0, 4);
  return (
    <div style={styles.memoryPanel} data-testid="design-memory-panel">
      <div style={styles.memoryHeader}>
        <div style={styles.sectionTitle}>Design memory</div>
        <button
          style={styles.memoryRefreshButton}
          onClick={onRefresh}
          disabled={loading}
          data-testid="refresh-design-memory"
        >
          {loading ? '...' : 'Refresh'}
        </button>
      </div>
      <MemoryList
        title="Templates"
        items={templates}
        empty="No saved templates yet."
        onOpen={onOpen}
        onUseTemplate={onUseTemplate}
      />
      <MemoryList
        title="Flows"
        items={flows}
        empty="No saved flows yet."
        onOpen={onOpen}
        onUseTemplate={onUseTemplate}
      />
    </div>
  );
}

function MemoryList({
  title,
  items,
  empty,
  onOpen,
  onUseTemplate,
}: {
  title: string;
  items: DesignMemoryItem[];
  empty: string;
  onOpen: (kind: 'template' | 'flow', id: string) => Promise<void>;
  onUseTemplate: (template: DesignMemoryItem) => Promise<void>;
}) {
  return (
    <div style={styles.memoryGroup}>
      <div style={styles.memoryGroupTitle}>{title}</div>
      {items.length === 0 ? (
        <div style={styles.memoryEmpty}>{empty}</div>
      ) : items.map((item) => (
        <div
          key={`${item.kind}-${item.id}`}
          style={styles.memoryItem}
          data-testid={`design-memory-${item.kind}-${item.id}`}
        >
          <div style={styles.memoryItemTop}>
            <strong style={styles.memoryName}>{item.name}</strong>
            <span style={styles.memoryDate}>{formatMemoryDate(item.createdAt)}</span>
          </div>
          <code style={styles.memoryPath}>{item.relativePath}</code>
          <div style={styles.memoryMeta}>
            {item.sourceRevision !== undefined ? `rev ${item.sourceRevision}` : item.id}
          </div>
          <div style={styles.memoryActions}>
            {item.kind === 'template' ? (
              <button
                style={styles.memoryActionButton}
                onClick={() => void onUseTemplate(item)}
                data-testid={`use-design-memory-template-${item.id}`}
              >
                Use
              </button>
            ) : null}
            <button
              style={styles.memoryActionButton}
              onClick={() => void onOpen(item.kind, item.id)}
              data-testid={`open-design-memory-${item.kind}-${item.id}`}
            >
              Open
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function SimulationMetrics({
  title,
  data,
}: {
  title: string;
  data: {
    ok: boolean;
    metrics?: Array<{ name: string; value: number | null; unit: string; pass: boolean }>;
  };
}) {
  return (
    <div style={styles.simulationBlock}>
      <div style={styles.sectionTitle}>{title} simulation</div>
      <div style={styles.simStatus}>{data.ok ? 'ngspice passed' : 'ngspice failed'}</div>
      {data.metrics?.map((metric) => (
        <div key={metric.name} style={styles.metricRow}>
          <span>{metric.name}</span>
          <strong>{typeof metric.value === 'number' ? metric.value.toFixed(2) : '—'} {metric.unit}</strong>
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
  noticeError: { background: '#fbe9e9', color: '#9c2525', borderBottom: '1px solid #e9b7b7' },
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
  memoryPanel: { marginTop: 12, borderTop: '1px solid #eceff2', paddingTop: 2 },
  memoryHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  memoryRefreshButton: {
    border: '1px solid #cbd0d7',
    borderRadius: 5,
    background: '#fff',
    color: '#4e5965',
    padding: '4px 7px',
    cursor: 'pointer',
    fontSize: 10,
  },
  memoryGroup: { marginTop: 8 },
  memoryGroupTitle: { color: '#69727d', fontSize: 10, fontWeight: 760, marginBottom: 6 },
  memoryEmpty: { color: '#9aa1aa', fontSize: 10, padding: '5px 0' },
  memoryItem: {
    padding: '7px 0',
    borderTop: '1px solid #eef1f4',
  },
  memoryItemTop: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' },
  memoryName: { minWidth: 0, color: '#303741', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  memoryDate: { flexShrink: 0, color: '#8a929d', fontSize: 9 },
  memoryPath: { display: 'block', marginTop: 4, color: '#2563eb', fontSize: 9, overflowWrap: 'anywhere' },
  memoryMeta: { marginTop: 3, color: '#7b8490', fontSize: 9 },
  memoryActions: { display: 'flex', gap: 6, marginTop: 6 },
  memoryActionButton: {
    border: '1px solid #cbd0d7',
    borderRadius: 5,
    background: '#fff',
    color: '#303741',
    padding: '4px 7px',
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 700,
  },
  moduleViewer: { minWidth: 720, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column', padding: 16, boxSizing: 'border-box' },
  moduleViewerHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  moduleViewerActions: { display: 'flex', alignItems: 'center', gap: 8 },
  moduleViewerTitle: { margin: '2px 0', fontSize: 18 },
  moduleViewerId: { color: '#7b8490', fontFamily: 'Consolas, monospace', fontSize: 10 },
  layoutToolbar: {
    minHeight: 40,
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
    padding: '7px 9px',
    border: '1px solid #d7dce3',
    borderRadius: 6,
    background: '#fff',
  },
  layoutCheck: { display: 'inline-flex', alignItems: 'center', gap: 6, color: '#4e5965', fontSize: 11, fontWeight: 700 },
  layoutNudgeGroup: { display: 'inline-flex', alignItems: 'center', gap: 4 },
  nudgeButton: {
    width: 30,
    height: 30,
    border: '1px solid #c5cbd3',
    borderRadius: 5,
    background: '#fff',
    color: '#303741',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 800,
  },
  layoutSelectedText: { minWidth: 160, color: '#69727d', fontFamily: 'Consolas, monospace', fontSize: 10, overflowWrap: 'anywhere' },
  fullSvgStage: { flex: 1, minHeight: 0, display: 'flex', background: '#fff', border: '1px solid #d9dde3', boxShadow: '0 2px 8px rgba(27, 38, 51, 0.08)', overflow: 'auto' },
  fullSvg: { flex: 1, minWidth: 680, minHeight: 500, padding: 18 },
  documentSvgPanel: { flex: 1, minWidth: 0, minHeight: 0, height: '100%', padding: 18, boxSizing: 'border-box' },
  fullSvgEditing: { outline: '2px solid rgba(37, 99, 235, 0.32)', outlineOffset: -2, cursor: 'move', touchAction: 'none' },
  fullSvgEmpty: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 10, color: '#7b8490', fontSize: 12 },
  overridePanel: {
    flex: '0 0 260px',
    minWidth: 220,
    maxWidth: 300,
    borderLeft: '1px solid #d9dde3',
    background: '#fbfcfd',
    padding: 12,
    overflowY: 'auto',
  },
  overridePanelTitle: { color: '#7b8490', fontSize: 10, textTransform: 'uppercase', fontWeight: 800, marginBottom: 8 },
  overrideEmpty: { color: '#8a929d', fontSize: 11, padding: '8px 0' },
  overrideItem: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: 7,
    padding: '7px 0',
    borderTop: '1px solid #edf0f3',
  },
  overrideItemSelected: { background: '#edf5ff' },
  overrideSelectButton: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    border: 0,
    background: 'transparent',
    color: '#303741',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: 'Consolas, monospace',
    fontSize: 10,
    overflow: 'hidden',
  },
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
  emptyCreatePanel: {
    width: 'min(420px, 100%)',
    marginTop: 14,
    padding: 12,
    border: '1px solid #d8dee8',
    borderRadius: 6,
    background: '#fff',
    boxShadow: '0 6px 18px rgba(27, 38, 51, 0.08)',
    display: 'grid',
    gap: 10,
  },
  emptyCreateTitle: { color: '#4f5965', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', textAlign: 'left' },
  emptyProjectInput: { width: '100%', border: '1px solid #c8ced6', borderRadius: 5, padding: '8px 9px', color: '#303741', background: '#fff', fontFamily: 'inherit', fontSize: 12, fontWeight: 400 },
  emptyCreateActions: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
  emptyNotice: { width: 'min(420px, 100%)', marginTop: 10, padding: '7px 9px', borderRadius: 5, fontSize: 11, textAlign: 'left' },
  actionRow: { display: 'flex', gap: 8, marginTop: 14 },
};
