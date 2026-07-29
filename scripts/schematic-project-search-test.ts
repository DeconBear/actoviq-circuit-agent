import assert from 'node:assert/strict';
import type { CircuitModule } from '../renderer/src/types';
import { searchProjectSchematic } from '../renderer/src/schematic-core/search/projectSearch';

const module: CircuitModule = {
  schema: 'actoviq.module.v2',
  module_id: 'top',
  name: 'Top amplifier',
  revision: 0,
  ports: [{ id: 'out', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'vout', net_id: 'net_vout' }],
  nets: [{ id: 'net_vout', name: 'vout', kind: 'analog' }],
  components: [
    {
      id: 'm1',
      type: 'M',
      name: 'MGAIN',
      value: 'sg13_lv_nmos W=2u L=180n',
      position: { x: 100, y: 100 },
      rotation: 0,
      pins: [{ id: 'd', name: 'D', net: 'vout', net_id: 'net_vout' }],
      parameters: { model: 'sg13_lv_nmos' },
    },
    {
      id: 'xchild',
      type: 'MODULE',
      name: 'XBIAS',
      value: 'bias_cell',
      position: { x: 300, y: 100 },
      rotation: 0,
      pins: [],
      module_ref: { module_id: 'bias_cell', revision: 1 },
    },
  ],
  wires: [],
  annotations: [],
};

assert.equal(searchProjectSchematic({ top: module }, 'MGAIN')[0]?.entityId, 'm1');
assert.equal(searchProjectSchematic({ top: module }, 'sg13_lv_nmos')[0]?.kind, 'model');
assert.equal(searchProjectSchematic({ top: module }, 'bias_cell')[0]?.kind, 'module_instance');
assert.equal(searchProjectSchematic({ top: module }, 'net_vout')[0]?.kind, 'net');
assert.equal(searchProjectSchematic({ top: module }, 'Top amplifier')[0]?.kind, 'module');
assert.deepEqual(searchProjectSchematic({ top: module }, ''), []);

console.log(JSON.stringify({
  ok: true,
  suite: 'schematic-project-search',
  refdes: true,
  model: true,
  moduleInstance: true,
  stableNetId: true,
}, null, 2));
