import type { CircuitModule } from '../../types';

export interface SchematicComplexity {
  componentCount: number;
  storedWireCount: number;
  wireSegmentCount: number;
  hierarchyRecommended: boolean;
  reason?: string;
}

export function analyzeSchematicComplexity(module: CircuitModule): SchematicComplexity {
  const wireSegmentCount = (module.wires ?? []).reduce(
    (total, wire) => total + Math.max(0, wire.points.length - 1),
    0,
  );
  const hierarchyRecommended = module.components.length >= 250 || wireSegmentCount >= 2500;
  return {
    componentCount: module.components.length,
    storedWireCount: module.wires?.length ?? 0,
    wireSegmentCount,
    hierarchyRecommended,
    reason: hierarchyRecommended
      ? `${module.components.length} components / ${wireSegmentCount} stored wire segments exceed the single-sheet guidance`
      : undefined,
  };
}
