import type { CSSProperties, ReactNode } from 'react';
import type { ComponentParamFormProps } from './types';
import { parseComponentValue } from './projectToValue';

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

export function PcbParamForm({
  component,
  busy,
  fieldLabelStyle,
  inputStyle,
  hintStyle,
  onPatch,
}: ComponentParamFormProps) {
  const eda = component.eda || {};
  const patchEda = (key: string, value: string) => {
    const next = { ...eda };
    const trimmed = value.trim();
    if (!trimmed) delete next[key];
    else next[key] = trimmed;
    onPatch({ eda: next });
  };

  return (
    <>
      <Field label="Value (BOM display)" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={component.value}
          disabled={busy}
          data-testid="schematic-editor-component-value"
          onChange={(event) => {
            const value = event.target.value;
            onPatch({
              value,
              parameters: {
                ...(component.parameters || {}),
                ...parseComponentValue(component.type, value),
              },
            });
          }}
        />
      </Field>
      <p style={hintStyle || { fontSize: 11, color: '#7a818b', margin: '0 0 10px' }}>
        PCB flow focuses on BOM and footprint metadata.
      </p>
      <Field label="Footprint hint" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={String(eda.footprint_hint ?? '')}
          disabled={busy}
          placeholder="e.g. R_0603"
          data-testid="schematic-param-footprint"
          onChange={(event) => patchEda('footprint_hint', event.target.value)}
        />
      </Field>
      <Field label="LCSC ID" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={String(eda.lcsc_id ?? '')}
          disabled={busy}
          data-testid="schematic-param-lcsc"
          onChange={(event) => patchEda('lcsc_id', event.target.value)}
        />
      </Field>
      <Field label="Manufacturer" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={String(eda.manufacturer ?? '')}
          disabled={busy}
          data-testid="schematic-param-manufacturer"
          onChange={(event) => patchEda('manufacturer', event.target.value)}
        />
      </Field>
      <Field label="MPN" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={String(eda.mpn ?? '')}
          disabled={busy}
          data-testid="schematic-param-mpn"
          onChange={(event) => patchEda('mpn', event.target.value)}
        />
      </Field>
      <Field label="Refdes override" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={String(eda.refdes ?? '')}
          disabled={busy}
          data-testid="schematic-param-refdes"
          onChange={(event) => patchEda('refdes', event.target.value)}
        />
      </Field>
    </>
  );
}
