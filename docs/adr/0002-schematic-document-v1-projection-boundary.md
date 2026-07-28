# ADR-0002: `actoviq.schematic-document.v1` is the projection boundary

- Status: Accepted
- Date: 2026-07-28
- Baseline commit: `ac46e93fa374944e25bd731c652117d12497f4e8`
- Supersedes: none
- Related plan section: §3.1, §5.1 UX-P0-05, §6.1.A, §6.6

## Context

`actoviq.schematic-document.v1` currently exists only as TypeScript types and
functions in `renderer/src/schematic/schematicDocument.ts`. There is no formal
JSON Schema and no cross-implementation consistency contract. As a result:

- The interactive TypeScript projection and the Python/netlistsvg export path
  are two independent implementations of "what the schematic looks like".
- There is no golden parity check that the two paths agree on
  component/pin/net/junction sets for the same module.
- Drift between the two can only be caught by humans reading SVG output.

## Decision

`actoviq.schematic-document.v1` is the formal projection boundary between
`actoviq.module.v2` (truth, see ADR-0001) and every renderer. It is governed by
a JSON Schema at
`skills/circuit-design-ngspice/schemas/schematic-document.schema.json` and by
golden fixtures.

Rules for the projection:

- Input is `actoviq.module.v2` plus projection options only.
- Output contains only reconstructible geometry, style semantics, entity
  mapping, and diagnostics. It must not carry React state, SVG DOM, or
  netlistsvg-private format.
- Neither the interactive SVG renderer nor the netlistsvg export may write back
  to the projection or to the module.
- Both rendering paths consume the same serialized projection artifact for
  parity testing; pixel-identical output is explicitly not a goal, but the
  component, pin, net, and junction sets must match for the same fixture.

The existing `createSchematicDocument` TypeScript function is the reference
projection. During M1 it will be refactored to delegate to a pure
`schematic-core` projection facade, but its observable output for the 20
fixtures must not change without a golden update.

## Consequences

- A single schema becomes the contract that TypeScript, Python, and netlistsvg
  adapters must satisfy.
- Parity between interactive and export rendering becomes testable as data, not
  as pixels.
- Adding a new renderer only requires consuming the projection, not rederiving
  connectivity or layout.
- The projection format is now a versioned public surface; breaking changes
  require a new schema version or an explicit migration.

## Alternatives considered

- Keep the projection as TypeScript-only types. Rejected: the Python compile
  chain and netlistsvg cannot share a TypeScript type, so drift stays
  undetected.
- Make netlistsvg the projection. Rejected: netlistsvg owns the export SVG
  format and its private layout decisions; promoting it would couple
  interactive editing to an export renderer and block M5 convergence.
