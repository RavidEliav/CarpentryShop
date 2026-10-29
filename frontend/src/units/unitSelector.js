// The unit selector in the top bar: cm | mm | in. It changes how lengths are displayed only;
// it never imports or calls the store.
import { el } from '../editor/fields.js';
import { UNITS } from './displayUnits.js';

/** Fill `container` with the unit buttons and keep them in step with `units`. Returns a cleanup function. */
export function createUnitSelector({ container, units }) {
  const group = el('div', { className: 'unit-selector', attrs: { role: 'group', 'aria-label': 'Units', 'data-testid': 'unit-selector' } });
  const buttons = new Map();
  UNITS.forEach((unit) => {
    const button = el('button', { className: 'unit-selector__option', text: unit, attrs: { type: 'button', 'data-testid': `unit-${unit}`, 'aria-pressed': 'false' } });
    button.addEventListener('click', () => units.set(unit));
    buttons.set(unit, button);
    group.append(button);
  });
  const render = () => buttons.forEach((button, unit) => button.setAttribute('aria-pressed', String(unit === units.get())));
  render();
  const unsubscribe = units.subscribe(render);
  container.replaceChildren(group);
  return () => { unsubscribe(); group.remove(); };
}
