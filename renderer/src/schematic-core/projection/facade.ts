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

export interface SchematicEntityMap {
  schema: 'actoviq.schematic-entity-map.v1';
  module_id: string;
  module_revision: number;
  components: Array<{ entity_id: string; type: string }>;
  pins: Array<{
    entity_id: string;
    component_id: string;
    pin_id: string;
    net: string;
    net_id?: string;
  }>;
  ports: Array<{ entity_id: string; net: string; net_id?: string }>;
  nets: Array<{ entity_id: string; name: string }>;
  wires: Array<{ entity_id: string; net: string; net_id?: string }>;
  junctions: Array<{ entity_id: string }>;
}

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

/** Produce the formal serializable artifact consumed by build and export. */
export function projectSchematicArtifact(
  module: CircuitModule,
  options: SchematicDocumentOptions = {},
): SerializableSchematicDocument {
  return serializeSchematicDocument(projectSchematicDocument(module, options));
}

/**
 * Stable semantic map shared with compile/netlistsvg. Renderer-created SVG
 * paths and auto-routed display wires are deliberately excluded from identity.
 */
export function schematicEntityMap(document: SchematicDocument): SchematicEntityMap {
  const module = document.module;
  const junctionIds = new Set<string>();
  for (const wire of module.wires ?? []) {
    for (const endpoint of [wire.from, wire.to]) {
      if (endpoint?.junction_id) junctionIds.add(endpoint.junction_id);
    }
  }
  return {
    schema: 'actoviq.schematic-entity-map.v1',
    module_id: module.module_id,
    module_revision: module.revision,
    components: module.components
      .map((component) => ({ entity_id: component.id, type: component.type }))
      .sort((left, right) => left.entity_id.localeCompare(right.entity_id)),
    pins: module.components
      .flatMap((component) => component.pins.map((pin) => ({
        entity_id: `${component.id}.${pin.id}`,
        component_id: component.id,
        pin_id: pin.id,
        net: pin.net,
        ...(pin.net_id ? { net_id: pin.net_id } : {}),
      })))
      .sort((left, right) => left.entity_id.localeCompare(right.entity_id)),
    ports: module.ports
      .map((port) => ({
        entity_id: port.id,
        net: port.net,
        ...(port.net_id ? { net_id: port.net_id } : {}),
      }))
      .sort((left, right) => left.entity_id.localeCompare(right.entity_id)),
    nets: (module.nets ?? [])
      .map((net) => ({ entity_id: net.id, name: net.name }))
      .sort((left, right) => left.entity_id.localeCompare(right.entity_id)),
    wires: (module.wires ?? [])
      .map((wire) => ({
        entity_id: wire.id,
        net: wire.net ?? '',
        ...(wire.net_id ? { net_id: wire.net_id } : {}),
      }))
      .sort((left, right) => left.entity_id.localeCompare(right.entity_id)),
    junctions: [...junctionIds]
      .sort((left, right) => left.localeCompare(right))
      .map((entity_id) => ({ entity_id })),
  };
}

export function orderedConnectivitySnapshot(module: CircuitModule): string[][] {
  return [
    ...module.ports.map((port) => ['port', port.id, port.net_id ?? port.net]),
    ...module.components.flatMap((component) => component.pins.map((pin) => [
      'pin',
      component.stable_id ?? component.id,
      pin.id,
      pin.net_id ?? pin.net,
    ])),
  ];
}
