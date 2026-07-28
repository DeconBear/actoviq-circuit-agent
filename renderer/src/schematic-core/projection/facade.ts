/**
 * Projection facade for the schematic core.
 *
 * This is the single entry point for turning an `actoviq.module.v2` into a
 * `SchematicDocument` (the `actoviq.schematic-document.v1` projection). The
 * facade delegates to the existing `createSchematicDocument` implementation
 * in `renderer/src/schematic/schematicDocument.ts` so the observable output
 * for the 20 fixtures does not change (M1-04 requirement).
 *
 * Why a facade: ADR-0002 makes the projection a versioned public surface.
 * New code should depend on `projectSchematicDocument` from this module, not
 * on the 5000-line `schematicDocument.ts` directly. M5 will converge the
 * interactive and netlistsvg renderers onto this facade so both paths share
 * one projection implementation.
 *
 * Migration path (not done in M1-04):
 *   1. Today: facade delegates to createSchematicDocument.
 *   2. M1-03/M3: move the pure projection logic into schematic-core.
 *   3. createSchematicDocument becomes a thin re-export of the facade.
 */

import type { CircuitModule } from '../../types';
import {
  createSchematicDocument,
  serializeSchematicDocument,
  type SchematicDocument,
  type SchematicDocumentOptions,
  type SerializableSchematicDocument,
} from '../../schematic/schematicDocument';

export {
  serializeSchematicDocument,
  type SchematicDocument,
  type SchematicDocumentOptions,
  type SerializableSchematicDocument,
};

/**
 * Project a module into a SchematicDocument (interactive projection).
 * Pure: does not mutate the input module. See ADR-0002.
 */
export function projectSchematicDocument(
  module: CircuitModule,
  options: SchematicDocumentOptions = {},
): SchematicDocument {
  return createSchematicDocument(module, options);
}
