# Actoviq Architecture Decision Records

This directory records architectural decisions for the Actoviq circuit agent,
focused on the schematic editor interaction gap and refactor plan tracked in
`plan/schematic-editor-interaction-gap-and-refactor-plan.md`.

ADRs are immutable once linked from a shipped milestone. supersede an ADR by
adding a new one and updating the index below, never by editing the prior file.

## Index

- [ADR-0001 — `actoviq.module.v2` is the sole editing source of truth](0001-module-v2-is-sole-source-of-truth.md)
- [ADR-0002 — `actoviq.schematic-document.v1` is the projection boundary](0002-schematic-document-v1-projection-boundary.md)
- [ADR-0003 — `actoviq.command.v2` discriminated transactions](0003-command-v2-discriminated-transactions.md)
- [ADR-0004 — Unified undo and revision history](0004-unified-undo-and-revision-history.md)
- [ADR-0005 — Xschem ownership and bridge semantics](0005-xschem-ownership-and-bridge-semantics.md)
