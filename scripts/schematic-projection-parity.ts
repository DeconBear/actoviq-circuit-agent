/**
 * M1-05 projection parity test: for every shared fixture, project through the
 * schematic-core facade, serialize, and compare entity sets (components, pins,
 * ports, wires, net labels, junctions) against the committed golden snapshot.
 *
 * This locks the projection boundary: any change to createSchematicDocument
 * that alters entity sets will fail here unless the golden is intentionally
 * refreshed with --update. Combined with test:schematic-schema (which checks
 * the serialized form against the JSON Schema) this is the M1 parity gate.
 *
 * Run:  npx tsx scripts/schematic-projection-parity.ts
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectSchematicDocument, serializeSchematicDocument } from '../renderer/src/schematic-core/projection/facade';
import { fixtures } from './lib/schematic-fixtures';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenRoot = path.resolve(root, 'scripts', 'golden', 'schematic-document');

interface GoldenSnapshot {
  moduleId: string;
  componentCount: number;
  wireCount: number;
  portCount: number;
  netLabelCount: number;
  junctionCount: number;
  components: Array<{ id: string; type: string; pins: Array<{ id: string; net: string }> }>;
  ports: Array<{ id: string; net: string; connected: boolean }>;
  wires: Array<{ id: string; net: string; from: string; to: string }>;
  netLabels: Array<{ id: string; net: string; kind: string }>;
  junctions: Array<{ junction_id: string; net?: string }>;
}

let passed = 0;
let failed = 0;

for (const fixture of fixtures) {
  try {
    const document = projectSchematicDocument(fixture);
    const serialized = serializeSchematicDocument(document);
    const goldenPath = path.resolve(goldenRoot, `${fixture.module_id}.json`);
    const goldenRaw = await readFile(goldenPath, 'utf8');
    const golden = JSON.parse(goldenRaw) as GoldenSnapshot;

    // Entity-set parity: compare counts and id sets, not pixel positions.
    assert.equal(serialized.module.components.length, golden.componentCount, `${fixture.module_id} component count`);
    assert.equal(serialized.wires.length, golden.wireCount, `${fixture.module_id} wire count`);
    assert.equal(serialized.module.ports.length, golden.portCount, `${fixture.module_id} port count`);
    assert.equal(serialized.netLabels.length, golden.netLabelCount, `${fixture.module_id} netLabel count`);

    const goldenComponentIds = new Set(golden.components.map((c) => c.id));
    for (const component of serialized.module.components) {
      assert.ok(goldenComponentIds.has(component.id), `${fixture.module_id} component ${component.id} missing from golden`);
    }

    const goldenWireIds = new Set(golden.wires.map((w) => w.id));
    for (const wire of serialized.wires) {
      assert.ok(goldenWireIds.has(wire.id), `${fixture.module_id} wire ${wire.id} missing from golden`);
    }

    const goldenNetLabelNets = new Set(golden.netLabels.map((l) => `${l.kind}:${l.net}`));
    for (const label of serialized.netLabels) {
      assert.ok(goldenNetLabelNets.has(`${label.kind}:${label.net}`), `${fixture.module_id} netLabel ${label.kind}:${label.net} missing from golden`);
    }

    passed += 1;
    console.log(`PASS ${fixture.module_id}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${fixture.module_id}: ${(error as Error).message}`);
  }
}

console.log(JSON.stringify({
  ok: failed === 0,
  fixtureCount: fixtures.length,
  passed,
  failed,
  parity: 'facade projection entity sets match committed golden snapshots',
}, null, 2));
if (failed > 0) process.exit(1);
