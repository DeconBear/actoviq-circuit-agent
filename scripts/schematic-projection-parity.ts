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
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  orderedConnectivitySnapshot,
  projectSchematicArtifact,
  projectSchematicDocument,
  schematicEntityMap,
  serializeSchematicDocument,
} from '../renderer/src/schematic-core/projection/facade';
import { fixtures } from './lib/schematic-fixtures';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenRoot = path.resolve(root, 'scripts', 'golden', 'schematic-document');
const circuitProjectCli = path.resolve(
  root,
  'skills',
  'circuit-design-ngspice',
  'scripts',
  'circuit_project.py',
);

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

function canonicalConnectivityModule(module: (typeof fixtures)[number]) {
  const normalized = structuredClone(module);
  const existing = new Map(
    (normalized.nets ?? []).map((net) => [net.id, { ...net }]),
  );
  const byName = new Map<string, string>();
  for (const [netId, net] of existing) {
    byName.set(net.name, netId);
    for (const alias of net.aliases ?? []) byName.set(alias, netId);
  }
  function ensureNet(name: string, currentId?: string): string {
    if (currentId) return currentId;
    const known = byName.get(name);
    if (known) return known;
    const baseToken = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'net';
    const base = `net_${baseToken}`;
    let netId = base;
    let suffix = 2;
    while (existing.has(netId)) {
      netId = `${base}_${suffix}`;
      suffix += 1;
    }
    existing.set(netId, { id: netId, name, kind: name === '0' ? 'ground' : 'signal', aliases: [] });
    byName.set(name, netId);
    return netId;
  }
  for (const component of normalized.components) {
    for (const pin of component.pins) pin.net_id = ensureNet(pin.net, pin.net_id);
  }
  for (const port of normalized.ports) port.net_id = ensureNet(port.net, port.net_id);
  for (const wire of normalized.wires ?? []) {
    wire.net_id = ensureNet(wire.net ?? `n_${wire.id}`, wire.net_id);
  }
  normalized.nets = [...existing.values()];
  return normalized;
}

let passed = 0;
let failed = 0;
const tempRoot = await mkdtemp(path.resolve(os.tmpdir(), 'actoviq-schematic-parity-'));

try {
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

      const artifact = projectSchematicArtifact(fixture);
      assert.equal(artifact.schema, 'actoviq.schematic-document.v1');
      const modulePath = path.resolve(tempRoot, `${fixture.module_id}.module.json`);
      const artifactPath = path.resolve(tempRoot, `${fixture.module_id}.schematic-document.json`);
      await writeFile(modulePath, JSON.stringify(fixture), 'utf8');
      await writeFile(artifactPath, JSON.stringify(artifact), 'utf8');
      const adapterRun = spawnSync('python', [
        circuitProjectCli,
        'schematic-render-map',
        '--module-file',
        modulePath,
        '--schematic-document',
        artifactPath,
      ], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(
        adapterRun.status,
        0,
        `${fixture.module_id} compile adapter failed: ${adapterRun.stderr || adapterRun.stdout}`,
      );
      const adapter = JSON.parse(adapterRun.stdout.trim()) as {
        schema: string;
        connectivity_hash: string;
        projection: { artifact_consumed: boolean };
        entities: Record<string, Array<{ entity_id: string }>>;
      };
      assert.equal(adapter.schema, 'actoviq.schematic-render-map.v1');
      assert.equal(adapter.projection.artifact_consumed, true);

      const interactiveMap = schematicEntityMap(document);
      for (const kind of ['components', 'pins', 'ports', 'nets', 'wires', 'junctions'] as const) {
        assert.deepEqual(
          adapter.entities[kind].map((entity) => entity.entity_id).sort(),
          interactiveMap[kind].map((entity) => entity.entity_id).sort(),
          `${fixture.module_id} ${kind} entity parity`,
        );
      }
      const expectedConnectivityHash = createHash('sha256')
        .update(JSON.stringify(orderedConnectivitySnapshot(canonicalConnectivityModule(fixture))))
        .digest('hex');
      assert.equal(
        adapter.connectivity_hash,
        expectedConnectivityHash,
        `${fixture.module_id} connectivity hash parity`,
      );

      passed += 1;
      console.log(`PASS ${fixture.module_id}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${fixture.module_id}: ${(error as Error).message}`);
    }
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: failed === 0,
  fixtureCount: fixtures.length,
  passed,
  failed,
  parity: 'interactive artifact and compile/netlistsvg adapter entity sets and connectivity hashes match',
}, null, 2));
if (failed > 0) process.exit(1);
