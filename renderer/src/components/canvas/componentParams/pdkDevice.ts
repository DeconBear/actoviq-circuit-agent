import type { CircuitComponent, CircuitPin } from '../../../types';
import type { ToolComponentType } from '../../../schematic/schematicDocument';
import { projectComponentValue } from './projectToValue';
import type {
  PdkDeviceCatalog,
  PdkDeviceCatalogDevice,
  PdkParameterConstraint,
} from './types';

export type PdkDeviceDiagnosticCode =
  | 'unsupported_primitive'
  | 'pin_order_missing'
  | 'model_missing'
  | 'model_library_missing'
  | 'corner_missing'
  | 'parameter_required'
  | 'parameter_unit'
  | 'parameter_range'
  | 'parameter_integer';

export interface PdkDeviceDiagnostic {
  code: PdkDeviceDiagnosticCode;
  severity: 'error' | 'warning';
  field?: string;
  message: string;
}

const TOOL_TYPES = new Set<ToolComponentType>(['R', 'C', 'L', 'D', 'M', 'Q', 'V', 'I']);
const SCALE: Record<string, number> = {
  f: 1e-15,
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  k: 1e3,
  meg: 1e6,
  g: 1e9,
  t: 1e12,
};

function constraint(value: unknown): PdkParameterConstraint {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as PdkParameterConstraint
    : {};
}

export function pdkDeviceToolType(device: PdkDeviceCatalogDevice): ToolComponentType | null {
  const primitive = String(device.spice?.primitive || '').trim().toUpperCase();
  if (TOOL_TYPES.has(primitive as ToolComponentType)) return primitive as ToolComponentType;
  const kind = String(device.kind || device.device_id).trim().toLowerCase();
  if (kind.includes('mos') || kind.includes('nfet') || kind.includes('pfet')) return 'M';
  if (kind.includes('res')) return 'R';
  if (kind.includes('cap')) return 'C';
  if (kind.includes('ind')) return 'L';
  if (kind.includes('diode')) return 'D';
  if (kind.includes('bjt') || kind.includes('npn') || kind.includes('pnp')) return 'Q';
  return null;
}

export function pdkDeviceCategory(device: PdkDeviceCatalogDevice): string {
  const type = pdkDeviceToolType(device);
  if (type === 'M') return 'MOSFET';
  if (type === 'R') return 'Resistor';
  if (type === 'C') return 'Capacitor';
  if (type === 'L') return 'Inductor';
  if (type === 'D') return 'Diode';
  if (type === 'Q') return 'BJT';
  return String(device.kind || 'Other');
}

export function pdkDeviceDefaults(
  device: PdkDeviceCatalogDevice,
  catalog: PdkDeviceCatalog,
): Record<string, string> {
  const type = pdkDeviceToolType(device);
  const defaults: Record<string, string> = {
    device_id: device.device_id,
    pdk_ref: String(catalog.pdk_ref || ''),
    model: String(device.spice?.model || ''),
    corner: String(catalog.binding?.default_corner || ''),
    symbol: String(
      device.views?.xschem_symbol
      || device.views?.generic_fallback
      || type
      || '',
    ),
    pin_order: (device.spice?.pin_order || device.pins || []).join(','),
  };
  for (const [field, rawConstraint] of Object.entries(device.parameters || {})) {
    const definition = constraint(rawConstraint);
    if (definition.default !== undefined) defaults[field] = String(definition.default);
  }
  if (type === 'M') {
    defaults.w ||= '1u';
    defaults.l ||= '180n';
    defaults.m ||= '1';
    defaults.nf ||= '1';
  }
  return defaults;
}

export function parsePdkScalar(value: string): { value: number; hasUnit: boolean } | null {
  const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([a-zA-Z]+)?\s*$/.exec(value);
  if (!match) return null;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) return null;
  const suffix = String(match[2] || '').toLowerCase();
  if (!suffix) return { value: numeric, hasUnit: false };
  const multiplier = SCALE[suffix];
  if (multiplier === undefined) return null;
  return { value: numeric * multiplier, hasUnit: true };
}

function constraintScalar(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return parsePdkScalar(String(value))?.value ?? null;
}

export function validatePdkDeviceParameters(
  device: PdkDeviceCatalogDevice,
  catalog: PdkDeviceCatalog,
  parameters: Record<string, string>,
): PdkDeviceDiagnostic[] {
  const diagnostics: PdkDeviceDiagnostic[] = [];
  if (!pdkDeviceToolType(device)) {
    diagnostics.push({
      code: 'unsupported_primitive',
      severity: 'error',
      message: `${device.device_id} has no supported schematic primitive.`,
    });
  }
  if (!(device.spice?.pin_order?.length || device.pins?.length)) {
    diagnostics.push({
      code: 'pin_order_missing',
      severity: 'error',
      message: `${device.device_id} has no verified pin order.`,
    });
  }
  if (!String(parameters.model || device.spice?.model || '').trim()) {
    diagnostics.push({
      code: 'model_missing',
      severity: 'error',
      field: 'model',
      message: `${device.device_id} has no SPICE model.`,
    });
  }
  if (catalog.binding?.model_library_available === false) {
    diagnostics.push({
      code: 'model_library_missing',
      severity: 'warning',
      field: 'model',
      message: `The registered ${catalog.pdk_ref || 'PDK'} installation has no discovered model library.`,
    });
  }
  if (!String(parameters.corner || catalog.binding?.default_corner || '').trim()) {
    diagnostics.push({
      code: 'corner_missing',
      severity: 'warning',
      field: 'corner',
      message: 'No PDK corner is selected; simulation qualification is incomplete.',
    });
  }
  for (const [field, rawConstraint] of Object.entries(device.parameters || {})) {
    const definition = constraint(rawConstraint);
    const raw = String(parameters[field] ?? '').trim();
    if (!raw) {
      if (definition.required) {
        diagnostics.push({
          code: 'parameter_required',
          severity: 'error',
          field,
          message: `${field.toUpperCase()} is required by ${device.device_id}.`,
        });
      }
      continue;
    }
    if (definition.enum?.length && !definition.enum.map(String).includes(raw)) {
      diagnostics.push({
        code: 'parameter_range',
        severity: 'error',
        field,
        message: `${field.toUpperCase()} must be one of ${definition.enum.join(', ')}.`,
      });
      continue;
    }
    const parsed = parsePdkScalar(raw);
    if (!parsed) {
      diagnostics.push({
        code: 'parameter_unit',
        severity: 'error',
        field,
        message: `${field.toUpperCase()} is not a valid SPICE number.`,
      });
      continue;
    }
    if (definition.unit && !parsed.hasUnit) {
      diagnostics.push({
        code: 'parameter_unit',
        severity: 'error',
        field,
        message: `${field.toUpperCase()} requires an explicit unit suffix.`,
      });
    }
    if (definition.integer && (!Number.isInteger(parsed.value) || parsed.hasUnit)) {
      diagnostics.push({
        code: 'parameter_integer',
        severity: 'error',
        field,
        message: `${field.toUpperCase()} must be an integer.`,
      });
    }
    const minimum = constraintScalar(definition.minimum);
    const maximum = constraintScalar(definition.maximum);
    if (
      minimum !== null
      && (definition.exclusive_minimum ? parsed.value <= minimum : parsed.value < minimum)
    ) {
      diagnostics.push({
        code: 'parameter_range',
        severity: 'error',
        field,
        message: `${field.toUpperCase()} is below the catalog minimum ${definition.minimum}.`,
      });
    }
    if (
      maximum !== null
      && (definition.exclusive_maximum ? parsed.value >= maximum : parsed.value > maximum)
    ) {
      diagnostics.push({
        code: 'parameter_range',
        severity: 'error',
        field,
        message: `${field.toUpperCase()} exceeds the catalog maximum ${definition.maximum}.`,
      });
    }
  }
  return diagnostics;
}

function catalogPins(
  component: CircuitComponent,
  device: PdkDeviceCatalogDevice,
): CircuitPin[] {
  const ordered = device.spice?.pin_order || device.pins || [];
  return ordered.map((name, index) => {
    const folded = String(name).toLowerCase();
    const existing = component.pins.find((pin) => (
      pin.id.toLowerCase() === folded || pin.name.toLowerCase() === folded
    ));
    return existing ? {
      ...existing,
      id: folded,
      name: String(name),
      order: index,
    } : {
      id: folded,
      name: String(name),
      net: `n_${component.id}_${index + 1}`,
      order: index,
    };
  });
}

export function applyPdkDeviceToComponent(
  component: CircuitComponent,
  device: PdkDeviceCatalogDevice,
  catalog: PdkDeviceCatalog,
  parameters: Record<string, string>,
): CircuitComponent {
  const type = pdkDeviceToolType(device);
  if (!type) return component;
  const nextParameters = {
    ...pdkDeviceDefaults(device, catalog),
    ...parameters,
    device_id: device.device_id,
    pdk_ref: String(catalog.pdk_ref || ''),
    model: String(parameters.model || device.spice?.model || ''),
  };
  return {
    ...component,
    type,
    pins: catalogPins(component, device),
    parameters: nextParameters,
    value: projectComponentValue(type, nextParameters, component.value),
  };
}
