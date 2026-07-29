/**
 * M3-01 unit tests for the interaction state machine. Pure; no React/Electron.
 *
 * Each test asserts the allowed-event table and the reducer transitions.
 * Run:  npx tsx scripts/schematic-interaction-state-test.ts
 */
import assert from 'node:assert/strict';

import {
  allowedEventsForState,
  idleState,
  interactionStateFromSnapshot,
  interactionStatus,
  isEventAllowed,
  reduceInteraction,
  type InteractionEvent,
  type InteractionEventName,
  type InteractionStateName,
} from '../renderer/src/schematic-core/commands/interactionStateMachine';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${(error as Error).message}`);
  }
}

function ev(name: InteractionEvent['name'], point?: { x: number; y: number }, data?: Record<string, unknown>): InteractionEvent {
  return { name, point, data };
}

check('idle -> placing.component on tool-place', () => {
  const result = reduceInteraction(idleState(), ev('tool-place', { x: 100, y: 100 }, { componentType: 'R' }));
  assert.equal(result.state.name, 'placing.component');
  assert.equal(result.effects.some((e) => e.name === 'preview'), true);
});

check('placing.component commits on pointer-up and remains armed', () => {
  let result = reduceInteraction(idleState(), ev('tool-place', { x: 100, y: 100 }, { componentType: 'R' }));
  result = reduceInteraction(result.state, ev('pointer-up', { x: 120, y: 120 }));
  assert.equal(result.state.name, 'placing.component');
  assert.equal(result.effects.some((e) => e.name === 'commit'), true);
});

check('placing.component rotate rotates without committing', () => {
  let result = reduceInteraction(idleState(), ev('tool-place', { x: 100, y: 100 }, { componentType: 'M' }));
  result = reduceInteraction(result.state, ev('rotate'));
  assert.equal(result.state.name, 'placing.component');
  assert.equal(result.state.payload.rotation, 90);
  result = reduceInteraction(result.state, ev('rotate'));
  assert.equal(result.state.payload.rotation, 180);
});

check('escape cancels placing back to idle', () => {
  let result = reduceInteraction(idleState(), ev('tool-place', { x: 100, y: 100 }, { componentType: 'R' }));
  result = reduceInteraction(result.state, ev('escape'));
  assert.equal(result.state.name, 'idle');
  assert.equal(result.effects.some((e) => e.name === 'cancel'), true);
});

check('idle -> wiring.preview on tool-wire', () => {
  const result = reduceInteraction(idleState(), ev('tool-wire', { x: 0, y: 0 }));
  assert.equal(result.state.name, 'wiring.preview');
});

check('wiring.preview commits segment on pointer-up, final on enter', () => {
  let result = reduceInteraction(idleState(), ev('tool-wire', { x: 0, y: 0 }));
  result = reduceInteraction(result.state, ev('pointer-up', { x: 100, y: 0 }));
  assert.equal(result.state.name, 'wiring.preview');
  assert.equal(result.effects.some((e) => e.name === 'commit' && e.data?.final !== true), true);
  result = reduceInteraction(result.state, ev('enter', { x: 200, y: 0 }));
  assert.equal(result.effects.some((e) => e.name === 'commit' && e.data?.final === true), true);
  assert.equal(result.state.name, 'idle');
});

check('idle -> selecting.marquee on pointer-down', () => {
  const result = reduceInteraction(idleState(), ev('pointer-down', { x: 50, y: 50 }));
  assert.equal(result.state.name, 'selecting.marquee');
});

check('selecting.marquee commits on pointer-up', () => {
  let result = reduceInteraction(idleState(), ev('pointer-down', { x: 50, y: 50 }));
  result = reduceInteraction(result.state, ev('pointer-move', { x: 100, y: 100 }));
  result = reduceInteraction(result.state, ev('pointer-up', { x: 100, y: 100 }));
  assert.equal(result.state.name, 'idle');
  assert.equal(result.effects.some((e) => e.name === 'commit'), true);
});

check('idle -> panning on tool-pan, returns to idle on pointer-up', () => {
  let result = reduceInteraction(idleState(), ev('tool-pan', { x: 0, y: 0 }));
  assert.equal(result.state.name, 'panning');
  result = reduceInteraction(result.state, ev('pointer-up', { x: 50, y: 50 }));
  assert.equal(result.state.name, 'idle');
});

check('idle -> probing on tool-probe', () => {
  const result = reduceInteraction(idleState(), ev('tool-probe'));
  assert.equal(result.state.name, 'probing');
});

check('probing commits probe target on pointer-up', () => {
  let result = reduceInteraction(idleState(), ev('tool-probe'));
  result = reduceInteraction(result.state, ev('pointer-down', { x: 100, y: 100 }, { target: 'wire:w1' }));
  result = reduceInteraction(result.state, ev('pointer-up', { x: 100, y: 100 }));
  assert.equal(result.state.name, 'probing');
  assert.equal(result.effects.some((e) => e.name === 'commit' && e.data?.target === 'wire:w1'), true);
});

check('idle -> dialog on open-dialog, escape closes', () => {
  let result = reduceInteraction(idleState(), ev('open-dialog', undefined, { kind: 'block' }));
  assert.equal(result.state.name, 'dialog');
  result = reduceInteraction(result.state, ev('escape'));
  assert.equal(result.state.name, 'idle');
});

check('right-click in idle opens context menu, stays idle', () => {
  const result = reduceInteraction(idleState(), ev('right-click', { x: 100, y: 100 }));
  assert.equal(result.state.name, 'idle');
  assert.equal(result.effects.some((e) => e.name === 'open-context-menu'), true);
});

check('right-click in placing rotates without opening context menu', () => {
  let result = reduceInteraction(idleState(), ev('tool-place', { x: 100, y: 100 }, { componentType: 'R' }));
  result = reduceInteraction(result.state, ev('right-click', { x: 100, y: 100 }));
  assert.equal(result.state.name, 'placing.component');
  assert.equal(result.state.payload.rotation, 90);
  assert.equal(result.effects.some((e) => e.name === 'preview' && e.data?.rotate === true), true);
  assert.equal(result.effects.some((e) => e.name === 'open-context-menu'), false);
});

check('disallowed event is ignored', () => {
  // pointer-up in idle is not allowed
  const result = reduceInteraction(idleState(), ev('pointer-up', { x: 0, y: 0 }));
  assert.equal(result.state.name, 'idle');
  assert.equal(result.effects.length, 0);
});

check('escape always accepted (even from dialog)', () => {
  let result = reduceInteraction(idleState(), ev('open-dialog', undefined, { kind: 'block' }));
  result = reduceInteraction(result.state, ev('escape'));
  assert.equal(result.state.name, 'idle');
});

check('pointer-cancel always accepted and cancels', () => {
  let result = reduceInteraction(idleState(), ev('tool-place', { x: 100, y: 100 }, { componentType: 'R' }));
  result = reduceInteraction(result.state, ev('pointer-cancel'));
  assert.equal(result.state.name, 'idle');
  assert.equal(result.effects.some((e) => e.name === 'cancel'), true);
});

check('every state accepts escape and pointer-cancel', () => {
  const states: InteractionStateName[] = [
    'idle', 'selecting.marquee', 'placing.component', 'placing.module',
    'wiring.preview', 'moving.free', 'moving.stretch',
    'editing.wirePoint', 'editing.wireSegment', 'cutting', 'panning', 'probing', 'dialog',
  ];
  for (const s of states) {
    assert.equal(isEventAllowed(s, 'escape'), true, `${s} must accept escape`);
    assert.equal(isEventAllowed(s, 'pointer-cancel'), true, `${s} must accept pointer-cancel`);
  }
});

check('every state publishes a non-empty allowed-event table and modal status', () => {
  const states: InteractionStateName[] = [
    'idle', 'selecting.marquee', 'placing.component', 'placing.module',
    'wiring.preview', 'moving.free', 'moving.stretch',
    'editing.wirePoint', 'editing.wireSegment', 'cutting', 'panning', 'probing', 'dialog',
  ];
  for (const state of states) {
    const events = allowedEventsForState(state);
    assert.ok(events.length > 0, `${state} has no allowed events`);
    assert.ok(events.includes('escape'), `${state} omits escape`);
    assert.ok(events.includes('pointer-cancel'), `${state} omits pointer-cancel`);
    assert.ok(interactionStatus(state).length > 0, `${state} has no status`);
  }
});

check('allowed-event table rejects every undeclared event', () => {
  const events: InteractionEventName[] = [
    'pointer-down', 'pointer-move', 'pointer-up', 'pointer-cancel', 'escape',
    'right-click', 'enter', 'double-click', 'rotate', 'mirror', 'tool-select',
    'tool-wire', 'tool-cut', 'tool-place', 'tool-pan', 'tool-probe',
    'open-dialog', 'close-dialog',
  ];
  const allowed = new Set(allowedEventsForState('dialog'));
  for (const event of events) {
    assert.equal(isEventAllowed('dialog', event), allowed.has(event));
  }
});

check('legacy handler snapshot adapter has deterministic priority', () => {
  assert.equal(interactionStateFromSnapshot({ placing: 'component' }), 'placing.component');
  assert.equal(interactionStateFromSnapshot({ wiring: true, placing: 'component' }), 'wiring.preview');
  assert.equal(interactionStateFromSnapshot({ moving: 'free', wiring: true }), 'moving.free');
  assert.equal(interactionStateFromSnapshot({ dialogOpen: true, moving: 'stretch' }), 'dialog');
  assert.equal(interactionStateFromSnapshot({ cutting: true }), 'cutting');
});

check('moving.free preview emits free mode', () => {
  let result = reduceInteraction(idleState(), ev('tool-place', { x: 100, y: 100 }, { componentType: 'R' }));
  // Simulate entering moving.free by setting state directly via a tool event
  // is not supported; instead test that moving.free handles pointer-move.
  // We enter moving.free by dispatching a move from placing after pointer-down.
  // For unit coverage, reduce from a synthetic moving.free state.
  const movingFree = { name: 'moving.free' as InteractionStateName, payload: { mode: 'free' } };
  result = reduceInteraction(movingFree, ev('pointer-move', { x: 110, y: 110 }));
  assert.equal(result.state.name, 'moving.free');
  assert.equal(result.effects.some((e) => e.name === 'preview' && e.data?.mode === 'free'), true);
});

console.log(JSON.stringify({ ok: failed === 0, passed, failed, total: passed + failed }, null, 2));
if (failed > 0) process.exit(1);
