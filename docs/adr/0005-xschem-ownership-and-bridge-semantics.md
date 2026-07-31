# ADR-0005: Xschem ownership and bridge semantics

- Status: Amended (user-facing path superseded by Import/Export)
- Date: 2026-07-28
- Amended: 2026-07-31
- Baseline commit: `ac46e93fa374944e25bd731c652117d12497f4e8`
- Supersedes: none
- Related plan section: §4.2, §6.6, §7.2, §11

## Context

The IC platform plan originally shipped three Xschem peer modes: native, bridge,
and external, with explicit Push / Pull / Takeover. That peer panel is no longer
the desktop product path. Desktop users exchange `.sch` files through the same
**Import schematic** / **Export schematic** handoff used for other EDA formats.

Xschem attribute sets remain large and tool-specific. Opaque round-tripping
without executing unknown Tcl scripts is still the only safe default.

## Decision

Xschem is never a silent co-author of `actoviq.module.v2` (see ADR-0001).

**User-facing (current):**

- Actoviq `module.v2` remains the editable source of truth.
- Desktop Xschem integration is **file handoff only**: Export writes `.sch`
  (`schematic_handoff` → `render_xschem`); Import reads `.sch` into the active
  module (`import_xschem_into_module`). No live dual-write, no ownership modes
  in the GUI.
- Import preserves `ACTOVIQ_ID` when present; unmapped symbols become geometry
  BLOCK placeholders (`fidelity: geometry_blocks`), not a lossless SPICE
  topology claim.

**Legacy / non-GUI:**

- CLI `xschem-link` / `xschem-push` / `xschem-pull` and `schematic_peer`
  native/bridge/external bindings may still exist for older scripts. They are
  not the documented desktop or qualification workflow.
- Qualification uses **schematic-export → xschem-validate** on the exported
  `.sch`, with `metadata.handoff=schematic-export` and no topology writeback.
- Unknown Tcl / opaque attributes are never executed.

## Consequences

- Document and teach Import/Export, not peer Push/Pull UI.
- IC qualification may still call headless validate helpers until that gate is
  rewritten onto export + optional connectivity check without peer binding.
- Editor maturity is independent of Xschem feature parity.

## Alternatives considered

- Keep peer Push/Pull as the primary GUI. Rejected: replaced by unified
  schematic Import/Export for IC formats.
- Silent bidirectional sync. Rejected: second source of truth and script risk.
