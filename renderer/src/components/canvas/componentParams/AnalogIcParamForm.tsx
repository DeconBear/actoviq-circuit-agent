import type { CSSProperties, ReactNode } from 'react';
import type { ComponentParamFormProps } from './types';
import { mergeParameters, parseComponentValue, patchElectricalParameters } from './projectToValue';
import { pdkDeviceDefaults, validatePdkDeviceParameters } from './pdkDevice';
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
  const selectedDevice = devices.find((device) => device.device_id === selectedDeviceId);
  const diagnostics = selectedDevice && pdkCatalog
    ? validatePdkDeviceParameters(selectedDevice, pdkCatalog, params)
    : selectedDeviceId ? [{
        code: 'device_missing',
        severity: 'error' as const,
        message: `Device ${selectedDeviceId} is not present in the bound PDK catalog.`,
      }] : [];

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
              ...pdkDeviceDefaults(device, pdkCatalog),
              ...params,
              device_id: device.device_id,
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
      <Field label="Corner" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={params.corner || ''}
          disabled={busy}
          list="schematic-param-pdk-corners"
          data-testid="schematic-param-corner"
          onChange={(event) => setMos({ corner: event.target.value })}
        />
        <datalist id="schematic-param-pdk-corners">
          {(pdkCatalog.binding?.corner_sweep || []).map((value) => <option key={value} value={value} />)}
        </datalist>
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
      {diagnostics.length > 0 ? (
        <div data-testid="schematic-param-pdk-diagnostics" style={{ display: 'grid', gap: 4, marginBottom: 8 }}>
          {diagnostics.map((diagnostic, index) => (
            <div
              key={`${diagnostic.code}-${index}`}
              data-code={diagnostic.code}
              style={{
                padding: '5px 7px',
                borderRadius: 4,
                fontSize: 10,
                color: diagnostic.severity === 'error' ? '#b91c1c' : '#9a3412',
                background: diagnostic.severity === 'error' ? '#fef2f2' : '#fff7ed',
              }}
            >
              {diagnostic.message}
            </div>
          ))}
        </div>
      ) : null}
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
