import { AnalogIcParamForm } from './AnalogIcParamForm';
import { PcbParamForm } from './PcbParamForm';
import { SimulationParamForm } from './SimulationParamForm';
import type { ComponentParamFormProps } from './types';

export type { PdkDeviceCatalog, PdkDeviceCatalogDevice, ComponentParamFormProps } from './types';
export {
  defaultParametersForType,
  parseComponentValue,
  projectComponentValue,
  patchElectricalParameters,
} from './projectToValue';
export {
  applyPdkDeviceToComponent,
  pdkDeviceCategory,
  pdkDeviceDefaults,
  pdkDeviceToolType,
  validatePdkDeviceParameters,
} from './pdkDevice';
export { PdkDeviceBrowser } from './PdkDeviceBrowser';

export function ComponentParamForm(props: ComponentParamFormProps) {
  const { projectKind, component } = props;
  if (component.type === 'GND' || component.type === 'BLOCK' || component.type === 'MODULE') {
    return null;
  }
  if (projectKind === 'pcb_schematic') {
    return <PcbParamForm {...props} />;
  }
  if (projectKind === 'analog_ic' || projectKind === 'mixed_signal_ic') {
    return <AnalogIcParamForm {...props} />;
  }
  return <SimulationParamForm {...props} />;
}
