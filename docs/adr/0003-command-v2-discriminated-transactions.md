# ADR-0003: `actoviq.command.v2` discriminated transactions

- Status: Accepted
- Date: 2026-07-28
- Baseline commit: `ac46e93fa374944e25bd731c652117d12497f4e8`
- Supersedes: none (keeps `actoviq.command.v1` readable via adapter)
- Related plan section: §5.1 UX-P0-04, §6.1.B, §6.2, §6.4

## Context

`actoviq.command.v1` (see `skills/circuit-design-ngspice/schemas/command.schema.json`)
enumerates an `op` string but allows `additionalProperties: true` on every
operation. The schema cannot reject a `place_component` that is missing its
position or a `move_component` that carries unrelated fields. The GUI save path
compounds this by collapsing an entire edit session into one coarse
`set_module_schematic` operation, which loses entity-level audit, diff, and
conflict resolution.

## Decision

Introduce `actoviq.command.v2` as a discriminated transaction schema. Each
operation is a `oneOf` branch with its own required fields, so schema validation
rejects missing or extraneous fields per operation type.

The v2 operation set includes at least:

- `place_component`
- `update_component`
- `move_entities` with `mode: "free" | "stretch"`
- `delete_entities`
- `create_wire`
- `edit_wire_path`
- `split_wire`
- `join_wires`
- `upsert_junction`
- `rename_net`
- `upsert_port`
- `place_module_instance`
- `set_module_metadata`

Each transaction carries:

- `base_revision`
- `module_id`
- `expected_module_revision` or an entity precondition
- an atomic list of operations
- a computable inverse
- affected entities and build scope
- actor, message, timestamp, and source

`actoviq.command.v1` remains readable through an adapter. Existing project
history is not migrated in bulk; v1 commands are interpreted on load and v2
transactions are written going forward. `set_module_schematic` is retained only
as an import/compatibility batch operation, not as the normal GUI save path.

## Consequences

- Each GUI edit becomes an auditable, reversible transaction instead of a
  whole-module replacement.
- Undo/redo and revision history share the same operation vocabulary (see
  ADR-0004).
- Agent patches can be compared and accepted/rejected at the transaction or
  entity level.
- Schema validation catches malformed operations at the boundary instead of
  silently persisting them.
- The backend must gain an atomic v2 commit path with entity precondition
  checks; this is scoped to M2.

## Alternatives considered

- Tighten v1 by removing `additionalProperties`. Rejected: v1 operations are too
  coarse (whole-module replace) and too few to express move/stretch/wire edits;
  tightening alone does not give entity-level audit.
- Migrate all v1 history to v2 in one step. Rejected: the plan explicitly
  forbids bulk migration of old project history; v1 stays readable via adapter.
