import type { CircuitModule } from '../../types';

export type SchematicSearchResultKind = 'module' | 'component' | 'module_instance' | 'net' | 'model';

export interface SchematicSearchResult {
  id: string;
  moduleId: string;
  kind: SchematicSearchResultKind;
  entityId?: string;
  net?: string;
  netId?: string;
  title: string;
  subtitle: string;
}

function includes(value: unknown, needle: string): boolean {
  return String(value || '').toLowerCase().includes(needle);
}

export function searchProjectSchematic(
  modules: Record<string, CircuitModule>,
  query: string,
  limit = 60,
): SchematicSearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const results: SchematicSearchResult[] = [];
  const push = (result: SchematicSearchResult) => {
    if (results.length < limit) results.push(result);
  };

  for (const module of Object.values(modules).sort((left, right) => (
    left.module_id.localeCompare(right.module_id)
  ))) {
    if (includes(module.module_id, needle) || includes(module.name, needle)) {
      push({
        id: `module:${module.module_id}`,
        moduleId: module.module_id,
        kind: 'module',
        title: module.name || module.module_id,
        subtitle: `Module · ${module.module_id}`,
      });
    }
    for (const component of module.components) {
      const model = component.parameters?.model || '';
      const childModule = component.module_ref?.module_id || '';
      const baseMatch = [component.id, component.name, component.value].some((value) => includes(value, needle));
      const modelMatch = includes(model, needle);
      const childMatch = component.type === 'MODULE' && includes(childModule, needle);
      if (!baseMatch && !modelMatch && !childMatch) continue;
      const kind: SchematicSearchResultKind = component.type === 'MODULE'
        ? 'module_instance'
        : modelMatch ? 'model' : 'component';
      push({
        id: `${kind}:${module.module_id}:${component.id}`,
        moduleId: module.module_id,
        kind,
        entityId: component.id,
        title: `${component.name} · ${component.value}`,
        subtitle: (
          kind === 'module_instance'
            ? `Instance → ${childModule}`
            : kind === 'model'
              ? `Model ${model}`
              : `${component.type} · ${component.id}`
        ),
      });
    }

    const nets = new Map<string, { name: string; id?: string }>();
    for (const net of module.nets || []) {
      nets.set(net.id || net.name, { name: net.name, id: net.id });
    }
    for (const port of module.ports) {
      nets.set(port.net_id || port.net, { name: port.net, id: port.net_id });
    }
    for (const component of module.components) {
      for (const pin of component.pins) {
        nets.set(pin.net_id || pin.net, { name: pin.net, id: pin.net_id });
      }
    }
    for (const wire of module.wires || []) {
      if (wire.net) nets.set(wire.net_id || wire.net, { name: wire.net, id: wire.net_id });
    }
    for (const [key, net] of nets) {
      if (!includes(net.name, needle) && !includes(net.id, needle)) continue;
      push({
        id: `net:${module.module_id}:${key}`,
        moduleId: module.module_id,
        kind: 'net',
        entityId: key,
        net: net.name,
        netId: net.id,
        title: net.name || net.id || key,
        subtitle: `Net · ${module.name || module.module_id}`,
      });
    }
  }
  return results;
}
