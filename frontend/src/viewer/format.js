// Display formatting. The domain is integer mm; the UI shows the chosen display unit (cm, mm or in).
import { formatLength, formatWithUnit } from '../units/displayUnits.js';

/** Backwards-compatible alias: millimetres as centimetres with 1 decimal, e.g. `'64.3'`. */
export const cm = (mm) => formatLength(mm, 'cm');

/** One-line description of a selected component, for labels and readouts. */
export function describeSelection(design, selection, unit = 'cm') {
  const n = (mm) => formatLength(mm, unit);
  const u = (mm) => formatWithUnit(mm, unit);
  if (!selection) return '';
  const { id, kind } = selection;
  const { width, height, depth } = design.dimensions;
  if (kind === 'carcass') return `Wardrobe · ${n(width)} × ${n(height)} × ${n(depth)} ${unit}`;
  for (const [ci, compartment] of design.compartments.entries()) {
    if (compartment.id === id) return `Compartment ${ci + 1} · width ${u(compartment.width)}`;
    const shelf = compartment.shelves.find((s) => s.id === id);
    if (shelf) return `Shelf · ${u(shelf.y)} from base · ${u(shelf.thickness)} thick`;
    const drawer = compartment.drawers.find((d) => d.id === id);
    if (drawer) return `Drawer · ${u(drawer.y)} from base · ${u(drawer.height)} high`;
    const rail = compartment.rails.find((r) => r.id === id);
    if (rail) return `Hanging rail · ${u(rail.y)} from base`;
  }
  const pi = design.partitions.findIndex((p) => p.id === id);
  if (pi >= 0) return `Partition ${pi + 1} · ${u(design.partitions[pi].thickness)} thick`;
  const door = design.doors.items.find((d) => d.id === id);
  if (door) return `${design.doors.type === 'sliding' ? 'Sliding' : 'Hinged'} door${door.hingeSide ? ` · hinge ${door.hingeSide}` : ''}`;
  return kind;
}
