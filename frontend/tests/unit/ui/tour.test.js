import { describe, expect, it } from 'vitest';
import { LANGUAGES, STRINGS } from '../../../src/chat/i18n.js';
import { hasSeenTour, markTourSeen, placeBubble, TOUR_STEPS, TOUR_STORAGE_KEY } from '../../../src/ui/tour.js';

const memoryStorage = (initial = {}) => {
  const data = { ...initial };
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; }, data };
};
const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const viewport = { width: 1440, height: 900 };
const bubble = { width: 340, height: 200 };

describe('tour steps and texts', () => {
  it('walks the chat, the editor and the 3D view, in that order', () => {
    expect(TOUR_STEPS.map((s) => [s.id, s.target])).toEqual([
      ['chat', '#chat-panel'], ['editor', '#properties-panel'], ['viewer', '#viewer'],
    ]);
  });

  it('has every tour text in every chat language', () => {
    LANGUAGES.forEach((lang) => {
      const tour = STRINGS[lang].tour;
      ['replay', 'next', 'back', 'skip', 'done'].forEach((key) => expect(tour[key], `${lang}.${key}`).toMatch(/\S/));
      TOUR_STEPS.forEach(({ id }) => {
        expect(tour.steps[id].title, `${lang}.${id}.title`).toMatch(/\S/);
        expect(tour.steps[id].body, `${lang}.${id}.body`).toMatch(/\S/);
      });
      expect(Object.keys(tour.steps).sort()).toEqual(TOUR_STEPS.map((s) => s.id).sort());
    });
    expect(STRINGS.en.tour.progress(2, 3)).toBe('2 of 3');
    expect(STRINGS.he.tour.progress(2, 3)).toBe('2 מתוך 3');
  });
});

describe('seen flag', () => {
  it('is unset at first and remembered once marked', () => {
    const storage = memoryStorage();
    expect(hasSeenTour(storage)).toBe(false);
    markTourSeen(storage);
    expect(storage.data[TOUR_STORAGE_KEY]).toBe('1');
    expect(hasSeenTour(storage)).toBe(true);
  });

  it('treats junk as unseen and survives missing or blocked storage', () => {
    expect(hasSeenTour(memoryStorage({ [TOUR_STORAGE_KEY]: 'yes' }))).toBe(false);
    expect(hasSeenTour(undefined)).toBe(false);
    expect(hasSeenTour(blocked)).toBe(false);
    expect(() => markTourSeen(blocked)).not.toThrow();
    expect(() => markTourSeen(undefined)).not.toThrow();
  });
});

describe('bubble placement', () => {
  it('goes beside a side panel, pointing at its middle', () => {
    const chat = rect(0, 64, 360, 836); // left column
    expect(placeBubble(chat, bubble, viewport)).toEqual({ side: 'right', left: 374, top: 382, arrow: 100 });
    const editor = rect(1080, 64, 360, 836); // right column
    expect(placeBubble(editor, bubble, viewport)).toMatchObject({ side: 'left', left: 1080 - 14 - 340 });
  });

  it('falls back to below, above, then inside a target with no room beside it, near its bottom', () => {
    expect(placeBubble(rect(0, 100, 1440, 300), bubble, viewport).side).toBe('bottom');
    expect(placeBubble(rect(0, 600, 1440, 300), bubble, viewport).side).toBe('top');
    const viewer = rect(360, 64, 720, 836);
    expect(placeBubble(viewer, bubble, viewport)).toMatchObject({ side: 'inside', left: 550, top: 900 - 24 - 200 });
  });

  it('always stays inside the window, with the arrow kept on the bubble', () => {
    const nearTop = rect(0, 0, 360, 40);
    const place = placeBubble(nearTop, bubble, viewport);
    expect(place).toMatchObject({ side: 'right', top: 16 });
    expect(place.arrow).toBe(20); // the target's middle is above the bubble: arrow clamped to its edge
    const tiny = { width: 400, height: 300 };
    const inside = placeBubble(rect(100, 100, 200, 100), bubble, tiny);
    expect(inside.left).toBeGreaterThanOrEqual(16);
    expect(inside.top).toBeGreaterThanOrEqual(16);
  });
});
