// Save state of the open design: its private link, the server revision it was last saved at, and
// whether the committed design changed since. The server is the only copy; nothing is kept in the
// browser except the link in the address bar.
import { ApiError, createDesign, updateDesign } from '../api/client.js';

const SAVE_FAILED = 'Saving failed. Please try again.';

/**
 * `saved` is { link, revision } when the page was opened from a link. Status is one of
 * idle (never saved) | saving | saved | conflict (changed elsewhere since) | error.
 */
export function createPersistence({ store, available, saved = null, api = { createDesign, updateDesign } }) {
  let state = {
    available: Boolean(available),
    link: saved?.link ?? null,
    serverRevision: saved?.revision ?? null,
    savedAt: saved ? store.getState().revision : null, // store revision that the server copy matches
    status: saved ? 'saved' : 'idle',
    error: null,
  };
  const listeners = new Set();
  const snapshot = () => Object.freeze({ ...state, dirty: state.savedAt !== store.getState().revision });
  const notify = () => {
    const current = snapshot();
    listeners.forEach((listener) => listener(current));
  };
  const set = (patch) => {
    state = { ...state, ...patch };
    notify();
  };
  store.subscribe(notify);

  async function save({ asNew = false } = {}) {
    const unchanged = state.link && !asNew && state.savedAt === store.getState().revision;
    if (!state.available || state.status === 'saving' || unchanged) return;
    const { design, revision } = store.getState();
    const link = asNew ? null : state.link;
    set({ status: 'saving', error: null });
    try {
      if (link) {
        const result = await api.updateDesign(link, state.serverRevision, design);
        set({ serverRevision: result.revision, savedAt: revision, status: 'saved' });
      } else {
        const result = await api.createDesign(design);
        set({
          link: Object.freeze({ designId: result.designId, token: result.accessToken }),
          serverRevision: result.revision, savedAt: revision, status: 'saved',
        });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) set({ status: 'conflict' });
      else set({ status: 'error', error: error instanceof ApiError ? error.message : SAVE_FAILED });
    }
  }

  return {
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    save: () => save(),
    /** After a conflict: keep this version under a new link (the other version keeps the old one). */
    saveAsNew: () => save({ asNew: true }),
  };
}
