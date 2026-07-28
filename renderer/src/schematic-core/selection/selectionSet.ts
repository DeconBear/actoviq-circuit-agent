/**
 * Typed selection set for the schematic core.
 *
 * Qucs-S lesson (plan §4.1.4): components, wires, nodes, labels etc. should
 * be maintained as separate typed collections that can still be moved as a
 * group. This module defines the canonical SelectionSet so selection state
 * does not get scattered across React components.
 *
 * Pure data + helpers; no React, no mutation of external state.
 */

export type SelectionKind = 'component' | 'wire' | 'port' | 'netLabel' | 'junction';

export interface SelectionSet {
  components: Set<string>;
  wires: Set<string>;
  ports: Set<string>;
  netLabels: Set<string>;
  junctions: Set<string>;
}

const KIND_TO_KEY: Record<SelectionKind, keyof SelectionSet> = {
  component: 'components',
  wire: 'wires',
  port: 'ports',
  netLabel: 'netLabels',
  junction: 'junctions',
};

function setFor(selection: SelectionSet, kind: SelectionKind): Set<string> {
  return selection[KIND_TO_KEY[kind]];
}

export function emptySelection(): SelectionSet {
  return {
    components: new Set(),
    wires: new Set(),
    ports: new Set(),
    netLabels: new Set(),
    junctions: new Set(),
  };
}

export function cloneSelection(selection: SelectionSet): SelectionSet {
  return {
    components: new Set(selection.components),
    wires: new Set(selection.wires),
    ports: new Set(selection.ports),
    netLabels: new Set(selection.netLabels),
    junctions: new Set(selection.junctions),
  };
}

export function selectionSize(selection: SelectionSet): number {
  return (
    selection.components.size +
    selection.wires.size +
    selection.ports.size +
    selection.netLabels.size +
    selection.junctions.size
  );
}

export function selectionIsEmpty(selection: SelectionSet): boolean {
  return selectionSize(selection) === 0;
}

export function toggleSelection(selection: SelectionSet, kind: SelectionKind, id: string): SelectionSet {
  const next = cloneSelection(selection);
  const set = setFor(next, kind);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  return next;
}

export function addToSelection(selection: SelectionSet, kind: SelectionKind, ids: string[]): SelectionSet {
  const next = cloneSelection(selection);
  const set = setFor(next, kind);
  for (const id of ids) set.add(id);
  return next;
}

export function clearSelection(selection: SelectionSet): SelectionSet {
  return emptySelection();
}

export function allSelectedIds(selection: SelectionSet): string[] {
  return [
    ...selection.components,
    ...selection.wires,
    ...selection.ports,
    ...selection.netLabels,
    ...selection.junctions,
  ];
}
