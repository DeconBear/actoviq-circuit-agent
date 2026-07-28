import type { CSSProperties, ReactNode } from 'react';
import type { ComponentParamFormProps } from './types';
import { mergeParameters, parseComponentValue, patchElectricalParameters } from './projectToValue';
import { SimulationParamForm } from './SimulationParamForm';

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

export function AnalogIcParamForm(props: ComponentParamFormProps) {
  const {
    component,
    busy,
    pdkCatalog,
    fieldLabelStyle,
    inputStyle,
    hintStyle,
    onPatch,
  } = props;

  if (component.type !== 'M') {
    return <SimulationParamForm {...props} />;
  }

  const devices = pdkCatalog?.devices || [];
  const params = component.parameters || {};
  const selectedDeviceId = params.device_id
    || devices.find((device) => String(device.spice?.model || '') === params.model)?.device_id
    || '';

  if (!pdkCatalog || devices.length === 0) {
    return (
      <>
        <p
          style={hintStyle || { fontSize: 11, color: '#a15c00', margin: '0 0 10px' }}
          data-testid="schematic-param-pdk-unbound"
        >
          Bind a registered PDK in the workbench header for catalog models. Using generic MOS fields for now.
        </p>
        <SimulationParamForm {...props} />
      </>
    );
  }

  const setMos = (patch: Record<string, string | undefined>) => {
    onPatch(patchElectricalParameters(component, patch));
  };

  return (
    <>
      <Field label="PDK device" style={fieldLabelStyle}>
        <select
          style={inputStyle}
          value={selectedDeviceId}
          disabled={busy}
          data-testid="schematic-param-pdk-device"
          onChange={(event) => {
            const device = devices.find((entry) => entry.device_id === event.target.value);
            if (!device) return;
            setMos({
              device_id: device.device_id,
              model: String(device.spice?.model || device.device_id),
              w: params.w || '1u',
              l: params.l || '180n',
              m: params.m || '1',
              nf: params.nf || '1',
            });
          }}
        >
          <option value="">Select device…</option>
          {devices.map((device) => (
            <option key={device.device_id} value={device.device_id}>
              {device.device_id}
              {device.spice?.model ? ` · ${device.spice.model}` : ''}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Model" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={params.model || ''}
          disabled={busy}
          data-testid="schematic-param-model"
          onChange={(event) => setMos({ model: event.target.value })}
        />
      </Field>
      <Field label="W" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={params.w || ''}
          disabled={busy}
          data-testid="schematic-param-w"
          onChange={(event) => setMos({ w: event.target.value })}
        />
      </Field>
      <Field label="L" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={params.l || ''}
          disabled={busy}
          data-testid="schematic-param-l"
          onChange={(event) => setMos({ l: event.target.value })}
        />
      </Field>
      <Field label="M" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={params.m || '1'}
          disabled={busy}
          data-testid="schematic-param-m"
          onChange={(event) => setMos({ m: event.target.value })}
        />
      </Field>
      <Field label="NF" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={params.nf || '1'}
          disabled={busy}
          data-testid="schematic-param-nf"
          onChange={(event) => setMos({ nf: event.target.value })}
        />
      </Field>
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
                parameters: mergeParameters(component.parameters, {
                  ...parsed,
                  device_id: params.device_id,
                }),
              });
            }}
          />
        </Field>
      </details>
    </>
  );
}
