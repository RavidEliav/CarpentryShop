// Short "it worked" messages at the bottom of the window ("Change applied", "Link copied"...).
// One polite live region reads them aloud; each message leaves after a few seconds, unless hovered.
import { el } from '../editor/fields.js';

export const TOAST_MS = 3000;
const MAX_TOASTS = 3;

/** A timeout that can be paused and resumed (hovering a toast keeps it). DOM-free. */
export function pausableTimer({
  ms, onDone, setTimer = (fn, delay) => setTimeout(fn, delay), clearTimer = (id) => clearTimeout(id), now = () => Date.now(),
}) {
  let remaining = ms;
  let started = now();
  let handle = null;
  const run = () => {
    started = now();
    handle = setTimer(() => {
      handle = null;
      remaining = null;
      onDone();
    }, Math.max(0, remaining));
  };
  run();
  return {
    pause() {
      if (handle === null) return;
      clearTimer(handle);
      handle = null;
      remaining -= now() - started;
    },
    resume() {
      if (handle === null && remaining !== null) run();
    },
    cancel() {
      if (handle !== null) clearTimer(handle);
      handle = null;
      remaining = null;
    },
  };
}

// While a modal dialog is open the rest of the page is inert (hidden from screen readers and under
// the backdrop), so the messages live inside that dialog until it closes. The region is a manual
// popover: the top layer keeps it above the dialog and placed against the window, not the dialog box.
const topModal = () => [...document.querySelectorAll('dialog[open]')].filter((d) => d.matches(':modal')).at(-1) ?? null;

export function createToaster({ duration = TOAST_MS } = {}) {
  const region = el('div', { className: 'toast-region', attrs: { role: 'status', 'aria-live': 'polite', 'data-testid': 'toast-region', popover: 'manual' } });
  document.body.append(region);
  const timers = new Map();

  const dismiss = (toast) => {
    timers.get(toast)?.cancel();
    timers.delete(toast);
    toast.remove();
    if (!region.children.length && region.matches?.(':popover-open')) region.hidePopover();
  };

  const raise = () => {
    if (typeof region.showPopover !== 'function') return;
    if (region.matches(':popover-open')) region.hidePopover();
    region.showPopover(); // the newest top-layer element: above any dialog opened since
  };

  const place = () => {
    const modal = topModal();
    const host = modal ?? document.body;
    if (region.parentElement !== host) {
      host.append(region);
      if (modal) {
        modal.addEventListener('close', () => {
          document.body.append(region);
          if (region.children.length) raise();
        }, { once: true });
      }
    }
    raise();
  };

  return {
    show(text) {
      place();
      const toast = el('div', { className: 'toast', attrs: { 'data-testid': 'toast' } });
      region.append(toast);
      // Text added after the node is in the live region, so screen readers announce it.
      requestAnimationFrame(() => { toast.textContent = text; });
      const timer = pausableTimer({ ms: duration, onDone: () => dismiss(toast) });
      timers.set(toast, timer);
      toast.addEventListener('mouseenter', () => timer.pause());
      toast.addEventListener('mouseleave', () => timer.resume());
      while (region.children.length > MAX_TOASTS) dismiss(region.firstElementChild);
    },
  };
}
