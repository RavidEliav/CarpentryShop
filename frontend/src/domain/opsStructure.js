// Layout op handlers. Mirrors backend/app/domain/ops_structure.py.
// Handlers receive a private deep copy (`draft`), edit it and return it; the
// caller re-validates. Integer arithmetic only (parity with Python).

import * as ids from './ids.js';
import { DEFAULT_PANEL_THICKNESS, DEFAULT_SLIDING_DOOR_COUNT, LIMITS, defaultAppearance } from './defaults.js';
import { DomainError, INVALID_OP, NOT_FOUND, OUT_OF_RANGE } from './errors.js';
import { partitionLeftEdge } from './geometry.js';
import { ITEM_KINDS, compartmentIndex, locate, partitionIndex, requireRange } from './lookup.js';
import { isSet, sum } from './util.js';

const emptyCompartment = (id, width) => ({ id, width, shelves: [], drawers: [], rails: [] });
const door = (id, compartmentIds, hingeSide) => ({ id, compartmentIds, hingeSide, appearance: null });

function idsOrNew(given, count, prefix, path) {
  if (!isSet(given)) return Array.from({ length: count }, () => ids.newId(prefix));
  if (given.length !== count) throw new DomainError(INVALID_OP, path, `expected ${count} ids, got ${given.length}`);
  return [...given];
}

function requireMinWidths(widths, path) {
  const [minimum] = LIMITS.compartmentWidth;
  if (widths.some((w) => w < minimum)) throw new DomainError(OUT_OF_RANGE, path, `a compartment would be narrower than ${minimum} mm`);
}

function requireDimensionRanges(op, path) {
  for (const field of ['width', 'height', 'depth']) {
    if (isSet(op[field])) requireRange(op[field], field, `${path}.${field}`);
  }
}

function createWardrobe(_draft, op, path) {
  requireDimensionRanges(op, path);
  requireRange(op.compartmentCount, 'compartmentCount', `${path}.compartmentCount`);
  const n = op.compartmentCount;
  const panel = op.panelThickness ?? DEFAULT_PANEL_THICKNESS;
  const partition = op.partitionThickness ?? panel;
  const available = op.width - 2 * panel - (n - 1) * partition;
  const base = Math.floor(available / n);
  const remainder = available - n * base;
  const widths = Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
  requireMinWidths(widths, `${path}.compartmentCount`);
  const compartmentIds = idsOrNew(op.compartmentIds, n, ids.COMPARTMENT, `${path}.compartmentIds`);
  const partitionIds = idsOrNew(op.partitionIds, n - 1, ids.PARTITION, `${path}.partitionIds`);
  return {
    schemaVersion: 1,
    units: 'mm',
    dimensions: { width: op.width, height: op.height, depth: op.depth },
    carcass: { panelThickness: panel, appearance: defaultAppearance() },
    compartments: compartmentIds.map((id, i) => emptyCompartment(id, widths[i])),
    partitions: partitionIds.map((id) => ({ id, thickness: partition })),
    doors: { type: 'none', appearance: defaultAppearance(), items: [] },
  };
}

function updateDimensions(draft, op, path) {
  if (!isSet(op.width) && !isSet(op.height) && !isSet(op.depth)) {
    throw new DomainError(INVALID_OP, path, 'give at least one of width, height, depth');
  }
  requireDimensionRanges(op, path);
  if (isSet(op.width)) {
    const { compartments } = draft;
    const fixed = 2 * draft.carcass.panelThickness + sum(draft.partitions.map((p) => p.thickness));
    const oldAvailable = sum(compartments.map((c) => c.width));
    const newAvailable = op.width - fixed;
    const scaled = compartments.slice(0, -1).map((c) => Math.floor((c.width * newAvailable) / oldAvailable));
    scaled.push(newAvailable - sum(scaled));
    requireMinWidths(scaled, `${path}.width`);
    compartments.forEach((c, i) => { c.width = scaled[i]; });
    draft.dimensions.width = op.width;
  }
  if (isSet(op.height)) draft.dimensions.height = op.height;
  if (isSet(op.depth)) draft.dimensions.depth = op.depth;
  return draft;
}

function configureDoors(draft, op, path) {
  const { doors } = draft;
  if (op.type === 'none') {
    if (isSet(op.doors) || isSet(op.count) || isSet(op.ids)) {
      throw new DomainError(INVALID_OP, path, "type 'none' takes no doors, count or ids");
    }
    Object.assign(doors, { type: 'none', items: [] });
  } else if (op.type === 'sliding') {
    if (isSet(op.doors)) throw new DomainError(INVALID_OP, path, 'sliding doors take count/ids, not a doors list');
    const count = op.count ?? (isSet(op.ids) ? op.ids.length : DEFAULT_SLIDING_DOOR_COUNT);
    requireRange(count, 'slidingDoorCount', `${path}.count`);
    const doorIds = idsOrNew(op.ids, count, ids.DOOR, `${path}.ids`);
    Object.assign(doors, { type: 'sliding', items: doorIds.map((id) => door(id, [], null)) });
  } else {
    Object.assign(doors, { type: 'hinged', items: hingedItems(draft, op, path) });
  }
  return draft;
}

function hingedItems(draft, op, path) {
  if (isSet(op.count)) throw new DomainError(INVALID_OP, path, 'hinged doors take a doors list or ids, not count');
  if (!isSet(op.doors)) {
    const doorIds = idsOrNew(op.ids, draft.compartments.length, ids.DOOR, `${path}.ids`);
    return draft.compartments.map((c, i) => door(doorIds[i], [c.id], i % 2 === 0 ? 'left' : 'right'));
  }
  if (isSet(op.ids)) throw new DomainError(INVALID_OP, path, 'give ids inside each door spec');
  if (!op.doors.length) throw new DomainError(INVALID_OP, `${path}.doors`, "hinged doors need at least one door; use type 'none'");
  return op.doors.map((d) => door(d.id ?? ids.newId(ids.DOOR), [...d.compartmentIds], d.hingeSide));
}

function addCompartment(draft, op, path) {
  const { compartments, partitions } = draft;
  const n = compartments.length;
  if (op.position < 0 || op.position > n) throw new DomainError(INVALID_OP, `${path}.position`, `position must be within 0..${n}`);
  const thickness = op.partitionThickness ?? draft.carcass.panelThickness;
  const donor = op.position < n ? compartments[op.position] : compartments[n - 1];
  donor.width -= op.width + thickness;
  requireMinWidths([donor.width, op.width], `${path}.width`);
  const created = emptyCompartment(op.id ?? ids.newId(ids.COMPARTMENT), op.width);
  const partition = { id: op.partitionId ?? ids.newId(ids.PARTITION), thickness };
  if (op.position > 0 && op.position < n) {
    extendSpanningDoors(draft, compartments[op.position - 1].id, compartments[op.position].id, created.id);
  }
  draft.compartments = [...compartments.slice(0, op.position), created, ...compartments.slice(op.position)];
  draft.partitions = [...partitions.slice(0, op.position), partition, ...partitions.slice(op.position)];
  return draft;
}

// A hinged door spanning the insertion point also spans the new compartment.
function extendSpanningDoors(draft, leftId, rightId, createdId) {
  for (const d of draft.doors.items) {
    if (d.compartmentIds.includes(leftId) && d.compartmentIds.includes(rightId)) {
      d.compartmentIds.splice(d.compartmentIds.indexOf(rightId), 0, createdId);
    }
  }
}

function modifyCompartment(draft, op, path) {
  const { compartments } = draft;
  if (compartments.length === 1) throw new DomainError(INVALID_OP, path, 'a single compartment always spans the full interior width');
  const index = compartmentIndex(draft, op.compartmentId, `${path}.compartmentId`);
  const neighbour = index < compartments.length - 1 ? compartments[index + 1] : compartments[index - 1];
  neighbour.width -= op.width - compartments[index].width;
  compartments[index].width = op.width;
  requireMinWidths([op.width, neighbour.width], `${path}.width`);
  return draft;
}

function addPartition(draft, op, path) {
  const index = compartmentIndex(draft, op.compartmentId, `${path}.compartmentId`);
  const compartment = draft.compartments[index];
  const thickness = op.thickness ?? draft.carcass.panelThickness;
  const rightWidth = compartment.width - op.offset - thickness;
  requireMinWidths([op.offset, rightWidth], `${path}.offset`);
  compartment.width = op.offset;
  const createdId = op.newCompartmentId ?? ids.newId(ids.COMPARTMENT);
  draft.compartments.splice(index + 1, 0, emptyCompartment(createdId, rightWidth));
  draft.partitions.splice(index, 0, { id: op.id ?? ids.newId(ids.PARTITION), thickness });
  for (const d of draft.doors.items) {
    const at = d.compartmentIds.indexOf(compartment.id);
    if (at >= 0) d.compartmentIds.splice(at + 1, 0, createdId);
  }
  return draft;
}

function modifyPartition(draft, op, path) {
  if (!isSet(op.position) && !isSet(op.thickness)) throw new DomainError(INVALID_OP, path, 'give position and/or thickness');
  const j = partitionIndex(draft, op.partitionId, `${path}.partitionId`);
  const left = draft.compartments[j];
  const right = draft.compartments[j + 1];
  const leftEdge = partitionLeftEdge(draft, j);
  if (isSet(op.thickness)) {
    right.width -= op.thickness - draft.partitions[j].thickness;
    draft.partitions[j].thickness = op.thickness;
  }
  if (isSet(op.position)) {
    const delta = op.position - leftEdge;
    left.width += delta;
    right.width -= delta;
  }
  requireMinWidths([left.width, right.width], isSet(op.position) ? `${path}.position` : `${path}.thickness`);
  return draft;
}

// Reverse the compartments left to right. Ids, widths and items move with their compartment;
// partitions reverse too, so the width invariant holds. Hinged doors keep their compartments
// (reordered left to right) and swap hinge sides; doors are listed left to right again.
function mirrorLayout(draft) {
  draft.compartments.reverse();
  draft.partitions.reverse();
  const { doors } = draft;
  doors.items.reverse();
  if (doors.type === 'hinged') {
    for (const d of doors.items) {
      d.compartmentIds.reverse();
      d.hingeSide = d.hingeSide === 'left' ? 'right' : 'left';
    }
  }
  return draft;
}

function removeComponent(draft, op, path) {
  const found = locate(draft, op.id);
  if (!found) throw new DomainError(NOT_FOUND, `${path}.id`, 'no component with this id');
  const [kind, index, itemIndex] = found;
  if (ITEM_KINDS.includes(kind)) {
    draft.compartments[index][kind].splice(itemIndex, 1);
  } else if (kind === 'compartment') {
    removeCompartment(draft, index, `${path}.id`);
  } else if (kind === 'partition') {
    mergeAtPartition(draft, index);
  } else {
    draft.doors.items.splice(index, 1);
    normalizeDoors(draft);
  }
  return draft;
}

function removeCompartment(draft, index, path) {
  const { compartments, partitions } = draft;
  if (compartments.length === 1) throw new DomainError(INVALID_OP, path, 'the last compartment cannot be removed');
  const isLast = index === compartments.length - 1;
  const partitionAt = isLast ? index - 1 : index;
  const absorber = isLast ? compartments[index - 1] : compartments[index + 1];
  absorber.width += compartments[index].width + partitions[partitionAt].thickness;
  const removedId = compartments[index].id;
  compartments.splice(index, 1);
  partitions.splice(partitionAt, 1);
  for (const d of draft.doors.items) d.compartmentIds = d.compartmentIds.filter((id) => id !== removedId);
  draft.doors.items = draft.doors.items.filter((d) => d.compartmentIds.length || draft.doors.type !== 'hinged');
  normalizeDoors(draft);
}

// Merge compartments j and j+1 into j. Covering doors merge into the first one in list order.
function mergeAtPartition(draft, j) {
  const { compartments } = draft;
  const left = compartments[j];
  const right = compartments[j + 1];
  left.width += draft.partitions[j].thickness + right.width;
  for (const kind of ITEM_KINDS) left[kind] = [...left[kind], ...right[kind]];
  compartments.splice(j + 1, 1);
  draft.partitions.splice(j, 1);
  const order = new Map(compartments.map((c, i) => [c.id, i]));
  const covering = [];
  for (const d of draft.doors.items) {
    d.compartmentIds = [...new Set(d.compartmentIds.map((id) => (id === right.id ? left.id : id)))];
    if (d.compartmentIds.includes(left.id)) covering.push(d);
  }
  if (covering.length > 1) {
    const [keeper, ...dropped] = covering;
    keeper.compartmentIds = [...new Set(covering.flatMap((d) => d.compartmentIds))].sort((a, b) => order.get(a) - order.get(b));
    draft.doors.items = draft.doors.items.filter((d) => !dropped.includes(d));
  }
}

// After a door or compartment removal leaves no doors, the type becomes 'none'.
function normalizeDoors(draft) {
  if (draft.doors.type !== 'none' && !draft.doors.items.length) draft.doors.type = 'none';
}

export const STRUCTURE_HANDLERS = Object.freeze({
  create_wardrobe: createWardrobe,
  update_dimensions: updateDimensions,
  configure_doors: configureDoors,
  add_compartment: addCompartment,
  modify_compartment: modifyCompartment,
  add_partition: addPartition,
  modify_partition: modifyPartition,
  mirror_layout: mirrorLayout,
  remove_component: removeComponent,
});
