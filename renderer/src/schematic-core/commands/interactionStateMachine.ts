/**
 * Interaction state machine for the schematic editor (M3-01).
 *
 * Pure reducer: (state, event) -> { state, effects }.
 * No React, no DOM. The editor's gesture handlers will dispatch events into
 * this reducer and apply the emitted effects (preview, commit, cancel) -
 * plan §6.5. Each state declares the events it accepts; events outside that
 * set are ignored (logged, not thrown) so a stray pointer event can never
 * corrupt the state.
 *
 * States mirror plan §6.5:
 *   idle, selecting.marquee, placing.component, placing.module,
 *   wiring.preview, moving.free, moving.stretch,
 *   editing.wirePoint, editing.wireSegment, panning, probing, dialog
 */

export type InteractionStateName =
  | 'idle'
  | 'selecting.marquee'
  | 'placing.component'
  | 'placing.module'
  | 'wiring.preview'
  | 'moving.free'
  | 'moving.stretch'
  | 'editing.wirePoint'
  | 'editing.wireSegment'
  | 'panning'
  | 'probing'
  | 'dialog';

export interface InteractionState {
  name: InteractionStateName;
  /** Free-form payload per state (e.g. the component being placed). */
  payload: Record<string, unknown>;
}

export type InteractionEventName =
  | 'pointer-down'
  | 'pointer-move'
  | 'pointer-up'
  | 'pointer-cancel'
  | 'escape'
  | 'right-click'
  | 'enter'
  | 'double-click'
  | 'rotate'
  | 'mirror'
  | 'tool-select'
  | 'tool-wire'
  | 'tool-place'
  | 'tool-pan'
  | 'tool-probe'
  | 'open-dialog'
  | 'close-dialog';

export interface InteractionEvent {
  name: InteractionEventName;
  /** World-space point the event happened at, if a pointer event. */
  point?: { x: number; y: number };
  /** Free-form data (e.g. which component was hit). */
  data?: Record<string, unknown>;
}

export type InteractionEffectName =
  | 'preview'
  | 'commit'
  | 'cancel'
  | 'open-context-menu'
  | 'none';

export interface InteractionEffect {
  name: InteractionEffectName;
  data?: Record<string, unknown>;
}

export interface InteractionReducerResult {
  state: InteractionState;
  effects: InteractionEffect[];
}

/**
 * Events each state accepts. An event not in a state's set is ignored.
 * `pointer-cancel` and `escape` are always accepted (they cancel anything).
 */
const ALLOWED_EVENTS: Record<InteractionStateName, Set<InteractionEventName>> = {
  'idle': new Set(['pointer-down', 'tool-select', 'tool-wire', 'tool-place', 'tool-pan', 'tool-probe', 'open-dialog', 'right-click']),
  'selecting.marquee': new Set(['pointer-move', 'pointer-up', 'pointer-cancel', 'escape']),
  'placing.component': new Set(['pointer-move', 'pointer-up', 'rotate', 'mirror', 'escape', 'right-click', 'tool-select']),
  'placing.module': new Set(['pointer-move', 'pointer-up', 'rotate', 'mirror', 'escape', 'right-click', 'tool-select']),
  'wiring.preview': new Set(['pointer-move', 'pointer-up', 'enter', 'double-click', 'escape', 'right-click', 'tool-select']),
  'moving.free': new Set(['pointer-move', 'pointer-up', 'pointer-cancel', 'escape']),
  'moving.stretch': new Set(['pointer-move', 'pointer-up', 'pointer-cancel', 'escape']),
  'editing.wirePoint': new Set(['pointer-move', 'pointer-up', 'pointer-cancel', 'escape']),
  'editing.wireSegment': new Set(['pointer-move', 'pointer-up', 'pointer-cancel', 'escape']),
  'panning': new Set(['pointer-move', 'pointer-up', 'pointer-cancel', 'escape']),
  'probing': new Set(['pointer-down', 'pointer-up', 'escape', 'tool-select']),
  'dialog': new Set(['close-dialog', 'escape']),
};

const ALWAYS_ACCEPTED = new Set<InteractionEventName>(['pointer-cancel', 'escape']);

export function isEventAllowed(state: InteractionStateName, event: InteractionEventName): boolean {
  return ALWAYS_ACCEPTED.has(event) || ALLOWED_EVENTS[state]?.has(event) === true;
}

export function idleState(): InteractionState {
  return { name: 'idle', payload: {} };
}

function state(name: InteractionStateName, payload: Record<string, unknown> = {}): InteractionState {
  return { name, payload };
}

function effect(name: InteractionEffectName, data?: Record<string, unknown>): InteractionEffect {
  return { name, data };
}

/**
 * The pure reducer. Returns the next state and the effects to apply.
 * Unknown events in a state are ignored (return current state, no effects).
 */
export function reduceInteraction(prev: InteractionState, event: InteractionEvent): InteractionReducerResult {
  if (!isEventAllowed(prev.name, event.name)) {
    return { state: prev, effects: [] };
  }

  switch (prev.name) {
    case 'idle':
      switch (event.name) {
        case 'tool-select':
          return { state: state('idle'), effects: [] };
        case 'tool-wire':
          return { state: state('wiring.preview', { startPoint: event.point, points: event.point ? [event.point] : [] }), effects: [effect('preview', { tool: 'wire' })] };
        case 'tool-place':
          return { state: state('placing.component', { componentType: event.data?.componentType, position: event.point }), effects: [effect('preview', { componentType: event.data?.componentType })] };
        case 'tool-pan':
          return { state: state('panning', { start: event.point }), effects: [] };
        case 'tool-probe':
          return { state: state('probing'), effects: [] };
        case 'pointer-down':
          return { state: state('selecting.marquee', { start: event.point, current: event.point }), effects: [effect('preview', { marquee: true })] };
        case 'open-dialog':
          return { state: state('dialog', { kind: event.data?.kind }), effects: [] };
        case 'right-click':
          return { state: prev, effects: [effect('open-context-menu', { point: event.point })] };
        default:
          return { state: prev, effects: [] };
      }

    case 'selecting.marquee':
      switch (event.name) {
        case 'pointer-move':
          return { state: state('selecting.marquee', { ...prev.payload, current: event.point }), effects: [effect('preview', { marquee: true })] };
        case 'pointer-up':
          return { state: state('idle'), effects: [effect('commit', { marquee: true, rect: prev.payload })] };
        case 'pointer-cancel':
        case 'escape':
          return { state: state('idle'), effects: [effect('cancel')] };
        default:
          return { state: prev, effects: [] };
      }

    case 'placing.component':
    case 'placing.module':
      switch (event.name) {
        case 'pointer-move':
          return { state: state(prev.name, { ...prev.payload, position: event.point }), effects: [effect('preview', { position: event.point })] };
        case 'rotate':
          return { state: state(prev.name, { ...prev.payload, rotation: ((prev.payload.rotation as number | undefined) ?? 0) + 90 }), effects: [effect('preview', { rotate: true })] };
        case 'mirror':
          return { state: state(prev.name, { ...prev.payload, mirrored: true }), effects: [effect('preview', { mirror: true })] };
        case 'pointer-up':
          return { state: state('idle'), effects: [effect('commit', { placed: prev.payload })] };
        case 'tool-select':
        case 'right-click':
        case 'pointer-cancel':
        case 'escape':
          return { state: state('idle'), effects: [effect('cancel')] };
        default:
          return { state: prev, effects: [] };
      }

    case 'wiring.preview':
      switch (event.name) {
        case 'pointer-move':
          return { state: state('wiring.preview', { ...prev.payload, current: event.point }), effects: [effect('preview', { wire: true, current: event.point })] };
        case 'pointer-up':
        case 'enter':
        case 'double-click':
          return { state: state('wiring.preview', { ...prev.payload, lastCommit: event.point }), effects: [effect('commit', { wireSegment: true, point: event.point, final: event.name === 'enter' || event.name === 'double-click' })] };
        case 'tool-select':
        case 'right-click':
        case 'pointer-cancel':
        case 'escape':
          return { state: state('idle'), effects: [effect('cancel')] };
        default:
          return { state: prev, effects: [] };
      }

    case 'moving.free':
    case 'moving.stretch':
    case 'editing.wirePoint':
    case 'editing.wireSegment':
      switch (event.name) {
        case 'pointer-move':
          return { state: state(prev.name, { ...prev.payload, current: event.point }), effects: [effect('preview', { move: true, mode: prev.name === 'moving.free' ? 'free' : prev.name === 'moving.stretch' ? 'stretch' : 'edit' })] };
        case 'pointer-up':
          return { state: state('idle'), effects: [effect('commit', { move: true, mode: prev.payload.mode })] };
        case 'pointer-cancel':
        case 'escape':
          return { state: state('idle'), effects: [effect('cancel')] };
        default:
          return { state: prev, effects: [] };
      }

    case 'panning':
      switch (event.name) {
        case 'pointer-move':
          return { state: state('panning', { ...prev.payload, current: event.point }), effects: [effect('preview', { pan: true })] };
        case 'pointer-up':
          return { state: state('idle'), effects: [] };
        case 'pointer-cancel':
        case 'escape':
          return { state: state('idle'), effects: [effect('cancel')] };
        default:
          return { state: prev, effects: [] };
      }

    case 'probing':
      switch (event.name) {
        case 'pointer-down':
          return { state: state('probing', { target: event.data?.target }), effects: [effect('preview', { probe: true })] };
        case 'pointer-up':
          return { state: state('probing'), effects: [effect('commit', { probe: true, target: prev.payload.target })] };
        case 'tool-select':
        case 'pointer-cancel':
        case 'tool-select':
        case 'escape':
          return { state: state('idle'), effects: [effect('cancel')] };
        default:
          return { state: prev, effects: [] };
      }

    case 'dialog':
      switch (event.name) {
        case 'close-dialog':
        case 'escape':
          return { state: state('idle'), effects: [] };
        default:
          return { state: prev, effects: [] };
      }

    default:
      return { state: prev, effects: [] };
  }
}
