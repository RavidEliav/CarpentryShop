// Every selectable part as a button: the keyboard and screen-reader path to what
// the 3D view selects by pointer (WCAG 2.1.1).
import { button, el, section } from './fields.js';

const ITEM_GROUPS = Object.freeze([['shelves', 'Shelf'], ['drawers', 'Drawer'], ['rails', 'Hanging rail']]);

function parts(design) {
  const doors = design.doors.items.map((door, i) => ({ id: door.id, label: `Door ${i + 1}` }));
  const partitions = design.partitions.map((partition, i) => ({ id: partition.id, label: `Partition ${i + 1}` }));
  const items = design.compartments.flatMap((compartment, c) => ITEM_GROUPS.flatMap(([key, name]) =>
    (compartment[key] ?? []).map((item, i) => ({ id: item.id, label: `Compartment ${c + 1} · ${name} ${i + 1}` }))));
  return [{ id: 'carcass', label: 'Wardrobe body' }, ...doors, ...partitions, ...items];
}

export function partsSection({ design, selection, select }) {
  const list = el('ul', { className: 'parts-list' }, parts(design).map(({ id, label }) => {
    const node = button(label, () => select(id), { variant: 'link', testId: `part-${id}` });
    if (selection?.id === id) node.setAttribute('aria-current', 'true');
    return el('li', {}, [node]);
  }));
  return section('All parts', [list]);
}
