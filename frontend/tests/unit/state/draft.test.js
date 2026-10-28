import { describe, expect, it } from 'vitest';
import { createStore } from '../../../src/state/store.js';
import {
  browserStorage, clearDraft, DRAFT_KEY, draftToOffer, formatDraftTime, readDraft, watchDraft, writeDraft,
} from '../../../src/state/draft.js';
import { loadCatalog, loadDesign } from '../domain/helpers.js';

const catalog = loadCatalog();
const basic = loadDesign('basic');
const LINK_ID = '0b5b9a8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const memoryStorage = (initial = {}) => {
  const data = { ...initial };
  return {
    getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; }, removeItem: (k) => { delete data[k]; }, data,
  };
};
const blocked = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('denied'); },
  removeItem: () => { throw new Error('denied'); },
};
const taller = () => {
  const store = createStore({ design: basic, catalog });
  store.dispatch([{ op: 'update_dimensions', height: 2300 }]);
  return store.getState().design;
};

describe('reading and writing the draft', () => {
  it('round-trips a valid design with its time and link', () => {
    const storage = memoryStorage();
    writeDraft(storage, { design: basic, designId: LINK_ID, savedAt: 1000 });
    expect(readDraft(storage, catalog)).toEqual({ design: expect.objectContaining({ dimensions: basic.dimensions }), savedAt: 1000, designId: LINK_ID });
    clearDraft(storage);
    expect(storage.data[DRAFT_KEY]).toBeUndefined();
    expect(readDraft(storage, catalog)).toBeNull();
  });

  it('deletes anything broken silently: bad JSON, foreign shapes, invalid designs', () => {
    const invalid = structuredClone(basic);
    invalid.compartments[0].width += 50; // breaks the width invariant
    const cases = [
      '{not json',
      JSON.stringify({ v: 2, savedAt: 1, designId: null, design: basic }),
      JSON.stringify({ v: 1, savedAt: 'yesterday', designId: null, design: basic }),
      JSON.stringify({ v: 1, savedAt: 1, designId: '../../etc', design: basic }),
      JSON.stringify({ v: 1, savedAt: 1, designId: null, design: { hello: 'world' } }),
      JSON.stringify({ v: 1, savedAt: 1, designId: null, design: invalid }),
      'null',
    ];
    cases.forEach((raw) => {
      const storage = memoryStorage({ [DRAFT_KEY]: raw });
      expect(readDraft(storage, catalog), raw).toBeNull();
      expect(storage.data[DRAFT_KEY], raw).toBeUndefined();
    });
  });

  it('works without storage and with blocked storage (private mode)', () => {
    expect(readDraft(null, catalog)).toBeNull();
    expect(readDraft(blocked, catalog)).toBeNull();
    expect(() => writeDraft(blocked, { design: basic, designId: null, savedAt: 1 })).not.toThrow();
    expect(() => clearDraft(blocked)).not.toThrow();
    const full = { ...memoryStorage(), setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
    expect(() => writeDraft(full, { design: basic, designId: null, savedAt: 1 })).not.toThrow();
    expect(() => browserStorage()).not.toThrow();
  });
});

describe('which draft to offer', () => {
  const draft = (design, designId = null) => ({ design, savedAt: 1, designId });

  it('offers a changed design for the same link, or for a new design', () => {
    const changed = taller();
    expect(draftToOffer(draft(changed), { designId: null, loadedDesign: basic })).toEqual(draft(changed));
    expect(draftToOffer(draft(changed, LINK_ID), { designId: LINK_ID, loadedDesign: basic })).toEqual(draft(changed, LINK_ID));
  });

  it('offers nothing for another design, an unchanged one, or no draft', () => {
    const changed = taller();
    expect(draftToOffer(draft(changed, LINK_ID), { designId: null, loadedDesign: basic })).toBeNull();
    expect(draftToOffer(draft(changed), { designId: LINK_ID, loadedDesign: basic })).toBeNull();
    const loaded = createStore({ design: basic, catalog }).getState().design;
    expect(draftToOffer(draft(loaded), { designId: null, loadedDesign: loaded })).toBeNull();
    expect(draftToOffer(null, { designId: null, loadedDesign: basic })).toBeNull();
  });
});

describe('draft time', () => {
  it('shows the time for today and the date with the time otherwise', () => {
    const saved = new Date(2026, 9, 28, 14, 32).getTime();
    expect(formatDraftTime(saved, new Date(2026, 9, 28, 18, 5).getTime())).toBe('14:32');
    expect(formatDraftTime(saved, new Date(2026, 9, 29, 9, 0).getTime())).toMatch(/^28 Oct.*14:32$/);
  });
});

describe('watching the store', () => {
  it('writes on every design change (edits and replaced designs), never on selection or view changes', () => {
    const storage = memoryStorage();
    const store = createStore({ design: basic, catalog });
    let clock = 100;
    let designId = null;
    const draft = watchDraft(store, { storage, getDesignId: () => designId, now: () => clock });
    expect(storage.data[DRAFT_KEY]).toBeUndefined(); // nothing until the first change

    store.select('shf_l1');
    store.setDoorsVisible(false);
    expect(storage.data[DRAFT_KEY]).toBeUndefined();

    store.dispatch([{ op: 'update_dimensions', height: 2300 }]);
    expect(readDraft(storage, catalog)).toMatchObject({ savedAt: 100, designId: null, design: { dimensions: { height: 2300 } } });

    clock = 200;
    const replaced = structuredClone(store.getState().design);
    replaced.dimensions.depth = 550;
    store.replaceDesign(replaced, store.getState().revision + 1); // a confirmed AI proposal
    expect(readDraft(storage, catalog)).toMatchObject({ savedAt: 200, design: { dimensions: { depth: 550 } } });

    designId = LINK_ID; // saved to a link: sync ties the draft to it at once
    draft.sync();
    expect(readDraft(storage, catalog).designId).toBe(LINK_ID);

    draft.stop();
    store.dispatch([{ op: 'update_dimensions', height: 2200 }]);
    expect(readDraft(storage, catalog).design.dimensions.height).toBe(2300);
  });
});
