import type { CircuitModule } from '../../types';
import {
  deserializeSchematicDocument,
  type SerializableSchematicDocument,
  type SchematicDocumentOptions,
} from '../../schematic/schematicDocument';
import { projectSchematicArtifactIncremental } from './facade';
import {
  scoreInteractiveProjection,
  type InteractiveProjectionQuality,
} from './interactiveQuality';

interface ProjectionRequest {
  type: 'project';
  requestId: number;
  module: CircuitModule;
  options?: SchematicDocumentOptions;
}

const cache = new Map<string, {
  sourceModule: CircuitModule;
  artifact: SerializableSchematicDocument;
  quality: InteractiveProjectionQuality;
}>();

self.addEventListener('message', (event: MessageEvent<ProjectionRequest>) => {
  if (event.data.type !== 'project') return;
  const { requestId, module, options } = event.data;
  try {
    const previous = cache.get(module.module_id);
    const projection = projectSchematicArtifactIncremental(module, options, previous);
    const quality = projection.mode === 'incremental' && previous
      ? previous.quality
      : scoreInteractiveProjection(deserializeSchematicDocument(projection.artifact));
    cache.set(module.module_id, {
      sourceModule: JSON.parse(JSON.stringify(module)) as CircuitModule,
      artifact: projection.artifact,
      quality,
    });
    self.postMessage({
      type: 'result',
      requestId,
      artifact: projection.artifact,
      quality,
      mode: projection.mode,
      affectedEntities: projection.affectedEntities,
      reused: projection.reused,
    });
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export {};
