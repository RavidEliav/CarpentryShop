// Properties panel: re-renders from store state on every committed change. Every edit
// goes through store.dispatch(ops); a rejected op leaves the state (and panel) as-is
// and shows an inline message. No LLM is involved in manual editing.
import { compartmentsSection } from './compartmentsSection.js';
import { componentSection } from './componentSection.js';
import { wardrobeSection } from './wardrobeSection.js';

export function mountPanel(root, store, { onExport } = {}) {
  const run = (ops) => {
    try {
      return store.dispatch(ops);
    } catch {
      return { ok: false, error: { code: 'UNEXPECTED' } }; // shown as a generic message
    }
  };
  const select = (id) => store.select(id);
  let rendered = { design: null, selection: undefined };

  const render = (state) => {
    if (state.design === rendered.design && state.selection === rendered.selection) return;
    rendered = { design: state.design, selection: state.selection };
    const context = { design: state.design, catalog: state.catalog, selection: state.selection, run, select, onExport };
    root.replaceChildren(
      ...(state.selection ? [componentSection(context)] : []),
      ...wardrobeSection(context),
      compartmentsSection(context),
    );
  };

  const unsubscribe = store.subscribe(render);
  render(store.getState());
  return unsubscribe;
}
