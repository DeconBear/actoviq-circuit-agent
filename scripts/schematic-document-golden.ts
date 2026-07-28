/**
 * Golden snapshot generator and verifier for `actoviq.schematic-document.v1`
 * projections of the shared schematic fixtures.
 *
 * Run with `--update` to (re)write the golden files under
 * `scripts/golden/schematic-document/`. Without arguments it compares the
 * current projection against the committed golden and fails on any drift.
 *
 * The snapshot captures entity-level sets (components, pins, ports, wires,
 * junctions, net labels) and the projected bounds. It deliberately does not
 * capture SVG DOM or rendering-only state, per ADR-0002. Pixel-identical
 * output is not a goal; entity-set drift is.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CircuitComponent, CircuitPin, CircuitPort, CircuitWireEndpoint } from '../renderer/src/types';
import { createSchematicDocument } from '../renderer/src/schematic/schematicDocument';
import { fixtures } from './lib/schematic-fixtures';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenRoot = path.resolve(root, 'scripts', 'golden', 'schematic-document');

const shouldUpdate = process.argv.includes('--update');

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function position(point: { x: number; y: number } | undefined) {
  if (!point) return undefined;
  return { x: round(point.x), y: round(point.y) };
}

function endpointKey(endpoint: CircuitWireEndpoint | undefined): string {
  if (!endpoint) return 'none';
  if (endpoint.junction_id) return `junction:${endpoint.junction_id}`;
  if (endpoint.component_id && endpoint.pin_id) return `pin:${endpoint.component_id}.${endpoint.pin_id}`;
  if (endpoint.port_id) return `port:${endpoint.port_id}`;
  return `free:${round(endpoint.x)},${round(endpoint.y)}`;
}

function serializeComponent(component: CircuitComponent) {
  return {
    id: component.id,
    type: component.type,
    name: component.name,
    value: component.value,
    position: position(component.position),
    rotation: round(component.rotation),
    pins: [...component.pins]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((pin: CircuitPin) => ({
        id: pin.id,
        name: pin.name,
        net: pin.net,
        net_id: pin.net_id,
        side: pin.side,
        order: pin.order,
      })),
    block: component.block,
    module_ref: component.module_ref,
    parameters: component.parameters,
  };
}

function serializePort(port: CircuitPort, connected: boolean, portPosition: { x: number; y: number } | undefined) {
  return {
    id: port.id,
    name: port.name,
    direction: port.direction,
    signal_type: port.signal_type,
    net: port.net,
    net_id: port.net_id,
    inferred: port.inferred,
    connected,
    position: position(portPosition ?? port.position),
  };
}

function serializeWire(wire: {
  id: string;
  points: { x: number; y: number }[];
  from?: CircuitWireEndpoint;
  to?: CircuitWireEndpoint;
  net?: string;
  net_id?: string;
  source?: string;
}) {
  return {
    id: wire.id,
    net: wire.net,
    net_id: wire.net_id,
    source: wire.source,
    from: endpointKey(wire.from),
    to: endpointKey(wire.to),
    fromPoint: position(wire.from),
    toPoint: position(wire.to),
    pointCount: wire.points.length,
    points: wire.points.map(position),
  };
}

function serializeNetLabel(label: {
  id: string;
  kind: string;
  net: string;
  name: string;
  position: { x: number; y: number };
  side?: string;
}) {
  return {
    id: label.id,
    kind: label.kind,
    net: label.net,
    name: label.name,
    side: label.side,
    position: position(label.position),
  };
}

function collectJunctions(wires: { from?: CircuitWireEndpoint; to?: CircuitWireEndpoint; net?: string; net_id?: string }[]) {
  const junctions = new Map<string, { junction_id: string; net?: string; net_id?: string; position?: { x: number; y: number } }>();
  for (const wire of wires) {
    for (const endpoint of [wire.from, wire.to]) {
      if (endpoint?.junction_id) {
        junctions.set(endpoint.junction_id, {
          junction_id: endpoint.junction_id,
          net: wire.net,
          net_id: wire.net_id,
          position: position(endpoint),
        });
      }
    }
  }
  return [...junctions.values()].sort((a, b) => a.junction_id.localeCompare(b.junction_id));
}

function projectFixture(fixture: (typeof fixtures)[number]) {
  const document = createSchematicDocument(fixture);
  const components = document.module.components
    .map(serializeComponent)
    .sort((a, b) => a.id.localeCompare(b.id));
  const ports = document.module.ports
    .map((port) => serializePort(
      port,
      document.connectedPortIds.has(port.id),
      document.portPositions.get(port.id),
    ))
    .sort((a, b) => a.id.localeCompare(b.id));
  const wires = document.wires
    .map(serializeWire)
    .sort((a, b) => a.id.localeCompare(b.id));
  const netLabels = document.netLabels
    .map(serializeNetLabel)
    .sort((a, b) => a.id.localeCompare(b.id));
  const junctions = collectJunctions(document.wires);
  return {
    schema: 'actoviq.schematic-document.v1.golden',
    moduleId: fixture.module_id,
    moduleRevision: fixture.revision,
    bounds: document.bounds,
    viewBox: document.viewBox,
    componentCount: components.length,
    wireCount: wires.length,
    portCount: ports.length,
    netLabelCount: netLabels.length,
    junctionCount: junctions.length,
    components,
    ports,
    wires,
    netLabels,
    junctions,
  };
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

async function ensureGoldenDir() {
  await mkdir(goldenRoot, { recursive: true });
}

async function writeGolden(fixture: (typeof fixtures)[number]) {
  const snapshot = projectFixture(fixture);
  const filePath = path.resolve(goldenRoot, `${fixture.module_id}.json`);
  await writeFile(filePath, stableSerialize(snapshot), 'utf8');
  return filePath;
}

async function verifyGolden(fixture: (typeof fixtures)[number]): Promise<{ ok: boolean; diff?: string }> {
  const snapshot = projectFixture(fixture);
  const filePath = path.resolve(goldenRoot, `${fixture.module_id}.json`);
  const existing = await readFile(filePath, 'utf8').catch(() => null);
  if (existing === null) {
    return { ok: false, diff: `missing golden file: ${path.relative(root, filePath)}` };
  }
  const expected = stableSerialize(snapshot);
  if (existing === expected) return { ok: true };
  return { ok: false, diff: `drift in ${fixture.module_id}` };
}

async function removeStaleGoldens() {
  const entries = await readdir(goldenRoot, { withFileTypes: true }).catch(() => []);
  const keep = new Set(fixtures.map((fixture) => `${fixture.module_id}.json`));
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    if (keep.has(entry.name)) continue;
    const target = path.resolve(goldenRoot, entry.name);
    assert.equal(path.dirname(target), goldenRoot);
    await rm(target, { force: true });
  }
}

async function main() {
  await ensureGoldenDir();
  if (shouldUpdate) {
    await removeStaleGoldens();
    const written: string[] = [];
    for (const fixture of fixtures) {
      const filePath = await writeGolden(fixture);
      written.push(path.relative(root, filePath));
    }
    console.log(JSON.stringify({
      ok: true,
      mode: 'update',
      goldenCount: written.length,
      goldenRoot: path.relative(root, goldenRoot),
    }, null, 2));
    return;
  }

  const failures: Array<{ fixture: string; diff: string }> = [];
  for (const fixture of fixtures) {
    const result = await verifyGolden(fixture);
    if (!result.ok) {
      failures.push({ fixture: fixture.module_id, diff: result.diff ?? 'unknown' });
    }
  }
  if (failures.length > 0) {
    console.error(JSON.stringify({
      ok: false,
      mode: 'verify',
      failures,
      hint: 'Run `npm run test:schematic-golden -- --update` to refresh golden files after an intentional projection change.',
    }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: true,
    mode: 'verify',
    goldenCount: fixtures.length,
    goldenRoot: path.relative(root, goldenRoot),
  }, null, 2));
}

await main();
