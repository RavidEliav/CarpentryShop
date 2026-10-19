import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/api/client.js';
import { createPersistence } from '../../../src/share/persistence.js';
import { createStore } from '../../../src/state/store.js';
import { loadCatalog, loadDesign } from '../domain/helpers.js';

const LINK = { designId: '3f1c2b4a-1111-4222-8333-444455556666', token: 'x'.repeat(43) };
const widen = (store, width = 2400) => store.dispatch([{ op: 'update_dimensions', width }]);

function setup({ available = true, saved = null, api } = {}) {
  const store = createStore({ design: loadDesign('basic'), revision: 1, catalog: loadCatalog() });
  const fakeApi = api ?? {
    createDesign: vi.fn().mockResolvedValue({ designId: LINK.designId, accessToken: LINK.token, revision: 1 }),
    updateDesign: vi.fn().mockImplementation(async (_link, revision) => ({ revision: revision + 1 })),
  };
  const persistence = createPersistence({ store, available, saved, api: fakeApi });
  return { store, persistence, api: fakeApi };
}

describe('persistence', () => {
  it('starts unsaved, and the first save creates a private link for the current design', async () => {
    const { store, persistence, api } = setup();
    expect(persistence.getState()).toMatchObject({ link: null, status: 'idle', dirty: true });
    await persistence.save();
    expect(api.createDesign).toHaveBeenCalledWith(store.getState().design);
    expect(persistence.getState()).toMatchObject({ link: LINK, serverRevision: 1, status: 'saved', dirty: false });
  });

  it('tracks edits after a save, and the next save updates the same link from its revision', async () => {
    const { store, persistence, api } = setup();
    await persistence.save();
    widen(store);
    expect(persistence.getState().dirty).toBe(true);
    await persistence.save();
    expect(api.createDesign).toHaveBeenCalledTimes(1);
    expect(api.updateDesign).toHaveBeenCalledWith(LINK, 1, store.getState().design);
    expect(persistence.getState()).toMatchObject({ link: LINK, serverRevision: 2, status: 'saved', dirty: false });
  });

  it('a page opened from a link starts saved, and saving without changes sends nothing', async () => {
    const { persistence, api } = setup({ saved: { link: LINK, revision: 5 } });
    expect(persistence.getState()).toMatchObject({ link: LINK, serverRevision: 5, status: 'saved', dirty: false });
    await persistence.save();
    expect(api.updateDesign).not.toHaveBeenCalled();
  });

  it('a 409 is a conflict; saving as a new link keeps this version under a new link', async () => {
    const api = {
      createDesign: vi.fn().mockResolvedValue({ designId: '11111111-2222-4333-8444-555555555555', accessToken: 'y'.repeat(43), revision: 1 }),
      updateDesign: vi.fn().mockRejectedValue(new ApiError('changed elsewhere', { status: 409, code: 'CONFLICT' })),
    };
    const { store, persistence } = setup({ saved: { link: LINK, revision: 2 }, api });
    widen(store);
    await persistence.save();
    expect(persistence.getState()).toMatchObject({ status: 'conflict', link: LINK, dirty: true });
    await persistence.saveAsNew();
    expect(api.createDesign).toHaveBeenCalledWith(store.getState().design);
    expect(persistence.getState()).toMatchObject({
      status: 'saved', dirty: false, serverRevision: 1,
      link: { designId: '11111111-2222-4333-8444-555555555555', token: 'y'.repeat(43) },
    });
  });

  it('other failures show the server message (or a generic one) and keep the changes', async () => {
    const api = {
      createDesign: vi.fn()
        .mockRejectedValueOnce(new ApiError('Saving is temporarily unavailable.', { status: 503, code: 'STORE_ERROR' }))
        .mockRejectedValueOnce(new TypeError('boom')),
      updateDesign: vi.fn(),
    };
    const { persistence } = setup({ api });
    await persistence.save();
    expect(persistence.getState()).toMatchObject({ status: 'error', error: 'Saving is temporarily unavailable.', link: null, dirty: true });
    await persistence.save();
    expect(persistence.getState().error).toBe('Saving failed. Please try again.');
  });

  it('ignores a second save while one is running', async () => {
    let finish;
    const api = { createDesign: vi.fn(() => new Promise((resolve) => { finish = resolve; })), updateDesign: vi.fn() };
    const { persistence } = setup({ api });
    const first = persistence.save();
    expect(persistence.getState().status).toBe('saving');
    await persistence.save();
    expect(api.createDesign).toHaveBeenCalledTimes(1);
    finish({ designId: LINK.designId, accessToken: LINK.token, revision: 1 });
    await first;
    expect(persistence.getState().status).toBe('saved');
  });

  it('an edit made while saving stays unsaved', async () => {
    let finish;
    const api = { createDesign: vi.fn(() => new Promise((resolve) => { finish = resolve; })), updateDesign: vi.fn() };
    const { store, persistence } = setup({ api });
    const saving = persistence.save();
    widen(store);
    finish({ designId: LINK.designId, accessToken: LINK.token, revision: 1 });
    await saving;
    expect(persistence.getState()).toMatchObject({ status: 'saved', dirty: true });
  });

  it('does nothing when saving is unavailable on the server', async () => {
    const { persistence, api } = setup({ available: false });
    await persistence.save();
    expect(api.createDesign).not.toHaveBeenCalled();
    expect(persistence.getState()).toMatchObject({ available: false, status: 'idle' });
  });

  it('notifies subscribers on saves and on design edits', async () => {
    const { store, persistence } = setup();
    const listener = vi.fn();
    persistence.subscribe(listener);
    await persistence.save();
    widen(store);
    const states = listener.mock.calls.map(([state]) => [state.status, state.dirty]);
    expect(states).toEqual([['saving', true], ['saved', false], ['saved', true]]);
  });
});
