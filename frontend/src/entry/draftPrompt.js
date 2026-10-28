// The "restore your draft" prompt: a card on the start screen, or a small dialog when the page was
// opened from a saved link (that visit has no start screen). English, like the start screen.
import { el } from '../editor/fields.js';
import { createDialog } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';

export const DRAFT_TEXT = Object.freeze({
  title: 'Continue your draft',
  found: (time) => `Draft from ${time} found. Restore?`,
  restore: 'Restore draft',
  discard: 'Discard',
});

const button = (className, text, testId, onClick) => {
  const node = el('button', { className, text, attrs: { type: 'button', 'data-testid': testId } });
  node.addEventListener('click', onClick);
  return node;
};

/** The start-screen card. `onRestore` / `onDiscard` decide what happens to the start screen. */
export function draftCard({ time, onRestore, onDiscard }) {
  const restore = button('btn btn--primary', DRAFT_TEXT.restore, 'draft-restore', onRestore);
  restore.autofocus = true; // the start screen opens with focus on the likely choice
  return el('section', { className: 'draft-card', attrs: { 'aria-labelledby': 'draft-title', 'data-testid': 'draft-card' } }, [
    el('span', { className: 'draft-card__icon' }, [icon('save', { size: 22 })]),
    el('div', { className: 'draft-card__text' }, [
      el('h2', { className: 'draft-card__title', text: DRAFT_TEXT.title, attrs: { id: 'draft-title' } }),
      el('p', { className: 'draft-card__found', text: DRAFT_TEXT.found(time) }),
    ]),
    el('div', { className: 'draft-card__actions' }, [
      button('btn btn--ghost', DRAFT_TEXT.discard, 'draft-discard', onDiscard),
      restore,
    ]),
  ]);
}

/** The same question for a design opened from its link. Esc or the scrim keeps the draft for now. */
export function openDraftDialog({ time, onRestore, onDiscard }) {
  const choose = (action) => () => {
    dialog.close();
    dialog.element.remove();
    action();
  };
  const dialog = createDialog({
    title: DRAFT_TEXT.title,
    body: [el('p', { className: 'dialog__text', text: DRAFT_TEXT.found(time) })],
    actions: [
      button('btn btn--ghost', DRAFT_TEXT.discard, 'draft-discard', choose(onDiscard)),
      button('btn btn--primary', DRAFT_TEXT.restore, 'draft-restore', choose(onRestore)),
    ],
    testId: 'draft-dialog',
    labelId: 'draft-dialog-title',
  });
  dialog.open();
  dialog.element.querySelector('[data-testid="draft-restore"]').focus();
  return dialog;
}
