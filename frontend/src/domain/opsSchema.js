// Typed operation protocol (discriminated on `op`). Mirrors backend/app/domain/ops.py.
// Ops may come from an LLM: ids are pattern-checked, ints bounded, lists capped,
// and optional fields accept explicit null (pydantic `X | None = None`).

import { z } from 'zod';
import { DomainError, SCHEMA_INVALID } from './errors.js';
import * as ids from './ids.js';
import { int, list, ref, schemaError, typedId } from './schema.js';

export const MAX_OPS = 100;

const opt = (schema) => schema.nullish();
const op = (name, shape) => z.strictObject({ op: z.literal(name), ...shape });
const cmpId = () => typedId(ids.COMPARTMENT);

export const opSchema = z.discriminatedUnion('op', [
  op('create_wardrobe', {
    width: int(), height: int(), depth: int(), compartmentCount: int(),
    panelThickness: opt(int()), partitionThickness: opt(int()),
    compartmentIds: opt(list(cmpId())), partitionIds: opt(list(typedId(ids.PARTITION))),
  }),
  op('update_dimensions', { width: opt(int()), height: opt(int()), depth: opt(int()) }),
  op('configure_doors', {
    type: z.enum(['hinged', 'sliding', 'none']),
    doors: opt(list(z.strictObject({
      id: opt(typedId(ids.DOOR)), compartmentIds: list(cmpId()), hingeSide: z.enum(['left', 'right']),
    }))),
    count: opt(int()),
    ids: opt(list(typedId(ids.DOOR))),
  }),
  op('add_compartment', {
    position: int(), width: int(), id: opt(cmpId()), partitionId: opt(typedId(ids.PARTITION)), partitionThickness: opt(int()),
  }),
  op('modify_compartment', { compartmentId: cmpId(), width: int() }),
  op('add_partition', {
    compartmentId: cmpId(), offset: int(), id: opt(typedId(ids.PARTITION)), newCompartmentId: opt(cmpId()), thickness: opt(int()),
  }),
  op('modify_partition', { partitionId: typedId(ids.PARTITION), position: opt(int()), thickness: opt(int()) }),
  op('mirror_layout', {}),
  op('add_shelf', { compartmentId: cmpId(), y: int(), thickness: opt(int()), id: opt(typedId(ids.SHELF)) }),
  op('modify_shelf', { id: typedId(ids.SHELF), y: opt(int()), thickness: opt(int()) }),
  op('add_drawer', { compartmentId: cmpId(), y: int(), height: int(), id: opt(typedId(ids.DRAWER)) }),
  op('modify_drawer', { id: typedId(ids.DRAWER), y: opt(int()), height: opt(int()) }),
  op('add_rail', { compartmentId: cmpId(), y: int(), id: opt(typedId(ids.RAIL)) }),
  op('modify_rail', { id: typedId(ids.RAIL), y: int() }),
  op('set_material', {
    target: z.string().regex(ids.TARGET_PATTERN),
    material: opt(ref), color: opt(ref), finish: opt(ref),
    clear: z.boolean().default(false),
  }),
  op('remove_component', { id: z.string().regex(ids.ANY_ID_PATTERN) }),
]);

/** Validate the batch container, then each op (error path `ops[i]`). */
export function parseOps(rawOps) {
  if (!Array.isArray(rawOps)) throw new DomainError(SCHEMA_INVALID, 'ops', 'ops must be an array');
  if (rawOps.length > MAX_OPS) throw new DomainError(SCHEMA_INVALID, 'ops', `at most ${MAX_OPS} ops per batch`);
  return rawOps.map(parseOp);
}

export function parseOp(raw, index) {
  const result = opSchema.safeParse(raw);
  if (!result.success) throw schemaError(result.error.issues[0], `ops[${index}]`);
  return result.data;
}
