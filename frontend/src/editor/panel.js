// Properties panel: re-renders from store state on every committed change. Every edit
// goes through store.dispatch(ops); a rejected op leaves the state (and panel) as-is
// and shows an inline message. No LLM is involved in manual editing.
import { compartmentsSection } from './compartmentsSection.js';
import { componentSection } from './componentSection.js';
import { partsSection } from './partsSection.js';
import { wardrobeSection } from './wardrobeSection.js';

export function mountPanel(root, store, { onExport, units } = {}) {
  const run = (ops) => {
    try {
      return store.dispatch(ops);
    } catch {
      return { ok: false, error: { code: 'UNEXPECTED' } }; // shown as a generic message
    }
  };
  const select = (id) => store.select(id);
  let rendered = { design: null, selection: undefined, unit: undefined };

  const render = (state) => {
    const unit = units?.get() ?? 'cm';
    if (state.design === rendered.design && state.selection === rendered.selection && unit === rendered.unit) return;
    rendered = { design: state.design, selection: state.selection, unit };
    const context = { design: state.design, catalog: state.catalog, selection: state.selection, run, select, onExport, unit };
    // Re-rendering replaces every control: put keyboard focus back on the same one (WCAG 2.4.3).
    const focused = root.contains(document.activeElement) ? document.activeElement.dataset.testid : undefined;
    root.replaceChildren(
      ...(state.selection ? [componentSection(context)] : []),
      ...wardrobeSection(context),
      compartmentsSection(context),
      partsSection(context),
    );
    if (focused) root.querySelector(`[data-testid="${CSS.escape(focused)}"]`)?.focus();
  };

  const unsubscribe = store.subscribe(render);
  const unsubscribeUnits = units?.subscribe(() => render(store.getState()));
  render(store.getState());
  return () => { unsubscribe(); unsubscribeUnits?.(); };
}
