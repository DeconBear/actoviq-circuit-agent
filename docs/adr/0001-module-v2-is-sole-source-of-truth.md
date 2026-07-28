# ADR-0001: `actoviq.module.v2` is the sole editing source of truth

- Status: Accepted
- Date: 2026-07-28
- Baseline commit: `ac46e93fa374944e25bd731c652117d12497f4e8`
- Supersedes: none
- Related plan section: §3.1, §6.1, §6.6

## Context

The schematic editor, the AI/netlist compile chain, the project persistence
backend, and the legacy `schematic.overrides.json` flow can all mutate circuit
state. Before this decision they did so through different entry points:

- `SchematicEditor.tsx` mutates a local draft and, on save, calls
  `set_module_schematic` to replace the whole module body.
- `compile-module` consumes `actoviq.module.v2` to produce SPICE / netlist JSON.
- `netlistsvg` consumes the netlist JSON plus legacy overrides for export SVG.
- The project backend stores revision snapshots independently of editor undo.

That ambiguity lets SVG DOM, override JSON, and React state leak back into the
notion of "current design", which makes entity-level diff, conflict detection,
and deterministic rebuilds unreliable.

## Decision

`actoviq.module.v2` is the only structure that may be treated as the editable
source of truth for a circuit module. Every other representation is a
projection:

- `actoviq.schematic-document.v1` is a derived display projection (see ADR-0002).
- SPICE / netlist JSON is a derived compile artifact.
- Interactive SVG and netlistsvg SVG are renderings of those projections.
- `schematic.overrides.json` is an import/export compatibility artifact only,
  not a primary desktop edit path.
- React component state is ephemeral interaction state, never a source of truth.

Manual edits write structured `actoviq.module.v2` data first, then rebuild
Design/SVG previews through the shared projection and the existing compiler and
rendering pipeline. No new code path may write SVG, DOM, or override data back
into the module as if it were truth.

## Consequences

- Entity-level diff and conflict detection can rely on module content alone.
- Rebuilds are deterministic given a module revision.
- The AI/netlist to `compile-module` to netlistsvg SVG path stays intact because
  it already consumes module v2.
- Legacy override editing must remain compatibility/export-only; new desktop
  editing features must not extend it.
- `actoviq.module.v2` content must not be changed by this decision; only the
  contracts around it are clarified.

## Alternatives considered

- Treat the interactive SVG as truth and derive module data from it. Rejected:
  SVG carries rendering-only concerns (halos, handle dots, viewport) that should
  never round-trip into module data, and netlistsvg already proved that a single
  rendering format cannot serve both interaction and export without drift.
- Treat `schematic.overrides.json` as a co-equal source. Rejected: it has no
  operation audit, no entity-level precondition, and its undo model is
  independent of both editor undo and project revision.
