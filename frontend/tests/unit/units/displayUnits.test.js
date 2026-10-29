import { describe, expect, it, vi } from 'vitest';
import { createStore } from '../../../src/state/store.js';
import { basicWardrobe } from '../../../src/domain/presets.js';
import { dimensionOps } from '../../../src/editor/opsFromForm.js';
import { cm, describeSelection } from '../../../src/viewer/format.js';
import { cmField, lengthField } from '../../../src/editor/fields.js';
import {
  DEFAULT_UNIT, UNITS, createUnitPreference, formatLength, formatWithUnit, parseLength,
} from '../../../src/units/displayUnits.js';
import { loadCatalog } from '../domain/helpers.js';

describe('formatLength', () => {
  it('shows each unit with its own number of decimals', () => {
    expect(formatLength(643, 'cm')).toBe('64.3');
    expect(formatLength(643, 'mm')).toBe('643');
    expect(formatLength(643, 'in')).toBe('25.31');
    expect(formatWithUnit(2000, 'cm')).toBe('200.0 cm');
    expect(formatWithUnit(2000, 'mm')).toBe('2000 mm');
    expect(formatWithUnit(2000, 'in')).toBe('78.74 in');
    expect(formatWithUnit(18, 'in')).toBe('0.71 in');
  });

  it('handles zero and negatives, and falls back to cm for an unknown unit', () => {
    expect(formatLength(0, 'in')).toBe('0.00');
    expect(formatLength(-500, 'cm')).toBe('-50.0');
    expect(formatWithUnit(1000, 'furlong')).toBe('100.0 cm');
  });
});

describe('parseLength', () => {
  it('turns typed text into integer millimetres for each unit', () => {
    expect(parseLength('64.3', 'cm')).toEqual({ ok: true, mm: 643 });
    expect(parseLength(' 200 ', 'cm')).toEqual({ ok: true, mm: 2000 });
    expect(parseLength('64,35', 'cm')).toEqual({ ok: true, mm: 644 });
    expect(parseLength('2000', 'mm')).toEqual({ ok: true, mm: 2000 });
    expect(parseLength('1999.6', 'mm')).toEqual({ ok: true, mm: 2000 });
    expect(parseLength('78.74', 'in')).toEqual({ ok: true, mm: 2000 });
    expect(parseLength('1', 'in')).toEqual({ ok: true, mm: 25 });
  });

  it('accepts inch fractions', () => {
    expect(parseLength('78 3/4', 'in')).toEqual({ ok: true, mm: Math.round(78.75 * 25.4) });
    expect(parseLength('3/4', 'in')).toEqual({ ok: true, mm: 19 });
    expect(parseLength('-1 1/2', 'in')).toEqual({ ok: true, mm: -38 });
    expect(parseLength('3/0', 'in').ok).toBe(false);
    expect(parseLength('3/4', 'cm').ok).toBe(false); // fractions are for inches only
  });

  it('rejects empty, non-numeric and absurd input with the unit in the message', () => {
    for (const unit of UNITS) {
      for (const text of ['', '   ', 'abc', '12cm', 'Infinity', '1e9', '--5', '1..2']) {
        expect(parseLength(text, unit).ok, `${unit} "${text}"`).toBe(false);
      }
      expect(parseLength('abc', unit).message).toContain(unit);
      expect(parseLength('99999999999', unit)).toEqual({ ok: false, message: 'That value is too large' });
    }
  });

  it('never returns negative zero', () => {
    expect(Object.is(parseLength('-0', 'cm').mm, 0)).toBe(true);
    expect(Object.is(parseLength('-0.01', 'in').mm, 0)).toBe(true);
  });
});

describe('integer millimetres are the only thing that leaves this module', () => {
  it('every parsed value is an integer, for a sweep of inputs in every unit', () => {
    for (const unit of UNITS) {
      for (let tenths = -50; tenths <= 30_000; tenths += 37) {
        const result = parseLength(String(tenths / 10), unit);
        if (result.ok) expect(Number.isInteger(result.mm), `${unit} ${tenths / 10}`).toBe(true);
      }
    }
  });

  it('format then parse returns to within half a display step', () => {
    const halfStep = { cm: 5, mm: 0.5, in: 0.005 * 25.4 };
    for (const unit of UNITS) {
      for (let mm = 0; mm <= 5000; mm += 7) {
        const back = parseLength(formatLength(mm, unit), unit);
        expect(back.ok).toBe(true);
        expect(Math.abs(back.mm - mm)).toBeLessThanOrEqual(halfStep[unit] + 1e-9);
      }
    }
  });

  it('mm round-trips exactly', () => {
    for (let mm = 0; mm <= 5000; mm += 13) expect(parseLength(formatLength(mm, 'mm'), 'mm').mm).toBe(mm);
  });
});

describe('selection labels follow the unit', () => {
  const design = basicWardrobe(loadCatalog());
  it('describes the wardrobe and a shelf in each unit', () => {
    expect(describeSelection(design, { id: 'carcass', kind: 'carcass' }, 'cm')).toBe('Wardrobe · 200.0 × 240.0 × 60.0 cm');
    expect(describeSelection(design, { id: 'carcass', kind: 'carcass' }, 'mm')).toBe('Wardrobe · 2000 × 2400 × 600 mm');
    expect(describeSelection(design, { id: 'carcass', kind: 'carcass' }, 'in')).toBe('Wardrobe · 78.74 × 94.49 × 23.62 in');
    expect(describeSelection(design, { id: 'carcass', kind: 'carcass' })).toBe('Wardrobe · 200.0 × 240.0 × 60.0 cm'); // default
    const shelf = design.compartments[0].shelves[0];
    expect(describeSelection(design, { id: shelf.id, kind: 'shelf' }, 'mm')).toBe(`Shelf · ${shelf.y} mm from base · ${shelf.thickness} mm thick`);
  });
});

describe('unit preference', () => {
  const memory = () => {
    const data = new Map();
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  };

  it('defaults to cm, validates, persists and notifies', () => {
    const storage = memory();
    const preference = createUnitPreference({ storage });
    expect(preference.get()).toBe(DEFAULT_UNIT);
    const seen = [];
    preference.subscribe((unit) => seen.push(unit));
    preference.set('in');
    preference.set('in'); // no change, no notification
    preference.set('furlong'); // invalid, ignored
    preference.set('mm');
    expect(seen).toEqual(['in', 'mm']);
    expect(preference.get()).toBe('mm');
    expect(createUnitPreference({ storage }).get()).toBe('mm'); // remembered
  });

  it('survives storage that throws', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const preference = createUnitPreference({ storage: broken });
    expect(preference.get()).toBe('cm');
    expect(() => preference.set('in')).not.toThrow();
    expect(preference.get()).toBe('in');
  });

  it('ignores a stored value that is not a unit', () => {
    const storage = { getItem: () => 'parsec', setItem: () => {} };
    expect(createUnitPreference({ storage }).get()).toBe('cm');
  });
});

describe('changing the display unit never touches the design state', () => {
  it('leaves the store untouched and notifies nobody; typed inches become integer mm ops', () => {
    const catalog = loadCatalog();
    const store = createStore({ design: basicWardrobe(catalog), revision: 4, catalog });
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getState();

    const preference = createUnitPreference({ storage: null });
    for (const unit of UNITS) preference.set(unit);

    expect(store.getState()).toBe(before);
    expect(listener).not.toHaveBeenCalled();

    const parsed = parseLength('78.74', 'in');
    const ops = dimensionOps('width', parsed.mm);
    expect(ops).toEqual([{ op: 'update_dimensions', width: 2000 }]);
    expect(Number.isInteger(ops[0].width)).toBe(true);
  });
});

describe('names that other code already imports keep working', () => {
  it('cm() is the old centimetre formatter', () => {
    expect(cm(643)).toBe('64.3');
    expect(cm(2000)).toBe('200.0');
    expect(cm(0)).toBe('0.0');
    for (let mm = 0; mm <= 3000; mm += 11) expect(cm(mm)).toBe(formatLength(mm, 'cm'));
  });

  it('cmField and lengthField are exported (cmField delegates to lengthField with cm)', () => {
    expect(typeof cmField).toBe('function');
    expect(typeof lengthField).toBe('function');
  });
});
