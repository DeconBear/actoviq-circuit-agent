import assert from 'node:assert/strict';

import type { CircuitComponent } from '../renderer/src/types';
import {
  applyPdkDeviceToComponent,
  parsePdkScalar,
  pdkDeviceCategory,
  pdkDeviceDefaults,
  pdkDeviceToolType,
  validatePdkDeviceParameters,
} from '../renderer/src/components/canvas/componentParams/pdkDevice';
import type {
  PdkDeviceCatalog,
  PdkDeviceCatalogDevice,
} from '../renderer/src/components/canvas/componentParams/types';

const device: PdkDeviceCatalogDevice = {
  device_id: 'nmos_core',
  kind: 'nmos',
  pins: ['D', 'G', 'S', 'B'],
  spice: {
    primitive: 'M',
    model: 'nmos_core_model',
    pin_order: ['D', 'G', 'S', 'B'],
    format: '{name} {D} {G} {S} {B} {model} w={w} l={l} nf={nf} m={m}',
  },
  parameters: {
    w: { required: true, default: '1u', minimum: '120n', unit: 'm' },
    l: { required: true, default: '180n', minimum: '150n', unit: 'm' },
    nf: { required: true, default: 1, minimum: 1, integer: true },
    m: { required: true, default: 1, minimum: 1, integer: true },
  },
  views: { generic_fallback: 'mos4' },
};
const catalog: PdkDeviceCatalog = {
  schema: 'actoviq.pdk-device-catalog.v1',
  pdk_ref: 'fixture-pdk',
  devices: [device],
  binding: {
    default_corner: 'tt',
    corner_sweep: ['ss', 'tt', 'ff'],
    model_library_available: true,
  },
};

assert.equal(pdkDeviceToolType(device), 'M');
assert.equal(pdkDeviceCategory(device), 'MOSFET');
const parsed180n = parsePdkScalar('180n');
assert.equal(parsed180n?.hasUnit, true);
assert.ok(Math.abs((parsed180n?.value ?? 0) - 180e-9) < 1e-20);
assert.equal(parsePdkScalar('bad'), null);

const defaults = pdkDeviceDefaults(device, catalog);
assert.deepEqual({
  device_id: defaults.device_id,
  model: defaults.model,
  corner: defaults.corner,
  symbol: defaults.symbol,
  pin_order: defaults.pin_order,
  w: defaults.w,
  l: defaults.l,
  nf: defaults.nf,
  m: defaults.m,
}, {
  device_id: 'nmos_core',
  model: 'nmos_core_model',
  corner: 'tt',
  symbol: 'mos4',
  pin_order: 'D,G,S,B',
  w: '1u',
  l: '180n',
  nf: '1',
  m: '1',
});
assert.deepEqual(validatePdkDeviceParameters(device, catalog, defaults), []);

const invalid = validatePdkDeviceParameters(device, catalog, {
  ...defaults,
  model: '',
  corner: '',
  w: '80n',
  l: '180',
  nf: '1.5',
});
assert.deepEqual(
  new Set(invalid.map((item) => item.code)),
  new Set(['parameter_range', 'parameter_unit', 'parameter_integer']),
);
const missingModelAndCorner = validatePdkDeviceParameters(
  { ...device, spice: { ...device.spice, model: '' } },
  { ...catalog, binding: { model_library_available: true } },
  { ...defaults, model: '', corner: '' },
);
assert.deepEqual(
  new Set(missingModelAndCorner.map((item) => item.code)),
  new Set(['model_missing', 'corner_missing']),
);

const base: CircuitComponent = {
  id: 'm1',
  type: 'M',
  name: 'M1',
  value: 'NMOS',
  position: { x: 100, y: 100 },
  rotation: 0,
  pins: [
    { id: 'd', name: 'D', net: 'out' },
    { id: 'g', name: 'G', net: 'in' },
    { id: 's', name: 'S', net: '0' },
    { id: 'b', name: 'B', net: '0' },
  ],
};
const placed = applyPdkDeviceToComponent(base, device, catalog, defaults);
assert.deepEqual(placed.pins.map((pin) => pin.id), ['d', 'g', 's', 'b']);
assert.deepEqual(placed.pins.map((pin) => pin.order), [0, 1, 2, 3]);
assert.equal(placed.parameters?.device_id, 'nmos_core');
assert.equal(placed.parameters?.pdk_ref, 'fixture-pdk');
assert.equal(placed.value, 'nmos_core_model W=1u L=180n M=1 NF=1');

console.log(JSON.stringify({
  ok: true,
  suite: 'schematic-pdk-device',
  searchMetadataReady: true,
  defaultsFromCatalog: true,
  unitsAndRangesValidated: true,
  canonicalPinOrderApplied: true,
}, null, 2));
