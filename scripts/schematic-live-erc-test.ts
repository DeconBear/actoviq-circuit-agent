import assert from 'node:assert/strict';
import type { CircuitModule } from '../renderer/src/types';
import { createSchematicDocument } from '../renderer/src/schematic/schematicDocument';
import {
  deriveLiveErc,
  summarizeLiveErc,
} from '../renderer/src/schematic-core/diagnostics/liveErc';

const module: CircuitModule = {
  schema: 'actoviq.module.v2',
  module_id: 'live_erc',
  name: 'Live ERC',
  revision: 0,
  ports: [],
  nets: [
    { id: 'net_open', name: 'open' },
    { id: 'net_nc', name: 'nc' },
  ],
  components: [
    {
      id: 'open',
      type: 'BLOCK',
      name: 'OPEN',
      value: 'open',
      position: { x: 0, y: 0 },
      rotation: 0,
      pins: [{ id: 'p', name: 'P', net: 'open', net_id: 'net_open', side: 'left' }],
    },
    {
      id: 'nc',
      type: 'BLOCK',
      name: 'NC',
      value: 'unused',
      position: { x: 200, y: 0 },
      rotation: 0,
      pins: [{ id: 'p', name: 'P', net: 'nc', net_id: 'net_nc', side: 'right', no_connect: true }],
    },
  ],
  wires: [{
    id: 'stub',
    points: [{ x: 60, y: 100 }, { x: 120, y: 100 }],
    from: { x: 60, y: 100, junction_id: 'j1' },
    to: { x: 120, y: 100, junction_id: 'j2' },
    net: 'open',
    net_id: 'net_open',
    source: 'stored',
  }],
  annotations: [],
};

const diagnostics = deriveLiveErc(createSchematicDocument(module, { autoLayout: false }));
assert.ok(diagnostics.some((diagnostic) => (
  diagnostic.code === 'unconnected_pin'
  && diagnostic.component_id === 'open'
  && diagnostic.pin_id === 'p'
)));
assert.ok(!diagnostics.some((diagnostic) => (
  diagnostic.code === 'unconnected_pin'
  && diagnostic.component_id === 'nc'
)));
assert.equal(
  diagnostics.filter((diagnostic) => diagnostic.code === 'dangling_wire_endpoint').length,
  2,
);
assert.deepEqual(summarizeLiveErc(diagnostics), {
  errors: 0,
  warnings: 3,
  infos: 0,
  status: 'warning',
});

console.log(JSON.stringify({ ok: true, passed: 4, failed: 0, total: 4 }, null, 2));
