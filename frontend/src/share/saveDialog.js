// Save and share dialog. The first save creates a private link (`#d=<id>.<token>`); later saves update
// the same design. Nothing is faked: a link only appears once the server has stored the design.
import { el, button } from '../editor/fields.js';
import { createDialog } from '../ui/dialog.js';
import { shareUrl } from './shareLink.js';

/** The dialog's status line for a persistence state. */
export function saveStatusText({ available, link, status, dirty, error }) {
  if (!available) return 'Saving is not available on this server.';
  if (status === 'saving') return 'Saving…';
  if (status === 'conflict') {
    return 'This design was changed in another tab or window after you opened it. '
      + 'Save your version as a new link, or reopen the link to see the latest version.';
  }
  if (status === 'error') return error || 'Saving failed. Please try again.';
  if (!link) return 'Not saved yet.';
  return dirty ? 'You have changes that are not saved yet.' : 'Saved. The link opens this version.';
}

/** The top-bar indicator text, or null to hide it (it appears once the design has a link). */
export function saveIndicatorText({ link, status, dirty }) {
  if (!link) return null;
  if (status === 'saving') return 'Saving…';
  return status === 'saved' && !dirty ? 'Saved' : 'Unsaved changes';
}

export function createSaveDialog({ persistence, location = window.location }) {
  const linkField = el('input', { className: 'field__input', attrs: { id: 'share-link', type: 'text', readonly: '', placeholder: 'Your private link will appear here', 'aria-label': 'Private share link' } });
  linkField.dataset.testid = 'share-link';
  const status = el('p', { className: 'dialog__status', attrs: { role: 'status' } });
  status.dataset.testid = 'save-status';
  const copyNote = el('p', { className: 'dialog__note', attrs: { 'aria-live': 'polite' } });
  copyNote.dataset.testid = 'copy-note';

  const copy = button('Copy link', async () => {
    try {
      await navigator.clipboard.writeText(linkField.value);
      copyNote.textContent = 'Link copied.';
    } catch {
      linkField.select(); // no clipboard access (e.g. denied): leave it ready for Ctrl+C
      copyNote.textContent = 'Copy the selected link with Ctrl+C.';
    }
  }, { variant: 'secondary', testId: 'copy-link' });
  const save = button('Save design', () => persistence.save(), { variant: 'primary', testId: 'save-confirm' });
  const saveAsNew = button('Save as a new link', () => persistence.saveAsNew(), { variant: 'secondary', testId: 'save-as-new' });
  const dialog = createDialog({
    title: 'Save your design',
    labelId: 'save-dialog-title',
    testId: 'save-dialog',
    body: [
      el('p', { className: 'dialog__text', text: 'Saving gives you a private link you can use to reopen and keep editing this design. No account is needed.' }),
      el('div', { className: 'field' }, [
        el('label', { className: 'field__label', text: 'Private link', attrs: { for: 'share-link' } }),
        linkField,
      ]),
      el('p', { className: 'dialog__note', text: 'Anyone with this link can open and edit the design, so keep it private.' }),
      status,
      copyNote,
    ],
    actions: [
      saveAsNew,
      copy,
      save,
      button('Close', () => dialog.close(), { variant: 'ghost', testId: 'save-close' }),
    ],
  });

  const render = (state) => {
    linkField.value = state.link ? shareUrl(location, state.link) : '';
    status.textContent = saveStatusText(state);
    save.textContent = state.link ? 'Save changes' : 'Save design';
    const upToDate = Boolean(state.link) && state.status === 'saved' && !state.dirty;
    save.disabled = !state.available || state.status === 'saving' || state.status === 'conflict' || upToDate;
    copy.disabled = !state.link;
    saveAsNew.hidden = state.status !== 'conflict';
  };
  persistence.subscribe((state) => {
    copyNote.textContent = '';
    render(state);
  });
  render(persistence.getState());
  return dialog;
}
