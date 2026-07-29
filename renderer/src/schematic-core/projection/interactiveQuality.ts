import { componentBounds, type SchematicDocument } from '../../schematic/schematicDocument';

export interface InteractiveProjectionQuality {
  readabilityScore: number;
  componentOverlapCount: number;
  wireBendCount: number;
  danglingEndpointCount: number;
}

export function scoreInteractiveProjection(
  document: SchematicDocument,
): InteractiveProjectionQuality {
  const bounds = document.module.components.map(componentBounds);
  let componentOverlapCount = 0;
  for (let left = 0; left < bounds.length; left += 1) {
    const leftBounds = bounds[left]!;
    for (let right = left + 1; right < bounds.length; right += 1) {
      const rightBounds = bounds[right]!;
      if (
        leftBounds.minX < rightBounds.maxX
        && leftBounds.maxX > rightBounds.minX
        && leftBounds.minY < rightBounds.maxY
        && leftBounds.maxY > rightBounds.minY
      ) {
        componentOverlapCount += 1;
      }
    }
  }
  const wireBendCount = document.wires.reduce(
    (total, wire) => total + Math.max(0, wire.points.length - 2),
    0,
  );
  const danglingEndpointCount = document.wires.reduce(
    (total, wire) => total + [wire.from, wire.to].filter((endpoint) => (
      endpoint
      && !endpoint.component_id
      && !endpoint.port_id
      && !endpoint.junction_id
    )).length,
    0,
  );
  const penalty = (
    Math.min(50, componentOverlapCount * 2)
    + Math.min(25, wireBendCount * 0.05)
    + Math.min(25, danglingEndpointCount * 2)
  );
  return {
    readabilityScore: Math.max(0, Math.round((100 - penalty) * 10) / 10),
    componentOverlapCount,
    wireBendCount,
    danglingEndpointCount,
  };
}
