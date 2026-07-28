import type { CSSProperties } from 'react';
import type { CircuitComponent, ProjectKind } from '../../../types';

export interface PdkDeviceCatalogDevice {
  device_id: string;
  kind?: string;
  spice?: {
    model?: string;
    format?: string;
    pin_order?: string[];
    primitive?: string;
  };
  parameters?: Record<string, unknown>;
  views?: Record<string, unknown>;
}

export interface PdkDeviceCatalog {
  schema?: string;
  pdk_ref?: string;
  devices: PdkDeviceCatalogDevice[];
}

export interface ComponentParamFormContext {
  projectKind: ProjectKind;
  component: CircuitComponent;
  busy: boolean;
  pdkCatalog?: PdkDeviceCatalog | null;
}

export interface ComponentParamFormProps extends ComponentParamFormContext {
  fieldLabelStyle: CSSProperties;
  inputStyle: CSSProperties;
  hintStyle?: CSSProperties;
  onPatch: (patch: Partial<CircuitComponent>) => void;
}
