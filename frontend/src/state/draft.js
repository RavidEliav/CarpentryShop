// Automatic draft: the latest design is kept in this browser, so a refresh or a closed tab loses
// nothing. One slot ("banai.draft"); the newest work replaces it. A link's token is never stored.
import { parseDesign } from '../domain/schema.js';
import { validateCanonical } from '../domain/validation.js';

export const DRAFT_KEY = 'banai.draft';
const DESIGN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** localStorage, or null where merely touching it throws (storage blocked by the browser). */
export function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function clearDraft(storage) {
  try {
    storage?.removeItem(DRAFT_KEY);
  } catch {
    // blocked storage: nothing to clear
  }
}

/** Best effort: a full or blocked storage (private mode) just means no draft this time. */
export function writeDraft(storage, { design, designId, savedAt }) {
  try {
    storage?.setItem(DRAFT_KEY, JSON.stringify({ v: 1, savedAt, designId, design }));
  } catch {
    // not kept
  }
}

/**
 * The stored draft as { design, savedAt, designId }, or null. Anything unreadable or invalid
 * (bad JSON, a foreign shape, a design that fails validation) is deleted silently.
 */
export function readDraft(storage, catalog) {
  let raw;
  try {
    raw = storage?.getItem(DRAFT_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) return null;
  try {
    const entry = JSON.parse(raw);
    const designId = entry?.designId;
    if (entry?.v === 1 && Number.isFinite(entry.savedAt) && (designId === null || DESIGN_ID.test(designId))) {
      const design = parseDesign(entry.design);
      if (validateCanonical(design, catalog).length === 0) return { design, savedAt: entry.savedAt, designId };
    }
  } catch {
    // falls through to delete it
  }
  clearDraft(storage);
  return null;
}

/** The draft worth offering: same design (same link, or none) and different from what just loaded. */
export function draftToOffer(draft, { designId, loadedDesign }) {
  if (!draft || draft.designId !== designId) return null;
  return JSON.stringify(draft.design) === JSON.stringify(loadedDesign) ? null : draft;
}

/** "14:32" for today, else "27 Oct, 14:32" (local time). */
export function formatDraftTime(savedAt, now = Date.now(), locale = 'en-GB') {
  const when = new Date(savedAt);
  const time = { hour: '2-digit', minute: '2-digit' };
  const today = when.toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(locale, today ? time : { day: 'numeric', month: 'short', ...time }).format(when);
}

/**
 * Keep the draft in step with the store: written on every design change (manual edits and confirmed
 * AI proposals), never on selection or view changes. `sync()` writes the current design at once.
 */
export function watchDraft(store, { storage, getDesignId, now = Date.now }) {
  const write = (design) => writeDraft(storage, { design, designId: getDesignId(), savedAt: now() });
  let last = store.getState().design;
  const stop = store.subscribe((state) => {
    if (state.design === last) return;
    last = state.design;
    write(state.design);
  });
  return { stop, sync: () => write(store.getState().design) };
}
