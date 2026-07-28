import type { CircuitComponent } from '../../../types';

const KV_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/;

export function mergeParameters(
  current: Record<string, string> | undefined,
  patch: Record<string, string | undefined>,
): Record<string, string> {
  const next: Record<string, string> = { ...(current || {}) };
  for (const [key, value] of Object.entries(patch)) {
    const trimmed = (value ?? '').trim();
    if (!trimmed) delete next[key];
    else next[key] = trimmed;
  }
  return next;
}

export function projectComponentValue(
  type: CircuitComponent['type'],
  parameters: Record<string, string> | undefined,
  fallbackValue = '',
): string {
  const params = parameters || {};
  switch (type) {
    case 'R':
    case 'C':
    case 'L':
    case 'D':
    case 'Q':
      return (params.magnitude || fallbackValue || '').trim();
    case 'M': {
      const model = (params.model || 'NMOS').trim();
      const parts = [model];
      if (params.w) parts.push(`W=${params.w}`);
      if (params.l) parts.push(`L=${params.l}`);
      if (params.m) parts.push(`M=${params.m}`);
      if (params.nf) parts.push(`NF=${params.nf}`);
      return parts.join(' ');
    }
    case 'V':
    case 'I': {
      if (params.pulse_v1 || params.pulse_v2 || params.pulse_pw) {
        const args = [
          params.pulse_v1 || '0',
          params.pulse_v2 || '1',
          params.pulse_td || '0',
          params.pulse_tr || '1n',
          params.pulse_tf || '1n',
          params.pulse_pw || '1u',
          params.pulse_per || '2u',
        ];
        return `PULSE(${args.join(' ')})`;
      }
      if (params.dc) return `DC ${params.dc}`;
      return (fallbackValue || 'DC 1').trim();
    }
    default:
      return (fallbackValue || params.magnitude || '').trim();
  }
}

export function parseComponentValue(
  type: CircuitComponent['type'],
  value: string,
): Record<string, string> {
  const text = String(value || '').trim();
  if (!text) return {};
  switch (type) {
    case 'R':
    case 'C':
    case 'L':
    case 'D':
    case 'Q':
      return { magnitude: text };
    case 'M': {
      const tokens = text.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
      const next: Record<string, string> = {};
      const first = tokens[0] || '';
      if (first && !first.includes('=')) next.model = first;
      for (const token of tokens.slice(first && !first.includes('=') ? 1 : 0)) {
        const match = KV_RE.exec(token);
        if (!match) continue;
        const key = match[1].toLowerCase();
        if (key === 'w') next.w = match[2];
        else if (key === 'l') next.l = match[2];
        else if (key === 'm') next.m = match[2];
        else if (key === 'nf') next.nf = match[2];
      }
      if (!next.model) next.model = 'NMOS';
      return next;
    }
    case 'V':
    case 'I': {
      const pulse = /^PULSE\s*\((.*)\)\s*$/i.exec(text);
      if (pulse) {
        const args = pulse[1].trim().split(/\s+/).filter(Boolean);
        return {
          pulse_v1: args[0] || '0',
          pulse_v2: args[1] || '1',
          pulse_td: args[2] || '0',
          pulse_tr: args[3] || '1n',
          pulse_tf: args[4] || '1n',
          pulse_pw: args[5] || '1u',
          pulse_per: args[6] || '2u',
        };
      }
      const dc = /^DC\s+(.+)$/i.exec(text);
      if (dc) return { dc: dc[1].trim() };
      return { dc: text };
    }
    default:
      return { magnitude: text };
  }
}

export function defaultParametersForType(type: CircuitComponent['type']): Record<string, string> {
  switch (type) {
    case 'R':
      return { magnitude: '1k' };
    case 'C':
      return { magnitude: '1n' };
    case 'L':
      return { magnitude: '1u' };
    case 'D':
      return { magnitude: 'D' };
    case 'Q':
      return { magnitude: 'NPN' };
    case 'M':
      return { model: 'NMOS', w: '1u', l: '180n', m: '1', nf: '1' };
    case 'V':
      return { dc: '1' };
    case 'I':
      return { dc: '1m' };
    default:
      return {};
  }
}

export function patchElectricalParameters(
  component: CircuitComponent,
  patch: Record<string, string | undefined>,
): Partial<CircuitComponent> {
  const parameters = mergeParameters(component.parameters, patch);
  const value = projectComponentValue(component.type, parameters, component.value);
  return { parameters, value };
}
