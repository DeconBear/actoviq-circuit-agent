import assert from 'node:assert/strict';

import type { CircuitComponent, CircuitModule } from '../renderer/src/types';
import {
  inspectModuleInstance,
  missingRequiredParameters,
  refreshModuleInstanceBinding,
} from '../renderer/src/schematic-core/hierarchy/moduleInstance';

const child: CircuitModule = {
  schema: 'actoviq.module.v2',
  module_id: 'gain',
  name: 'Gain',
  revision: 3,
  ports: [
    { id: 'vin', name: 'VIN', direction: 'input', signal_type: 'analog', net: 'child_in' },
    { id: 'vout', name: 'VOUT', direction: 'output', signal_type: 'analog', net: 'child_out' },
  ],
  parameter_defs: [{ id: 'gain', default: '10' }, { id: 'corner', default: '' }],
  components: [],
  wires: [],
  annotations: [],
};

const instance: CircuitComponent = {
  id: 'xgain',
  type: 'MODULE',
  name: 'XGAIN',
  value: 'gain',
  position: { x: 0, y: 0 },
  rotation: 0,
  pins: [
    { id: 'vin', name: 'VIN', net: 'parent_source', side: 'left' },
    { id: 'legacy', name: 'OLD', net: 'unused', side: 'right' },
  ],
  module_ref: { module_id: 'gain', revision: 1 },
  parameters: {},
};

const inspection = inspectModuleInstance(instance, child);
assert.deepEqual(
  inspection.diagnostics.map((item) => item.code).sort(),
  ['module_pin_extra', 'module_port_missing', 'module_revision_mismatch'],
);
assert.deepEqual(inspection.portMap.map((item) => ({
  pin: item.pin_id,
  parent: item.parent_net,
  child: item.child_net,
})), [{ pin: 'vin', parent: 'parent_source', child: 'child_in' }]);

const refreshed = refreshModuleInstanceBinding(instance, child);
assert.equal(refreshed.module_ref?.revision, 3);
assert.deepEqual(refreshed.pins.map((pin) => pin.id).sort(), ['vin', 'vout']);
assert.equal(refreshed.pins.find((pin) => pin.id === 'vin')?.net, 'parent_source');
assert.equal(refreshed.pins.find((pin) => pin.id === 'vout')?.net, 'n_xgain_vout');
assert.equal(refreshed.parameters?.gain, '10');
assert.deepEqual(missingRequiredParameters(refreshed, child.parameter_defs), ['corner']);

console.log(JSON.stringify({
  ok: true,
  suite: 'schematic-hierarchy',
  portMapUsesIds: true,
  staleRevisionDetected: true,
  explicitRefreshPreservesParentNets: true,
  missingParametersDetected: true,
}, null, 2));
