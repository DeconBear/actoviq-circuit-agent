# ADR-0004: Unified undo and revision history

- Status: Accepted
- Date: 2026-07-28
- Baseline commit: `ac46e93fa374944e25bd731c652117d12497f4e8`
- Supersedes: none
- Related plan section: §3.1, §5.1 UX-P0-03, §6.4

## Context

Today there are three separate notions of "history":

1. Editor undo: up to 40 full `CircuitModule` snapshots in memory, cleared on
   save.
2. GUI save: one coarse `set_module_schematic` operation per session.
3. Project revision: independent persistent snapshots used for restore.

Because they are disconnected, saving clears undo, restore is not an undo, and
an Agent patch cannot be compared against the same operation vocabulary the user
just used. The user cannot undo across a save, and two actors editing the same
entity cannot get a structured conflict.

## Decision

Unify undo, redo, and revision around `actoviq.command.v2` transactions (see
ADR-0003):

- Pointer move produces only an ephemeral preview; it writes no history.
- Pointer up commits one transaction.
- Ctrl+Z submits that transaction's inverse; Ctrl+Y re-applies it. Behavior is
  identical before and after save; saving no longer clears history.
- A revision is a persistent checkpoint of several transactions, not a third
  history system.
- Restoring a revision still creates a new revision, preserving the audit chain.
- An Agent patch is displayed as the same operation diff and can be accepted or
  rejected per module or per transaction.
- While a user edits a module, a short-lived soft lease locks it; expiry is
  recoverable and a file lock never substitutes for UI semantics.

Inverse and affected scope are computed by the transaction reducer so that undo
only rebuilds the target module, not the whole project.

## Consequences

- `place -> move -> wire -> save -> reopen -> undo` yields the same result as
  applying each step's inverse, regardless of save boundaries.
- Revision history can show operation summaries and affected entities.
- Two actors editing the same entity from a stale revision get a structured
  conflict instead of a silent overwrite.
- History size is managed by an operation log plus periodic checkpoints, not by
  a full snapshot per pointer move.
- This is a behavior change for users who currently lose undo on save; M0
  captures the current behavior as expected-failure tests before M2 changes it.

## Alternatives considered

- Keep separate editor undo and revision systems and bridge them. Rejected: the
  bridge would still need a shared operation vocabulary, which is exactly what
  v2 transactions provide; a bridge without a shared vocabulary reproduces the
  current drift.
- Full deep-copy snapshot per edit (Xschem-style in-memory undo). Rejected: it
  scales poorly and cannot express entity-level diff or conflict.
