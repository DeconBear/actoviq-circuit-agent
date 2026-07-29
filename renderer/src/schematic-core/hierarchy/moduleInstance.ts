import type {
  CircuitComponent,
  CircuitModule,
  CircuitParameterDef,
  CircuitPort,
} from '../../types';
import { portsToSymbolGeometry } from '../../schematic/schematicDocument';

export type ModuleInstanceDiagnosticCode =
  | 'child_module_missing'
  | 'module_revision_mismatch'
  | 'module_port_missing'
  | 'module_pin_extra';

export interface ModuleInstanceDiagnostic {
  code: ModuleInstanceDiagnosticCode;
  severity: 'error' | 'warning';
  message: string;
  pin_id?: string;
}

export interface ModulePortMapEntry {
  pin_id: string;
  pin_name: string;
  parent_net: string;
  child_net: string;
  child_port: CircuitPort;
}

type ChildModuleContract = Pick<
  CircuitModule,
  'module_id' | 'name' | 'revision' | 'ports' | 'parameter_defs'
>;

export function inspectModuleInstance(
  instance: CircuitComponent,
  child: ChildModuleContract | undefined,
): {
  diagnostics: ModuleInstanceDiagnostic[];
  portMap: ModulePortMapEntry[];
  upToDate: boolean;
} {
  if (instance.type !== 'MODULE') {
    return {
      diagnostics: [{
        code: 'child_module_missing',
        severity: 'error',
        message: `${instance.name} is not a module instance.`,
      }],
      portMap: [],
      upToDate: false,
    };
  }
  if (!child) {
    const moduleId = instance.module_ref?.module_id || instance.value;
    return {
      diagnostics: [{
        code: 'child_module_missing',
        severity: 'error',
        message: `Child module ${moduleId} is unavailable in this project.`,
      }],
      portMap: [],
      upToDate: false,
    };
  }

  const diagnostics: ModuleInstanceDiagnostic[] = [];
  if (instance.module_ref?.revision !== child.revision) {
    diagnostics.push({
      code: 'module_revision_mismatch',
      severity: 'warning',
      message: (
        `${instance.name} binds ${child.module_id} revision `
        + `${instance.module_ref?.revision ?? 'unknown'}, current revision is ${child.revision}.`
      ),
    });
  }
  const pins = new Map(instance.pins.map((pin) => [pin.id, pin]));
  const ports = new Map(child.ports.map((port) => [port.id, port]));
  for (const port of child.ports) {
    if (!pins.has(port.id)) {
      diagnostics.push({
        code: 'module_port_missing',
        severity: 'error',
        pin_id: port.id,
        message: `${instance.name} is missing child port ${port.name || port.id}.`,
      });
    }
  }
  for (const pin of instance.pins) {
    if (!ports.has(pin.id)) {
      diagnostics.push({
        code: 'module_pin_extra',
        severity: 'warning',
        pin_id: pin.id,
        message: `${instance.name} has stale pin ${pin.name || pin.id}.`,
      });
    }
  }
  const portMap = child.ports.flatMap((port) => {
    const pin = pins.get(port.id);
    return pin ? [{
      pin_id: pin.id,
      pin_name: pin.name,
      parent_net: pin.net,
      child_net: port.net,
      child_port: port,
    }] : [];
  });
  return {
    diagnostics,
    portMap,
    upToDate: diagnostics.length === 0,
  };
}

export function refreshModuleInstanceBinding(
  instance: CircuitComponent,
  child: ChildModuleContract,
): CircuitComponent {
  const geometry = portsToSymbolGeometry(child.ports);
  const existingPins = new Map(instance.pins.map((pin) => [pin.id, pin]));
  const parameters = { ...(instance.parameters ?? {}) };
  for (const definition of child.parameter_defs ?? []) {
    if (definition.id && parameters[definition.id] === undefined) {
      parameters[definition.id] = definition.default;
    }
  }
  return {
    ...instance,
    value: child.module_id,
    pins: geometry.pins.map((pin) => {
      const existing = existingPins.get(pin.id);
      return existing ? {
        ...pin,
        net: existing.net,
        net_id: existing.net_id,
        no_connect: existing.no_connect,
      } : {
        ...pin,
        net: `n_${instance.id}_${pin.id}`,
        net_id: undefined,
      };
    }),
    block: geometry.block,
    module_ref: {
      module_id: child.module_id,
      revision: child.revision,
    },
    parameters,
  };
}

export function missingRequiredParameters(
  instance: CircuitComponent,
  definitions: CircuitParameterDef[] | undefined,
): string[] {
  const parameters = instance.parameters ?? {};
  return (definitions ?? [])
    .filter((definition) => !String(parameters[definition.id] ?? definition.default ?? '').trim())
    .map((definition) => definition.id);
}
