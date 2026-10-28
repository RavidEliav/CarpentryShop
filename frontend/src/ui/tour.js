// First-visit introduction tour: one bubble at a time over the chat, the editor and the 3D view.
// A native modal <dialog> gives the focus trap and Esc for free; nothing here touches the design.
import { el } from '../editor/fields.js';

export const TOUR_STORAGE_KEY = 'banai.tour.seen';
export const TOUR_STEPS = Object.freeze([
  Object.freeze({ id: 'chat', target: '#chat-panel' }),
  Object.freeze({ id: 'editor', target: '#properties-panel' }),
  Object.freeze({ id: 'viewer', target: '#viewer' }),
]);

const GAP = 14; // px between the target and the bubble
const MARGIN = 16; // px the bubble keeps from the window edges
const RING = 4; // px the highlight ring sits outside the target
const INSET = 24; // px from the target's bottom edge when the bubble has to sit inside it

/** Best effort: blocked storage (private mode) just means the tour may show again. */
export function hasSeenTour(storage) {
  try {
    return storage?.getItem(TOUR_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markTourSeen(storage) {
  try {
    storage?.setItem(TOUR_STORAGE_KEY, '1');
  } catch {
    // not remembered; the tour may show again next visit
  }
}

const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));

/**
 * Where the bubble goes: beside the target if there is room (right, left, below, above),
 * otherwise inside it near its bottom edge, so the middle of a big target stays visible.
 * Always kept inside the window. `arrow` is the px offset of the pointer along the bubble
 * edge that faces the target.
 */
export function placeBubble(target, bubble, viewport) {
  const midX = target.left + target.width / 2;
  const midY = target.top + target.height / 2;
  const sides = [
    { side: 'right', fits: target.right + GAP + bubble.width <= viewport.width - MARGIN, left: target.right + GAP, top: midY - bubble.height / 2 },
    { side: 'left', fits: target.left - GAP - bubble.width >= MARGIN, left: target.left - GAP - bubble.width, top: midY - bubble.height / 2 },
    { side: 'bottom', fits: target.bottom + GAP + bubble.height <= viewport.height - MARGIN, left: midX - bubble.width / 2, top: target.bottom + GAP },
    { side: 'top', fits: target.top - GAP - bubble.height >= MARGIN, left: midX - bubble.width / 2, top: target.top - GAP - bubble.height },
  ];
  const chosen = sides.find((s) => s.fits)
    ?? { side: 'inside', left: midX - bubble.width / 2, top: target.bottom - INSET - bubble.height };
  const left = Math.round(clamp(chosen.left, MARGIN, viewport.width - MARGIN - bubble.width));
  const top = Math.round(clamp(chosen.top, MARGIN, viewport.height - MARGIN - bubble.height));
  const vertical = chosen.side === 'left' || chosen.side === 'right';
  const arrow = vertical
    ? Math.round(clamp(midY - top, 20, bubble.height - 20))
    : Math.round(clamp(midX - left, 20, bubble.width - 20));
  return { side: chosen.side, left, top, arrow };
}

const button = (className, testId) => el('button', { className, attrs: { type: 'button', 'data-testid': testId } });

export function createTour({ language, storage = globalThis.localStorage }) {
  let index = 0;
  let returnTo = null;

  const progress = el('p', { className: 'tour__progress', attrs: { 'data-testid': 'tour-progress' } });
  const title = el('h2', { className: 'tour__title', attrs: { id: 'tour-title' } });
  const body = el('p', { className: 'tour__body', attrs: { id: 'tour-body' } });
  const skip = button('btn btn--ghost', 'tour-skip');
  const back = button('btn btn--tonal', 'tour-back');
  const next = button('btn btn--primary', 'tour-next');
  const bubble = el('div', { className: 'tour__bubble' }, [
    el('div', { attrs: { 'aria-live': 'polite' } }, [progress, title, body]),
    el('div', { className: 'tour__actions' }, [skip, el('span', { className: 'tour__spacer' }), back, next]),
  ]);
  const ring = el('div', { className: 'tour__ring', attrs: { 'aria-hidden': 'true' } });
  const dialog = el('dialog', {
    className: 'tour',
    attrs: { 'aria-labelledby': 'tour-title', 'aria-describedby': 'tour-body', 'data-testid': 'tour' },
  }, [ring, bubble]);
  document.body.append(dialog);

  const position = () => {
    const target = document.querySelector(TOUR_STEPS[index].target);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    Object.assign(ring.style, {
      left: `${rect.left - RING}px`, top: `${rect.top - RING}px`,
      width: `${rect.width + 2 * RING}px`, height: `${rect.height + 2 * RING}px`,
    });
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const place = placeBubble(rect, { width: bubble.offsetWidth, height: bubble.offsetHeight }, viewport);
    Object.assign(bubble.style, { left: `${place.left}px`, top: `${place.top}px` });
    bubble.style.setProperty('--tour-arrow', `${place.arrow}px`);
    bubble.dataset.side = place.side;
  };

  const render = () => {
    const strings = language.strings();
    const text = strings.tour;
    const step = TOUR_STEPS[index];
    const last = index === TOUR_STEPS.length - 1;
    dialog.lang = language.get();
    dialog.dir = strings.dir;
    dialog.dataset.step = step.id;
    progress.textContent = text.progress(index + 1, TOUR_STEPS.length);
    title.textContent = text.steps[step.id].title;
    body.textContent = text.steps[step.id].body;
    skip.textContent = text.skip;
    skip.hidden = last;
    back.textContent = text.back;
    back.hidden = index === 0;
    next.textContent = last ? text.done : text.next;
    position();
    // A button that just disappeared (Back on step 1, Skip on the last) must not take focus with it.
    if (!dialog.contains(document.activeElement) || document.activeElement.hidden) next.focus();
  };

  const go = (step) => {
    index = step;
    render();
  };

  skip.addEventListener('click', () => dialog.close());
  back.addEventListener('click', () => go(Math.max(0, index - 1)));
  next.addEventListener('click', () => (index === TOUR_STEPS.length - 1 ? dialog.close() : go(index + 1)));
  window.addEventListener('resize', () => { if (dialog.open) position(); });
  language.subscribe(() => { if (dialog.open) render(); });

  // Done, Skip and Esc all end here: remember the tour and give focus back to the page.
  dialog.addEventListener('close', () => {
    markTourSeen(storage);
    const focusTarget = returnTo?.isConnected ? returnTo : document.getElementById('properties-panel');
    returnTo = null;
    focusTarget?.focus();
  });

  return {
    element: dialog,
    isOpen: () => dialog.open,
    start() {
      if (dialog.open) return;
      returnTo = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      index = 0;
      dialog.showModal();
      render();
      next.focus();
    },
    /** The automatic first-visit showing; later visits only through the "?" button. */
    startIfNew() {
      if (!hasSeenTour(storage)) this.start();
    },
  };
}
