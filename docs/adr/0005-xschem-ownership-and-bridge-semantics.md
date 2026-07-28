# ADR-0005: Xschem ownership and bridge semantics

- Status: Accepted
- Date: 2026-07-28
- Baseline commit: `ac46e93fa374944e25bd731c652117d12497f4e8`
- Supersedes: none
- Related plan section: §4.2, §6.6, §7.2, §11

## Context

The IC platform plan (`plan/actoviq-ic-platform-implementation-plan.md`) ships
three Xschem modes: native, bridge, and external. The bridge adapter passing
local regression does not mean the bridge is a substitute for a mature
interactive editor. Complex topologies still require human review in Xschem,
which is a reasonable boundary but must be stated explicitly so the editor does
not silently treat Xschem as a second source of truth.

Xschem attribute sets are also large and tool-specific. Opaque round-tripping
without executing unknown Tcl scripts is the only safe default.

## Decision

Xschem is never a silent co-author of `actoviq.module.v2` (see ADR-0001).
Ownership rules:

- The Actoviq editor is the primary authoring surface for module v2.
- Xschem is an external peer editor. Synchronization is explicit: Push, Pull,
  or Takeover are user-initiated operations with visible diffs.
- The bridge never executes unknown Xschem Tcl scripts. Attributes that cannot
  be mapped are stored opaquely and surfaced as unverified, not guessed.
- Xschem native mode is a qualification target for real PDK environments, not a
  replacement for the interactive editor's maturity.
- Complex topology review in Xschem is an expected workflow boundary, not a
  defect.

`plan/actoviq-ic-platform-implementation-plan.md`'s "GUI entry complete" is
split into two layers: IC flow control plane (local code and contracts done,
real environment pending qualification) and IC schematic authoring core (still
has the P0/P1 gaps listed in this plan).

## Consequences

- The editor refactor can proceed without blocking on Xschem feature parity.
- Users always know when Xschem has written to a module because it is an
  explicit operation, not a background sync.
- PDK and Xschem qualification is scoped to M7 and requires a real Linux, PDK,
  and licensed-tool environment.
- The bridge adapter keeps its current opaque-save contract; no new code path
  interprets Xschem scripts.

## Alternatives considered

- Make Xschem bridge a silent bidirectional sync. Rejected: silent sync makes
  Xschem a second source of truth, which breaks entity-level diff and conflict
  detection and risks executing unknown scripts.
- Block the editor refactor on Xschem parity. Rejected: the editor's
  interaction gaps are independent of Xschem and are the critical path for
  professional schematic editing.
