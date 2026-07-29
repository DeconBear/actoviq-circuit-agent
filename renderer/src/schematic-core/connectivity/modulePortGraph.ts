import type { CircuitConnection, CircuitModuleRef, CircuitPort } from '../../types';

export interface SystemNetwork {
  id: string;
  label: string;
  endpoints: string[];
  net_ids: string[];
}

export type SystemNetworkMap = Record<string, SystemNetwork>;

export function modulePortEndpointKey(moduleId: string, portId: string): string {
  return `${moduleId}::${portId}`;
}

function isGround(port: CircuitPort): boolean {
  const value = `${port.name} ${port.net}`.toLowerCase();
  return port.signal_type === 'ground' || /(?:^|\s)[adp]?gnd(?:\s|$)/.test(value);
}

export function resolveSystemNetworks(
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
      const key = modulePortEndpointKey(module.id, port.id);
      ports.set(key, { moduleId: module.id, port });
      find(key);
    }
  }
  for (const connection of connections) {
    union(
      modulePortEndpointKey(connection.from.module_id, connection.from.port_id),
      modulePortEndpointKey(connection.to.module_id, connection.to.port_id),
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
    const root = find(modulePortEndpointKey(connection.from.module_id, connection.from.port_id));
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
    const network: SystemNetwork = {
      id: root,
      label,
      endpoints,
      net_ids: [...new Set(members.map(({ port }) => port.net_id).filter((id): id is string => Boolean(id)))],
    };
    for (const member of members) resolved[member.key] = network;
  }
  return resolved;
}
