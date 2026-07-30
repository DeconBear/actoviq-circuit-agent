/**
 * Compatibility surface for historical schematic-document imports.
 *
 * Projection calls delegate to schematic-core/projection/facade so old and
 * new consumers cross the same versioned boundary. Pure implementation and
 * helper exports live in schematicDocumentImpl.
 */
import type { CircuitModule } from '../types';
import { projectSchematicDocument } from '../schematic-core/projection/facade';
import type {
  SchematicDocument,
  SchematicDocumentOptions,
} from './schematicDocumentImpl';

export * from './schematicDocumentImpl';

export function createSchematicDocument(
  module: CircuitModule,
  options: SchematicDocumentOptions = {},
): SchematicDocument {
  return projectSchematicDocument(module, options);
}
