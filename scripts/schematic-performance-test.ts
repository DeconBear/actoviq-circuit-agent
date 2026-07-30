import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import type { CircuitModule, CircuitModuleRef } from '../renderer/src/types';
import { resolveSystemNetworks } from '../renderer/src/schematic-core/connectivity/modulePortGraph';
import { analyzeSchematicComplexity } from '../renderer/src/schematic-core/performance/complexity';
import {
  deriveLiveErc,
  deriveLiveErcIncremental,
} from '../renderer/src/schematic-core/diagnostics/liveErc';
import {
  projectSchematicArtifact,
  projectSchematicDocument,
  projectSchematicDocumentIncremental,
  serializeSchematicDocument,
} from '../renderer/src/schematic-core/projection/facade';
import {
  ProjectionWorkerClient,
  type ProjectionWorkerLike,
} from '../renderer/src/schematic-core/projection/projectionWorkerClient';
import { scoreInteractiveProjection } from '../renderer/src/schematic-core/projection/interactiveQuality';
import {
  danglingWireEnds,
  junctions,
  pinConnectionVisuals,
  unconnectedCrossings,
} from '../renderer/src/schematic/SchematicDocumentSvg';

function largeModule(componentCount: number): CircuitModule {
  return {
    schema: 'actoviq.module.v2',
    module_id: `large_${componentCount}`,
    name: `Large ${componentCount}`,
    revision: 0,
    ports: [],
    nets: [],
    components: Array.from({ length: componentCount }, (_, index) => ({
      id: `r${index}`,
      type: 'R' as const,
      name: `R${index}`,
      value: '1k',
      position: { x: (index % 25) * 80, y: Math.floor(index / 25) * 80 },
      rotation: 0,
      pins: [
        { id: 'a', name: '1', net: `n${index}` },
        { id: 'b', name: '2', net: `n${index + 1}` },
      ],
    })),
    wires: [],
    annotations: [],
  };
}

const module500 = largeModule(500);
const started = performance.now();
const document500 = projectSchematicDocument(module500);
const projectionMs = performance.now() - started;
assert.equal(document500.module.components.length, 500);
assert.ok(projectionMs < 2000, `500-component projection took ${projectionMs.toFixed(1)}ms`);
const ercStarted = performance.now();
deriveLiveErc(document500);
const ercMs = performance.now() - ercStarted;
assert.ok(ercMs < 2000, `500-component live ERC took ${ercMs.toFixed(1)}ms`);

const incrementalBase = projectSchematicDocumentIncremental(
  module500,
  { autoLayout: false },
);
assert.equal(incrementalBase.mode, 'full');
const propertyEditModule = structuredClone(module500);
propertyEditModule.revision = 1;
propertyEditModule.components[250]!.value = '2k';
propertyEditModule.components[250]!.parameters = { magnitude: '2k' };
const incrementalStarted = performance.now();
const propertyProjection = projectSchematicDocumentIncremental(
  propertyEditModule,
  { autoLayout: false },
  incrementalBase.snapshot,
);
const incrementalProjectionMs = performance.now() - incrementalStarted;
assert.equal(propertyProjection.mode, 'incremental');
assert.equal(propertyProjection.reused.routing, true);
assert.ok(propertyProjection.affectedEntities.includes('r250'));
assert.deepEqual(
  projectSchematicArtifact(propertyEditModule, { autoLayout: false }),
  serializeSchematicDocument(propertyProjection.document),
  'incremental property projection must remain identical to the canonical full projection',
);
const incrementalErc = deriveLiveErcIncremental(
  propertyProjection.document,
  propertyProjection,
  deriveLiveErc(incrementalBase.document),
);
assert.equal(incrementalErc.mode, 'incremental');
assert.deepEqual(incrementalErc.diagnostics, deriveLiveErc(propertyProjection.document));

const geometryEditModule = structuredClone(propertyEditModule);
geometryEditModule.revision = 2;
geometryEditModule.components[250]!.position.x += 20;
const geometryProjection = projectSchematicDocumentIncremental(
  geometryEditModule,
  { autoLayout: false },
  propertyProjection.snapshot,
);
assert.equal(geometryProjection.mode, 'full', 'geometry edits must use the canonical full projector');

const mosBaseModule = structuredClone(module500);
mosBaseModule.components[0] = {
  ...mosBaseModule.components[0]!,
  id: 'm0',
  type: 'M',
  name: 'M0',
  value: 'NMOS W=1u L=180n',
  pins: [
    { id: 'd', name: 'D', net: 'n0' },
    { id: 'g', name: 'G', net: 'n1' },
    { id: 's', name: 'S', net: '0' },
    { id: 'b', name: 'B', net: '0' },
  ],
};
const mosBaseProjection = projectSchematicDocumentIncremental(mosBaseModule, { autoLayout: false });
const mosPolarityEdit = structuredClone(mosBaseModule);
mosPolarityEdit.components[0]!.value = 'PMOS W=1u L=180n';
assert.equal(
  projectSchematicDocumentIncremental(mosPolarityEdit, { autoLayout: false }, mosBaseProjection.snapshot).mode,
  'full',
  'MOS polarity edits must not reuse drain/source geometry',
);

const autoLayoutBase = largeModule(2);
const autoLayoutProjection = projectSchematicDocumentIncremental(autoLayoutBase);
const autoLayoutEdit = structuredClone(autoLayoutBase);
autoLayoutEdit.components[0]!.value = '3k';
assert.equal(
  projectSchematicDocumentIncremental(autoLayoutEdit, {}, autoLayoutProjection.snapshot).mode,
  'full',
  'auto-layout inputs must not reuse a projection whose profile may change',
);
const topologyStarted = performance.now();
const renderedJunctions = junctions(document500);
const junctionMs = performance.now() - topologyStarted;
const crossingsStarted = performance.now();
const renderedCrossings = unconnectedCrossings(document500);
const crossingsMs = performance.now() - crossingsStarted;
const endpointsStarted = performance.now();
const renderedDanglingEnds = danglingWireEnds(document500);
const renderedPinStates = pinConnectionVisuals(document500);
const endpointVisualMs = performance.now() - endpointsStarted;

const mixedRouteModule = largeModule(500);
mixedRouteModule.wires = [{
  ...document500.wires[0]!,
  source: 'stored',
}];
const mixedRouteStarted = performance.now();
const mixedRouteDocument = projectSchematicDocument(mixedRouteModule, { autoLayout: false });
const mixedRouteProjectionMs = performance.now() - mixedRouteStarted;
assert.equal(mixedRouteDocument.wires.length, 499);
assert.ok(
  mixedRouteProjectionMs < 2000,
  `500-component mixed stored/implicit projection took ${mixedRouteProjectionMs.toFixed(1)}ms`,
);

const segmented = largeModule(20);
segmented.wires = Array.from({ length: 100 }, (_, wireIndex) => ({
  id: `w${wireIndex}`,
  net: `wire_net_${wireIndex}`,
  points: Array.from({ length: 51 }, (_, pointIndex) => ({
    x: pointIndex * 20,
    y: wireIndex * 20,
  })),
}));
const complexity = analyzeSchematicComplexity(segmented);
assert.equal(complexity.wireSegmentCount, 5000);
assert.equal(complexity.hierarchyRecommended, true);

const modules: CircuitModuleRef[] = Array.from({ length: 20 }, (_, index) => ({
  id: `m${index}`,
  name: `Module ${index}`,
  kind: 'leaf',
  source: `modules/m${index}/module.circuit.json`,
  position: { x: index * 40, y: 0 },
  size: { width: 320, height: 220 },
  ports: [
    { id: 'in', name: 'IN', direction: 'input', signal_type: 'analog', net: `in_${index}`, net_id: `net_in_${index}` },
    { id: 'out', name: 'OUT', direction: 'output', signal_type: 'analog', net: `out_${index}`, net_id: `net_out_${index}` },
  ],
}));
const connections = Array.from({ length: 19 }, (_, index) => ({
  id: `c${index}`,
  from: { module_id: `m${index}`, port_id: 'out' },
  to: { module_id: `m${index + 1}`, port_id: 'in' },
  network: `stage_${index}`,
}));
const graph = resolveSystemNetworks(modules, connections);
assert.equal(graph['m0::out']?.endpoints.length, 2);
assert.equal(graph['m0::out']?.label, 'stage_0');
assert.deepEqual(graph['m0::out']?.net_ids.sort(), ['net_in_1', 'net_out_0']);

class FakeWorker implements ProjectionWorkerLike {
  listener: ((event: MessageEvent) => void) | null = null;
  posted: Array<{ requestId: number }> = [];

  postMessage(value: unknown): void {
    this.posted.push(value as { requestId: number });
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listener = listener;
  }

  removeEventListener(): void {
    this.listener = null;
  }

  emit(data: unknown): void {
    this.listener?.({ data } as MessageEvent);
  }
}

const fakeWorker = new FakeWorker();
const client = new ProjectionWorkerClient(fakeWorker);
const abortController = new AbortController();
const staleRequest = client.project(largeModule(1), {}, abortController.signal);
const staleId = fakeWorker.posted.at(-1)?.requestId;
abortController.abort();
await assert.rejects(staleRequest, (error: unknown) => (
  error instanceof DOMException && error.name === 'AbortError'
));
fakeWorker.emit({
  type: 'result',
  requestId: staleId,
  artifact: projectSchematicArtifact(largeModule(1)),
  quality: scoreInteractiveProjection(projectSchematicDocument(largeModule(1))),
});

const currentModule = largeModule(2);
const currentRequest = client.project(currentModule);
const currentId = fakeWorker.posted.at(-1)?.requestId;
fakeWorker.emit({
  type: 'result',
  requestId: currentId,
  artifact: projectSchematicArtifact(currentModule),
  quality: scoreInteractiveProjection(projectSchematicDocument(currentModule)),
});
const currentResult = await currentRequest;
assert.equal(currentResult.document.module.components.length, 2);
assert.ok(currentResult.quality.readabilityScore >= 0);
client.dispose();

console.log(JSON.stringify({
  ok: true,
  suite: 'schematic-performance',
  componentCount: 500,
  projectionMs: Math.round(projectionMs * 10) / 10,
  ercMs: Math.round(ercMs * 10) / 10,
  junctionMs: Math.round(junctionMs * 10) / 10,
  crossingsMs: Math.round(crossingsMs * 10) / 10,
  endpointVisualMs: Math.round(endpointVisualMs * 10) / 10,
  mixedRouteProjectionMs: Math.round(mixedRouteProjectionMs * 10) / 10,
  incrementalProjectionMs: Math.round(incrementalProjectionMs * 10) / 10,
  renderedJunctionCount: renderedJunctions.length,
  renderedCrossingCount: renderedCrossings.length,
  renderedDanglingEndCount: renderedDanglingEnds.length,
  renderedPinStateCount: renderedPinStates.length,
  moduleCount: 20,
  wireSegmentCount: complexity.wireSegmentCount,
  staleWorkerResultIgnored: true,
  workerQualityScored: true,
  propertyProjectionIncremental: true,
  propertyErcIncremental: true,
  geometryChangeFallsBackToFull: true,
  hierarchyAdviceOnly: true,
}, null, 2));
