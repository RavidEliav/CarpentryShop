// Compartment list: widths, selection, add and remove, plus the carpenter PDF export.
import { actionResult, button, lengthField, el, section } from './fields.js';
import { addCompartmentOps, removeOps } from './opsFromForm.js';

export function compartmentsSection({ design, selection, run, select, onExport, unit }) {
  const list = el('ol', { className: 'compartment-list' });
  const single = design.compartments.length === 1;
  design.compartments.forEach((compartment, index) => {
    const selected = selection?.id === compartment.id;
    const row = el('li', { className: `compartment-row${selected ? ' is-selected' : ''}` });
    row.append(
      button(`Compartment ${index + 1}`, () => select(compartment.id), { variant: 'link', testId: `select-${compartment.id}` }),
      lengthField({
        unit, label: 'Width', mm: compartment.width, testId: `width-${compartment.id}`,
        onCommit: (mm) => run([{ op: 'modify_compartment', compartmentId: compartment.id, width: mm }]),
      }),
      button('Remove', () => actionResult(row, run(removeOps(compartment.id))), {
        variant: 'ghost', disabled: single, testId: `remove-${compartment.id}`,
      }),
    );
    list.append(row);
  });
  const container = section('Compartments', [list]);
  const actions = el('div', { className: onExport ? 'button-row button-row--pair' : 'button-row' }, [
    button('+ Add compartment', () => actionResult(container, run(addCompartmentOps(design))), { variant: 'secondary', testId: 'add-compartment' }),
  ]);
  if (onExport) actions.append(button('Generate Style Profile', onExport, { variant: 'primary', testId: 'open-export' }));
  container.append(actions);
  return container;
}
