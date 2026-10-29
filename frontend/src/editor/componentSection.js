// Properties of the selected component; only the fields that apply to its kind.
import { appearanceControls } from './appearanceControls.js';
import { actionResult, button, lengthField, el, section, segmented } from './fields.js';
import { addItemOps, clearAppearanceOps, doorHingeOps, removeOps } from './opsFromForm.js';
import { partitionLeftEdge } from '../domain/geometry.js';

const TITLES = Object.freeze({
  shelf: 'Shelf', drawer: 'Drawer', rail: 'Hanging rail', compartment: 'Compartment', partition: 'Partition', door: 'Door', carcass: 'Wardrobe body',
});

function findItem(design, kind, id) {
  const key = { shelf: 'shelves', drawer: 'drawers', rail: 'rails' }[kind];
  for (const compartment of design.compartments) {
    const item = compartment[key]?.find((candidate) => candidate.id === id);
    if (item) return item;
  }
  return null;
}

function overrideControls({ catalog, design, item, inherited, run, label }) {
  const appearance = item.appearance ?? inherited;
  return [
    appearanceControls({ catalog, appearance, target: item.id, run, label }),
    ...(item.appearance ? [button(`Use ${label === 'Door finish' ? 'door' : 'carcass'} finish`, () => run(clearAppearanceOps(item.id)), { variant: 'ghost' })] : []),
  ];
}

function fieldsFor(kind, { design, catalog, selection, run, runAction, unit }) {
  const { id } = selection;
  const move = (op, field) => (mm) => run([{ op, id, [field]: mm }]);
  if (kind === 'shelf') {
    const shelf = findItem(design, kind, id);
    return [
      lengthField({ unit, label: 'Height from base', mm: shelf.y, testId: 'shelf-y', onCommit: move('modify_shelf', 'y') }),
      lengthField({ unit, label: 'Thickness', mm: shelf.thickness, testId: 'shelf-thickness', onCommit: move('modify_shelf', 'thickness') }),
      ...overrideControls({ catalog, design, item: shelf, inherited: design.carcass.appearance, run: runAction, label: 'Shelf finish' }),
    ];
  }
  if (kind === 'drawer') {
    const drawer = findItem(design, kind, id);
    return [
      lengthField({ unit, label: 'Height from base', mm: drawer.y, testId: 'drawer-y', onCommit: move('modify_drawer', 'y') }),
      lengthField({ unit, label: 'Drawer height', mm: drawer.height, testId: 'drawer-height', onCommit: move('modify_drawer', 'height') }),
      ...overrideControls({ catalog, design, item: drawer, inherited: design.carcass.appearance, run: runAction, label: 'Drawer front' }),
    ];
  }
  if (kind === 'rail') {
    const rail = findItem(design, kind, id);
    return [lengthField({ unit, label: 'Height from base', mm: rail.y, testId: 'rail-y', onCommit: move('modify_rail', 'y') })];
  }
  if (kind === 'compartment') {
    const compartment = design.compartments.find((c) => c.id === id);
    return [
      lengthField({ unit, label: 'Width', mm: compartment.width, testId: 'compartment-width', onCommit: (mm) => run([{ op: 'modify_compartment', compartmentId: id, width: mm }]) }),
      el('div', { className: 'button-row' }, ['shelf', 'drawer', 'rail'].map((item) =>
        button(`+ ${item === 'rail' ? 'Rail' : item[0].toUpperCase() + item.slice(1)}`, () => runAction(addItemOps(design, id, item)), { testId: `add-${item}` }))),
    ];
  }
  if (kind === 'partition') {
    const index = design.partitions.findIndex((p) => p.id === id);
    return [
      lengthField({ unit, label: 'Position from left', mm: partitionLeftEdge(design, index), testId: 'partition-position', onCommit: (mm) => run([{ op: 'modify_partition', partitionId: id, position: mm }]) }),
      lengthField({ unit, label: 'Thickness', mm: design.partitions[index].thickness, testId: 'partition-thickness', onCommit: (mm) => run([{ op: 'modify_partition', partitionId: id, thickness: mm }]) }),
    ];
  }
  if (kind === 'door') {
    const door = design.doors.items.find((d) => d.id === id);
    return [
      ...(design.doors.type === 'hinged' ? [segmented({
        label: 'Hinge side', value: door.hingeSide, testId: 'hinge-side',
        options: [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }],
        onChange: (side) => runAction(doorHingeOps(design, id, side)),
      })] : []),
      ...overrideControls({ catalog, design, item: door, inherited: design.doors.appearance, run: runAction, label: 'Door finish' }),
    ];
  }
  return [el('p', { className: 'panel__note', text: 'Edit the overall dimensions and materials in the Wardrobe section.' })];
}

export function componentSection({ design, catalog, selection, run, select, unit }) {
  const container = section(`Selected · ${TITLES[selection.kind]}`, []);
  container.dataset.testid = 'selected-section';
  // Inputs report their own errors inline; buttons/selects report under the section.
  const runAction = (ops) => actionResult(container, run(ops));
  container.append(...fieldsFor(selection.kind, { design, catalog, selection, run, runAction, unit }));
  const actions = [button('Deselect', () => select(null), { variant: 'ghost' })];
  if (selection.kind !== 'carcass') {
    actions.unshift(button(`Delete ${TITLES[selection.kind].toLowerCase()}`, () => runAction(removeOps(selection.id)), { variant: 'danger', testId: 'delete-selected' }));
  }
  container.append(el('div', { className: 'button-row' }, actions));
  return container;
}
