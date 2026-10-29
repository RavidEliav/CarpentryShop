// Display units (cm, mm, in). The design is ALWAYS integer millimetres: this module only turns
// millimetres into text for the screen and typed text back into integer millimetres. It has no DOM
// and never touches the store.

export const UNITS = Object.freeze(['cm', 'mm', 'in']);
export const DEFAULT_UNIT = 'cm';

// `mmPer`: millimetres in one display unit. `decimals`: digits shown after the point.
const SPECS = Object.freeze({
  cm: { mmPer: 10, decimals: 1, example: '64.5' },
  mm: { mmPer: 1, decimals: 0, example: '645' },
  in: { mmPer: 25.4, decimals: 2, example: '25.5 or 25 1/2' },
});

const MAX_ABS_MM = 1_000_000; // the previous cm limit (100 000 cm)
const DECIMAL = /^-?\d+([.,]\d+)?$/;
const FRACTION = /^(-?)(?:(\d+)\s+)?(\d+)\/(\d+)$/; // 78 3/4, 3/4, -1 1/2 (inches only)

export const isUnit = (value) => UNITS.includes(value);

/** The number part, e.g. `'64.3'` for 643 mm in cm. */
export function formatLength(mm, unit = DEFAULT_UNIT) {
  const { mmPer, decimals } = SPECS[isUnit(unit) ? unit : DEFAULT_UNIT];
  return (mm / mmPer).toFixed(decimals);
}

/** Number and unit, e.g. `'64.3 cm'`. */
export const formatWithUnit = (mm, unit = DEFAULT_UNIT) => `${formatLength(mm, unit)} ${isUnit(unit) ? unit : DEFAULT_UNIT}`;

/**
 * Typed text in `unit` to **integer millimetres**: `{ ok: true, mm }` or `{ ok: false, message }`.
 * `.` or `,` decimals; inches also accept fractions such as `78 3/4`.
 */
export function parseLength(text, unit = DEFAULT_UNIT) {
  const code = isUnit(unit) ? unit : DEFAULT_UNIT;
  const { mmPer, example } = SPECS[code];
  const invalid = { ok: false, message: `Enter a number in ${code}, e.g. ${example}` };
  const trimmed = String(text ?? '').trim();
  let value;
  if (DECIMAL.test(trimmed)) {
    value = Number(trimmed.replace(',', '.'));
  } else if (code === 'in' && FRACTION.test(trimmed)) {
    const [, sign, whole = '0', numerator, denominator] = FRACTION.exec(trimmed);
    if (Number(denominator) === 0) return invalid;
    value = (sign ? -1 : 1) * (Number(whole) + Number(numerator) / Number(denominator));
  } else {
    return invalid;
  }
  const mm = Math.round(value * mmPer);
  if (!Number.isFinite(mm) || Math.abs(mm) > MAX_ABS_MM) return { ok: false, message: 'That value is too large' };
  return { ok: true, mm: mm === 0 ? 0 : mm }; // never -0
}

const STORAGE_KEY = 'banai.unit';

function readStored(storage) {
  try {
    const value = storage?.getItem(STORAGE_KEY);
    return isUnit(value) ? value : null;
  } catch {
    return null;
  }
}

/** The chosen display unit: `get`, `set`, `subscribe`. Remembered in the browser; failures are ignored. */
export function createUnitPreference({ storage = globalThis.localStorage, initial } = {}) {
  let unit = isUnit(initial) ? initial : readStored(storage) ?? DEFAULT_UNIT;
  const listeners = new Set();
  return {
    get: () => unit,
    set(next) {
      if (!isUnit(next) || next === unit) return;
      unit = next;
      try {
        storage?.setItem(STORAGE_KEY, next);
      } catch {
        // not remembered; the choice still applies for this visit
      }
      listeners.forEach((listener) => listener(unit));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
