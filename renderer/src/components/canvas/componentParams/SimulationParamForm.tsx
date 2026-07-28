import type { CSSProperties, ReactNode } from 'react';
import type { CircuitComponent } from '../../../types';
import type { ComponentParamFormProps } from './types';
import { parseComponentValue, patchElectricalParameters } from './projectToValue';

function Field({
  label,
  children,
  style,
}: {
  label: string;
  children: ReactNode;
  style: CSSProperties;
}) {
  return (
    <label style={style}>
      {label}
      {children}
    </label>
  );
}

function RawValueEditor({
  component,
  busy,
  fieldLabelStyle,
  inputStyle,
  onPatch,
}: {
  component: CircuitComponent;
  busy: boolean;
  fieldLabelStyle: CSSProperties;
  inputStyle: CSSProperties;
  onPatch: ComponentParamFormProps['onPatch'];
}) {
  return (
    <details style={{ marginTop: 4 }} data-testid="schematic-param-raw-value">
      <summary style={{ cursor: 'pointer', fontSize: 12, color: '#536172', marginBottom: 6 }}>
        Raw value / SPICE tail
      </summary>
        <Field label="Value" style={fieldLabelStyle}>
          <input
            style={inputStyle}
            value={component.value}
            disabled={busy}
            data-testid="schematic-param-raw-value-input"
            onChange={(event) => {
              const value = event.target.value;
              const parsed = parseComponentValue(component.type, value);
              onPatch({
                value,
                parameters: { ...(component.parameters || {}), ...parsed },
              });
            }}
          />
        </Field>
    </details>
  );
}

export function SimulationParamForm({
  component,
  busy,
  fieldLabelStyle,
  inputStyle,
  onPatch,
}: ComponentParamFormProps) {
  const params = component.parameters || {};
  const setParam = (key: string, value: string) => {
    onPatch(patchElectricalParameters(component, { [key]: value }));
  };

  if (component.type === 'R' || component.type === 'C' || component.type === 'L' || component.type === 'D' || component.type === 'Q') {
    const label = component.type === 'R' ? 'Resistance'
      : component.type === 'C' ? 'Capacitance'
        : component.type === 'L' ? 'Inductance'
          : component.type === 'D' ? 'Diode model' : 'BJT model';
    return (
      <>
        <Field label={label} style={fieldLabelStyle}>
          <input
            style={inputStyle}
            value={params.magnitude ?? component.value}
            disabled={busy}
            data-testid="schematic-param-magnitude"
            onChange={(event) => setParam('magnitude', event.target.value)}
          />
        </Field>
        <RawValueEditor
          component={component}
          busy={busy}
          fieldLabelStyle={fieldLabelStyle}
          inputStyle={inputStyle}
          onPatch={onPatch}
        />
      </>
    );
  }

  if (component.type === 'M') {
    return (
      <>
        <Field label="Model" style={fieldLabelStyle}>
          <select
            style={inputStyle}
            value={params.model || 'NMOS'}
            disabled={busy}
            data-testid="schematic-param-model"
            onChange={(event) => setParam('model', event.target.value)}
          >
            <option value="NMOS">NMOS</option>
            <option value="PMOS">PMOS</option>
          </select>
        </Field>
        <Field label="W" style={fieldLabelStyle}>
          <input
            style={inputStyle}
            value={params.w || ''}
            disabled={busy}
            placeholder="e.g. 100u"
            data-testid="schematic-param-w"
            onChange={(event) => setParam('w', event.target.value)}
          />
        </Field>
        <Field label="L" style={fieldLabelStyle}>
          <input
            style={inputStyle}
            value={params.l || ''}
            disabled={busy}
            placeholder="e.g. 1u"
            data-testid="schematic-param-l"
            onChange={(event) => setParam('l', event.target.value)}
          />
        </Field>
        <RawValueEditor
          component={component}
          busy={busy}
          fieldLabelStyle={fieldLabelStyle}
          inputStyle={inputStyle}
          onPatch={onPatch}
        />
      </>
    );
  }

  if (component.type === 'V' || component.type === 'I') {
    const isPulse = Boolean(params.pulse_v1 || params.pulse_v2 || /^PULSE/i.test(component.value));
    return (
      <>
        <Field label="Source mode" style={fieldLabelStyle}>
          <select
            style={inputStyle}
            value={isPulse ? 'pulse' : 'dc'}
            disabled={busy}
            data-testid="schematic-param-source-mode"
            onChange={(event) => {
              if (event.target.value === 'dc') {
                onPatch(patchElectricalParameters(component, {
                  dc: params.dc || '1',
                  pulse_v1: undefined,
                  pulse_v2: undefined,
                  pulse_td: undefined,
                  pulse_tr: undefined,
                  pulse_tf: undefined,
                  pulse_pw: undefined,
                  pulse_per: undefined,
                }));
              } else {
                onPatch(patchElectricalParameters(component, {
                  dc: undefined,
                  pulse_v1: params.pulse_v1 || '0',
                  pulse_v2: params.pulse_v2 || '1',
                  pulse_td: params.pulse_td || '0',
                  pulse_tr: params.pulse_tr || '1n',
                  pulse_tf: params.pulse_tf || '1n',
                  pulse_pw: params.pulse_pw || '1u',
                  pulse_per: params.pulse_per || '2u',
                }));
              }
            }}
          >
            <option value="dc">DC</option>
            <option value="pulse">PULSE</option>
          </select>
        </Field>
        {isPulse ? (
          <>
            {(['pulse_v1', 'pulse_v2', 'pulse_td', 'pulse_tr', 'pulse_tf', 'pulse_pw', 'pulse_per'] as const).map((key) => (
              <Field key={key} label={key.replace('pulse_', '').toUpperCase()} style={fieldLabelStyle}>
                <input
                  style={inputStyle}
                  value={params[key] || ''}
                  disabled={busy}
                  data-testid={`schematic-param-${key}`}
                  onChange={(event) => setParam(key, event.target.value)}
                />
              </Field>
            ))}
          </>
        ) : (
          <Field label="DC value" style={fieldLabelStyle}>
            <input
              style={inputStyle}
              value={params.dc || ''}
              disabled={busy}
              data-testid="schematic-param-dc"
              onChange={(event) => setParam('dc', event.target.value)}
            />
          </Field>
        )}
        <RawValueEditor
          component={component}
          busy={busy}
          fieldLabelStyle={fieldLabelStyle}
          inputStyle={inputStyle}
          onPatch={onPatch}
        />
      </>
    );
  }

  return (
    <Field label="Value" style={fieldLabelStyle}>
      <input
        style={inputStyle}
        value={component.value}
        disabled={busy}
        data-testid="schematic-editor-component-value"
        onChange={(event) => onPatch({ value: event.target.value })}
      />
    </Field>
  );
}
