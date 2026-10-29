// Pure mapping from editor form input to domain ops. No DOM here, so every rule is
// unit-tested. The domain engine remains the single authority on validity.
import { interiorHeight } from '../domain/geometry.js';
import { formatLength, parseLength } from '../units/displayUnits.js';

// ASSUMPTION: prototype defaults for newly added items (not business rules).
export const NEW_ITEM = Object.freeze({ shelfThickness: 18, drawerHeight: 200, railBelowTop: 100 });

/** Parse a centimetre input (`.` or `,` decimal) to integer millimetres. */
export const parseCm = (text) => parseLength(text, 'cm');

export const toCmText = (mm) => formatLength(mm, 'cm');

export const dimensionOps = (field, mm) => [{ op: 'update_dimensions', [field]: mm }];

export function doorTypeOps(type, count) {
  if (type === 'sliding') return [{ op: 'configure_doors', type, count: count ?? 2 }];
  return [{ op: 'configure_doors', type }];
}

/** Change one hinged door's hinge side by re-stating every door (ids preserved). */
export function doorHingeOps(design, doorId, hingeSide) {
  return [{
    op: 'configure_doors',
    type: 'hinged',
    doors: design.doors.items.map((door) => ({
      id: door.id,
      compartmentIds: [...door.compartmentIds],
      hingeSide: door.id === doorId ? hingeSide : door.hingeSide,
    })),
  }];
}

export const materialOps = (target, field, ref) => [{ op: 'set_material', target, [field]: ref }];

export const clearAppearanceOps = (target) => [{ op: 'set_material', target, clear: true }];

export const removeOps = (id) => [{ op: 'remove_component', id }];

export function addCompartmentOps(design) {
  const last = design.compartments.at(-1);
  const thickness = design.carcass.panelThickness;
  const width = Math.floor((last.width - thickness) / 2);
  return [{ op: 'add_compartment', position: design.compartments.length, width }];
}

/** Free vertical gaps [start, end) in a compartment, given its shelves and drawers. */
function freeGaps(design, compartment) {
  const top = interiorHeight(design);
  const occupied = [
    ...compartment.shelves.map((s) => [s.y, s.y + s.thickness]),
    ...compartment.drawers.map((d) => [d.y, d.y + d.height]),
  ].sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cursor = 0;
  for (const [start, end] of occupied) {
    if (start > cursor) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < top) gaps.push([cursor, top]);
  return gaps;
}

/** Ops that add a shelf, drawer or rail at a sensible free position (largest/lowest gap). */
export function addItemOps(design, compartmentId, kind) {
  const compartment = design.compartments.find((c) => c.id === compartmentId);
  const gaps = freeGaps(design, compartment);
  const largest = gaps.reduce((best, gap) => (gap[1] - gap[0] > best[1] - best[0] ? gap : best), [0, 0]);
  if (kind === 'shelf') {
    const y = Math.floor((largest[0] + largest[1] - NEW_ITEM.shelfThickness) / 2);
    return [{ op: 'add_shelf', compartmentId, y, thickness: NEW_ITEM.shelfThickness }];
  }
  if (kind === 'drawer') {
    const lowest = gaps.find(([start, end]) => end - start >= NEW_ITEM.drawerHeight) ?? largest;
    return [{ op: 'add_drawer', compartmentId, y: lowest[0], height: NEW_ITEM.drawerHeight }];
  }
  const y = Math.max(largest[0], largest[1] - NEW_ITEM.railBelowTop);
  return [{ op: 'add_rail', compartmentId, y }];
}

const FRIENDLY = Object.freeze({
  OVERLAP: 'That would overlap another shelf or drawer. Choose a different position.',
  OUT_OF_BOUNDS: 'That position is not inside the wardrobe.',
  OUT_OF_RANGE: 'That value is outside the allowed range.',
  WIDTH_MISMATCH: 'The widths no longer add up to the wardrobe width.',
  DOOR_INVALID: 'That door arrangement is not possible here.',
  NOT_FOUND: 'That component no longer exists.',
  INVALID_OP: 'That change is not possible for this component.',
  UNKNOWN_CATALOG_ID: 'That material or colour is not in the catalog.',
  SCHEMA_INVALID: 'That value is not valid.',
});

/** Short, engine-independent message for an inline error (never echoes input). */
export const friendlyError = (error) => FRIENDLY[error?.code] ?? 'The change could not be applied.';
