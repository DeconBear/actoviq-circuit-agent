/**
 * M0-03 performance baseline: measure `createSchematicDocument` projection
 * time and memory for generated 100- and 500-component modules.
 *
 * This is the Node.js-only part of the performance baseline. It does not
 * launch Electron; it measures the pure projection that the editor and the
 * export path share. GUI-side timings (first paint, pan/zoom, drag, save)
 * are captured by scripts/e2e/schematic-editor-perf-baseline.mjs.
 *
 * Two requests are measured per size:
 *   - autoLayout=false: pure projection (routing + net labels), no layout pass
 *   - autoLayout=true:  projection with the bounded auto-layout policy
 * Modules above AUTO_LAYOUT_COMPONENT_LIMIT retain user positions so a large
 * sheet cannot synchronously monopolize the renderer.
 *
 * Run:  npx tsx scripts/schematic-perf-baseline.ts
 */
import { performance } from 'node:perf_hooks';

import type { CircuitComponent, CircuitModule, CircuitPort } from '../renderer/src/types';
import { AUTO_LAYOUT_COMPONENT_LIMIT } from '../renderer/src/schematic/schematicDocument';
import { projectSchematicDocument as createSchematicDocument } from '../renderer/src/schematic-core/projection/facade';

const defaultPorts: CircuitPort[] = [
  { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
  { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
  { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
  { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
];

function generateLargeModule(componentCount: number): CircuitModule {
  const components: CircuitComponent[] = [];
  const cols = Math.ceil(Math.sqrt(componentCount));
  for (let i = 0; i < componentCount; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    components.push({
      id: `r${i}`,
      type: 'R',
      name: `R${i}`,
      value: '1k',
      position: { x: 60 + col * 80, y: 60 + row * 80 },
      rotation: 0,
      pins: [
        { id: 'a', name: '1', net: `n${i}` },
        { id: 'b', name: '2', net: `n${i + 1}` },
      ],
    });
  }
  return {
    schema: 'actoviq.module.v2',
    module_id: `perf_${componentCount}`,
    name: `Perf ${componentCount}`,
    revision: 0,
    ports: defaultPorts,
    components,
    wires: [],
    annotations: [],
  };
}

interface ProjectionResult {
  timings: number[];
  medianMs: number;
  wireCount: number;
  netLabelCount: number;
  heapUsedMb: number;
}

function measureProjection(module: CircuitModule, autoLayout: boolean, runs = 3): ProjectionResult {
  // Warm-up run (JIT, caches).
  createSchematicDocument(module, { autoLayout });
  const timings: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    const doc = createSchematicDocument(module, { autoLayout });
    timings.push(performance.now() - start);
    if (i === runs - 1) {
      const heap = process.memoryUsage();
      return {
        timings,
        medianMs: timings.slice().sort((a, b) => a - b)[Math.floor(runs / 2)],
        wireCount: doc.wires.length,
        netLabelCount: doc.netLabels.length,
        heapUsedMb: Math.round((heap.heapUsed / 1024 / 1024) * 10) / 10,
      };
    }
  }
  throw new Error('unreachable');
}

const sizes = [100, 500];
const results: Array<Record<string, unknown>> = [];
for (const size of sizes) {
  const module = generateLargeModule(size);
  const noLayout = measureProjection(module, false);
  console.log(`[perf] ${size} components (autoLayout=false): median=${noLayout.medianMs.toFixed(1)}ms, wires=${noLayout.wireCount}, heapUsed=${noLayout.heapUsedMb}MB`);
  const entry: Record<string, unknown> = {
    componentCount: size,
    noLayoutMedianMs: noLayout.medianMs,
    noLayoutWireCount: noLayout.wireCount,
    noLayoutHeapMb: noLayout.heapUsedMb,
  };
  const withLayoutPolicy = measureProjection(module, true);
  entry.withLayoutPolicyMedianMs = withLayoutPolicy.medianMs;
  entry.withLayoutPolicyWireCount = withLayoutPolicy.wireCount;
  entry.withLayoutPolicyHeapMb = withLayoutPolicy.heapUsedMb;
  entry.autoLayoutApplied = size <= AUTO_LAYOUT_COMPONENT_LIMIT;
  console.log(`[perf] ${size} components (bounded autoLayout=true): median=${withLayoutPolicy.medianMs.toFixed(1)}ms, wires=${withLayoutPolicy.wireCount}, heapUsed=${withLayoutPolicy.heapUsedMb}MB`);
  assertPerformanceBudget(size, noLayout.medianMs, withLayoutPolicy.medianMs);
  results.push(entry);
}

function assertPerformanceBudget(size: number, noLayoutMs: number, policyMs: number): void {
  if (size !== 500) return;
  if (noLayoutMs >= 2000 || policyMs >= 2000) {
    throw new Error(`500-component projection exceeded 2s: ${noLayoutMs.toFixed(1)} / ${policyMs.toFixed(1)}ms`);
  }
}

console.log(JSON.stringify({
  ok: true,
  baseline: 'M6 bounded projection',
  autoLayoutComponentLimit: AUTO_LAYOUT_COMPONENT_LIMIT,
  results,
}, null, 2));
