import type { CircuitWire, CircuitWireEndpoint } from '../../types';

function endpointKey(endpoint: CircuitWireEndpoint | undefined): string {
  if (!endpoint) return '';
  if (endpoint.component_id && endpoint.pin_id) {
    return `pin:${endpoint.component_id}.${endpoint.pin_id}`;
  }
  if (endpoint.port_id) return `port:${endpoint.port_id}`;
  if (endpoint.junction_id) return `junction:${endpoint.junction_id}`;
  return '';
}

function netKey(wire: CircuitWire): string {
  return wire.net_id ?? wire.net ?? '';
}

export function netWireIds(wires: CircuitWire[], wireId: string): string[] {
  const source = wires.find((wire) => wire.id === wireId);
  if (!source) return [];
  const sourceNet = netKey(source);
  if (!sourceNet) return [source.id];
  return wires
    .filter((wire) => netKey(wire) === sourceNet)
    .map((wire) => wire.id)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Return the non-branching chain that contains wireId.
 *
 * Traversal continues only through an identified electrical node with exactly
 * two same-net incident wires. Pins, ports, crossings without a junction, and
 * junctions with three or more incident wires are branch boundaries.
 */
export function branchWireIds(wires: CircuitWire[], wireId: string): string[] {
  const source = wires.find((wire) => wire.id === wireId);
  if (!source) return [];
  const sourceNet = netKey(source);
  if (!sourceNet) return [source.id];
  const sameNet = wires.filter((wire) => netKey(wire) === sourceNet);
  const incident = new Map<string, string[]>();
  for (const wire of sameNet) {
    for (const key of [endpointKey(wire.from), endpointKey(wire.to)]) {
      if (!key) continue;
      incident.set(key, [...(incident.get(key) ?? []), wire.id]);
    }
  }
  const selected = new Set([source.id]);
  const pending = [source.id];
  while (pending.length > 0) {
    const currentId = pending.pop()!;
    const current = sameNet.find((wire) => wire.id === currentId);
    if (!current) continue;
    for (const key of [endpointKey(current.from), endpointKey(current.to)]) {
      if (!key) continue;
      const candidates = incident.get(key) ?? [];
      if (candidates.length !== 2) continue;
      for (const candidateId of candidates) {
        if (selected.has(candidateId)) continue;
        selected.add(candidateId);
        pending.push(candidateId);
      }
    }
  }
  return [...selected].sort((left, right) => left.localeCompare(right));
}

export type WireSelectionScope = 'item' | 'branch' | 'net';

export function wireSelectionScope(
  wires: CircuitWire[],
  selectedWireIds: string[],
): WireSelectionScope {
  if (selectedWireIds.length <= 1) return 'item';
  const selected = new Set(selectedWireIds);
  const sourceId = selectedWireIds[0];
  if (!sourceId) return 'item';
  const netIds = netWireIds(wires, sourceId);
  if (netIds.length === selected.size && netIds.every((id) => selected.has(id))) {
    return 'net';
  }
  const branchIds = branchWireIds(wires, sourceId);
  if (branchIds.length === selected.size && branchIds.every((id) => selected.has(id))) {
    return 'branch';
  }
  return 'item';
}
