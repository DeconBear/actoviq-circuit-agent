/**
 * M3-02 unit tests for the spatial index. Pure; no React/Electron.
 * Run:  npx tsx scripts/schematic-spatial-index-test.ts
 */
import assert from 'node:assert/strict';

import {
  buildSpatialIndex, queryEndpoints, querySegments,
  type EndpointEntry,
} from '../renderer/src/schematic-core/connectivity/spatialIndex';
import type { CircuitWire } from '../renderer/src/types';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${(error as Error).message}`);
  }
}

const pins: EndpointEntry[] = [
  { kind: 'pin', position: { x: 100, y: 100 }, ref: 'pin:r1.a', net: 'in' },
  { kind: 'pin', position: { x: 200, y: 100 }, ref: 'pin:r1.b', net: 'out' },
];
const ports: EndpointEntry[] = [
  { kind: 'port', position: { x: 0, y: 100 }, ref: 'port:in', net: 'in' },
];
const wires: CircuitWire[] = [
  { id: 'w1', points: [{ x: 0, y: 100 }, { x: 100, y: 100 }], from: { x: 0, y: 100, port_id: 'in' }, to: { x: 100, y: 100, component_id: 'r1', pin_id: 'a' }, net: 'in', source: 'stored' },
];

check('buildSpatialIndex counts endpoints and segments', () => {
  const index = buildSpatialIndex(wires, pins, ports, 40);
  // 2 pins + 1 port + 2 wire vertices = 5 endpoints
  assert.equal(index.endpointCount, 5);
  assert.ok(index.segmentCount >= 1, 'at least one segment indexed');
});

check('queryEndpoints finds nearby pin', () => {
  const index = buildSpatialIndex(wires, pins, ports, 40);
  const hits = queryEndpoints(index, { x: 102, y: 100 }, 10);
  assert.ok(hits.some((e) => e.ref === 'pin:r1.a'), 'should find r1.a');
});

check('queryEndpoints sorts by distance', () => {
  const index = buildSpatialIndex(wires, pins, ports, 40);
  const hits = queryEndpoints(index, { x: 150, y: 100 }, 100);
  assert.ok(hits.length >= 2, 'should find at least 2 endpoints');
  // r1.a (100,100) is 50 away; r1.b (200,100) is 50 away; both equidistant
  assert.ok(hits[0]!.ref.startsWith('pin:r1.'), 'closest should be a pin');
});

check('queryEndpoints respects radius', () => {
  const index = buildSpatialIndex(wires, pins, ports, 40);
  const hits = queryEndpoints(index, { x: 100, y: 100 }, 5);
  // r1.a at (100,100) is distance 0; should be found
  assert.ok(hits.some((e) => e.ref === 'pin:r1.a'));
  // r1.b at (200,100) is distance 100; should NOT be found with radius 5
  assert.equal(hits.some((e) => e.ref === 'pin:r1.b'), false);
});

check('queryEndpoints returns empty for far point', () => {
  const index = buildSpatialIndex(wires, pins, ports, 40);
  const hits = queryEndpoints(index, { x: 1000, y: 1000 }, 10);
  assert.equal(hits.length, 0);
});

check('querySegments finds segments overlapping a point cell', () => {
  const index = buildSpatialIndex(wires, pins, ports, 40);
  const segs = querySegments(index, { x: 50, y: 100 });
  assert.ok(segs.some((s) => s.wireId === 'w1'), 'should find w1 segment');
});

check('querySegments returns empty for point off all segments', () => {
  const index = buildSpatialIndex(wires, pins, ports, 40);
  const segs = querySegments(index, { x: 500, y: 500 });
  assert.equal(segs.length, 0);
});

check('wirepoints are indexed as endpoints', () => {
  const multiWire: CircuitWire[] = [{
    id: 'w2', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }],
    net: 'n', source: 'stored',
  }];
  const index = buildSpatialIndex(multiWire, [], [], 40);
  // 3 vertices
  assert.equal(index.endpointCount, 3);
  const hits = queryEndpoints(index, { x: 100, y: 0 }, 5);
  assert.ok(hits.some((e) => e.wireId === 'w2'), 'should find middle wirepoint');
});

check('junction endpoints are indexed with junction kind', () => {
  const jWire: CircuitWire[] = [{
    id: 'w3', points: [{ x: 0, y: 0 }, { x: 50, y: 50 }],
    from: { x: 0, y: 0, junction_id: 'j1' }, to: { x: 50, y: 50 },
    net: 'n', source: 'stored',
  }];
  const index = buildSpatialIndex(jWire, [], [], 40);
  const hits = queryEndpoints(index, { x: 0, y: 0 }, 5);
  assert.ok(hits.some((e) => e.kind === 'junction' && e.ref === 'junction:j1'));
});

console.log(JSON.stringify({ ok: failed === 0, passed, failed, total: passed + failed }, null, 2));
if (failed > 0) process.exit(1);
