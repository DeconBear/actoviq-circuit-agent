import type { CircuitModule } from '../../types';
import {
  deserializeSchematicDocument,
  type SchematicDocumentOptions,
} from '../../schematic/schematicDocument';
import { projectSchematicArtifact } from './facade';
import { scoreInteractiveProjection } from './interactiveQuality';

interface ProjectionRequest {
  type: 'project';
  requestId: number;
  module: CircuitModule;
  options?: SchematicDocumentOptions;
}

self.addEventListener('message', (event: MessageEvent<ProjectionRequest>) => {
  if (event.data.type !== 'project') return;
  const { requestId, module, options } = event.data;
  try {
    const artifact = projectSchematicArtifact(module, options);
    self.postMessage({
      type: 'result',
      requestId,
      artifact,
      quality: scoreInteractiveProjection(deserializeSchematicDocument(artifact)),
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
