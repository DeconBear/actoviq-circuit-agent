import { z } from 'zod';

const boundedGridDeltaSchema = z.number().int().min(-6).max(6);
const objectIdSchema = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: 'Object IDs cannot contain only whitespace.',
});

const moveComponentSchema = z.object({
  op: z.literal('move_component'),
  component_id: objectIdSchema,
  dx_grid: boundedGridDeltaSchema,
  dy_grid: boundedGridDeltaSchema,
}).strict();

const rotateComponentSchema = z.object({
  op: z.literal('rotate_component'),
  component_id: objectIdSchema,
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
}).strict();

const movePortSchema = z.object({
  op: z.literal('move_port'),
  port_id: objectIdSchema,
  dx_grid: boundedGridDeltaSchema,
  dy_grid: boundedGridDeltaSchema,
}).strict();

const setBlockPinSideSchema = z.object({
  op: z.literal('set_block_pin_side'),
  component_id: objectIdSchema,
  pin_id: objectIdSchema,
  side: z.enum(['left', 'right', 'top', 'bottom']),
}).strict();

const setLayoutLaneSchema = z.object({
  op: z.literal('set_layout_lane'),
  component_id: objectIdSchema,
  rank: z.number().int().min(0).max(16),
  lane: z.number().int().min(-16).max(16),
}).strict();

export const layoutPatchOperationSchema = z.discriminatedUnion('op', [
  moveComponentSchema,
  rotateComponentSchema,
  movePortSchema,
  setBlockPinSideSchema,
  setLayoutLaneSchema,
]);

export const layoutPatchSchema = z.object({
  schema: z.literal('actoviq.layout-patch.v1'),
  operations: z.array(layoutPatchOperationSchema).max(32),
}).strict().superRefine((patch, context) => {
  const movement = new Map<string, { x: number; y: number }>();
  const assignments = new Set<string>();
  patch.operations.forEach((operation, index) => {
    if (operation.op === 'move_component' || operation.op === 'move_port') {
      const key = operation.op === 'move_component'
        ? `component:${operation.component_id}`
        : `port:${operation.port_id}`;
      const current = movement.get(key) ?? { x: 0, y: 0 };
      const next = { x: current.x + operation.dx_grid, y: current.y + operation.dy_grid };
      movement.set(key, next);
      if (Math.abs(next.x) > 6 || Math.abs(next.y) > 6) {
        context.addIssue({
          code: 'custom',
          path: ['operations', index],
          message: `${key} cumulative movement must remain within ±6 grid cells per axis.`,
        });
      }
      return;
    }
    const key = operation.op === 'rotate_component'
      ? `rotate:${operation.component_id}`
      : operation.op === 'set_layout_lane'
        ? `lane:${operation.component_id}`
        : `pin-side:${operation.component_id}:${operation.pin_id}`;
    if (assignments.has(key)) {
      context.addIssue({
        code: 'custom',
        path: ['operations', index],
        message: `${key} may be assigned only once in a layout patch.`,
      });
    }
    assignments.add(key);
  });
});

export const layoutPatchSetSchema = z.object({
  schema: z.literal('actoviq.layout-patch-set.v1'),
  source_revision: z.number().int().nonnegative().safe(),
  connectivity_hash: z.string().regex(/^[0-9a-f]{64}$/i),
  candidates: z.array(layoutPatchSchema).max(4),
}).strict();

export type LayoutPatchOperation = z.infer<typeof layoutPatchOperationSchema>;
export type LayoutPatch = z.infer<typeof layoutPatchSchema>;
export type LayoutPatchSet = z.infer<typeof layoutPatchSetSchema>;

export interface ExpectedLayoutPatchSource {
  sourceRevision: number;
  connectivityHash: string;
}

export type LayoutPatchProtocolErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_SCHEMA'
  | 'SOURCE_REVISION_MISMATCH'
  | 'CONNECTIVITY_HASH_MISMATCH';

export class LayoutPatchProtocolError extends Error {
  readonly code: LayoutPatchProtocolErrorCode;

  constructor(code: LayoutPatchProtocolErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LayoutPatchProtocolError';
    this.code = code;
  }
}

function formatSchemaIssues(error: z.ZodError): string {
  return error.issues.map((issue) => {
    const location = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${location}: ${issue.message}`;
  }).join('; ');
}

/**
 * Parses the complete model response as one strict layout patch-set document.
 * Markdown fences, explanatory prose, unknown fields, and unsupported operations
 * are deliberately rejected instead of being repaired or silently ignored.
 */
export function parseLayoutPatchSetText(
  text: string,
  expected: ExpectedLayoutPatchSource,
): LayoutPatchSet {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch (error) {
    throw new LayoutPatchProtocolError(
      'INVALID_JSON',
      'Vision layout output must be exactly one JSON object with no Markdown or surrounding prose.',
      { cause: error },
    );
  }

  const parsed = layoutPatchSetSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new LayoutPatchProtocolError(
      'INVALID_SCHEMA',
      `Vision layout output does not match actoviq.layout-patch-set.v1: ${formatSchemaIssues(parsed.error)}`,
    );
  }

  if (parsed.data.source_revision !== expected.sourceRevision) {
    throw new LayoutPatchProtocolError(
      'SOURCE_REVISION_MISMATCH',
      `Vision layout output source_revision ${parsed.data.source_revision} does not match requested revision ${expected.sourceRevision}.`,
    );
  }
  if (parsed.data.connectivity_hash !== expected.connectivityHash) {
    throw new LayoutPatchProtocolError(
      'CONNECTIVITY_HASH_MISMATCH',
      'Vision layout output connectivity_hash does not match the authoritative request.',
    );
  }
  return parsed.data;
}
