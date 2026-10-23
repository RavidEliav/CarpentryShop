// Save and share dialog. Saving stores the design on the server and gives a private link; nothing is
// faked: the link field stays empty until a save has really succeeded.
import { el, button } from '../editor/fields.js';
import { createDialog } from '../ui/dialog.js';

const UNAVAILABLE = 'Saving is not available on this server.';
const READY = 'Save to get your private link.';
const SAVED = 'Saved. Use this link to reopen and keep editing.';

/**
 * `available`: whether the server can store designs. `onSave()` saves the current design and resolves
 * to its private link. `link`: the link of a design that was reopened from one, if any.
 */
export function createSaveDialog({ available, onSave, link = '' }) {
  const linkField = el('input', { className: 'field__input', attrs: { id: 'share-link', type: 'text', readonly: '', placeholder: 'Your private link will appear here', 'aria-label': 'Private share link' } });
  linkField.dataset.testid = 'share-link';
  linkField.value = link;
  const status = el('p', { className: 'dialog__status', text: available ? READY : UNAVAILABLE, attrs: { role: 'status' } });
  status.dataset.testid = 'save-status';

  const copy = button('Copy link', async () => {
    try {
      await navigator.clipboard.writeText(linkField.value);
      status.textContent = 'Link copied.';
    } catch {
      linkField.select(); // clipboard blocked: leave it selected for a manual copy
      status.textContent = 'Select the link and copy it.';
    }
  }, { variant: 'secondary', testId: 'copy-link', disabled: !link });

  const save = button('Save design', async () => {
    save.disabled = true;
    status.textContent = 'Saving…';
    try {
      linkField.value = await onSave();
      copy.disabled = false;
      status.textContent = SAVED;
    } catch (error) {
      status.textContent = error?.message || 'Saving failed. Please try again.';
    } finally {
      save.disabled = false;
    }
  }, { variant: 'primary', testId: 'save-confirm', disabled: !available });

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
      el('p', { className: 'dialog__note', text: 'Anyone with this link can edit the design, so keep it private.' }),
      status,
    ],
    actions: [copy, save, button('Close', () => dialog.close(), { variant: 'ghost', testId: 'save-close' })],
  });
  return dialog;
}
