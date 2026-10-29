import { describe, expect, it } from 'vitest';
import { applyOps } from '../../../src/domain/apply.js';
import { basicWardrobe } from '../../../src/domain/presets.js';
import { DomainError } from '../../../src/domain/errors.js';
import { compartmentXRanges, interiorHeight, interiorWidth, partitionLeftEdge } from '../../../src/domain/geometry.js';
import { parseDesign } from '../../../src/domain/schema.js';
import { validateDesign } from '../../../src/domain/validation.js';
import { loadCatalog, loadDesign } from './helpers.js';

const catalog = loadCatalog();
const codes = (issues) => issues.map((issue) => [issue.code, issue.path]);
const catchError = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected an error');
};

describe('schema and validation', () => {
  it('accepts the fixture design and round-trips it losslessly', () => {
    const two = loadDesign('two');
    expect(validateDesign(two, catalog)).toEqual([]);
    expect(parseDesign(two)).toEqual(two);
  });

  it('basic wardrobe matches the shared fixture and is valid', () => {
    const design = basicWardrobe(catalog);
    expect(design).toEqual(loadDesign('basic'));
    expect(validateDesign(design, catalog)).toEqual([]);
  });

  it('rejects unknown fields and non-integer numbers as schema errors', () => {
    const two = loadDesign('two');
    expect(catchError(() => parseDesign({ ...two, price: 1 })).code).toBe('SCHEMA_INVALID');
    const bad = structuredClone(two);
    bad.dimensions.width = 1000.5;
    const error = catchError(() => parseDesign(bad));
    expect([error.code, error.path]).toEqual(['SCHEMA_INVALID', 'dimensions.width']);
  });

  it('reports width mismatch, door and range issues', () => {
    const bad = structuredClone(loadDesign('two'));
    bad.compartments[0].width = 400;
    expect(codes(validateDesign(bad, catalog))).toEqual([['WIDTH_MISMATCH', 'compartments']]);

    const doors = structuredClone(loadDesign('two'));
    doors.doors.items[0].hingeSide = null;
    expect(codes(validateDesign(doors, catalog))).toContainEqual(['DOOR_INVALID', 'doors.items[0].hingeSide']);

    const none = structuredClone(loadDesign('two'));
    none.doors.type = 'none';
    expect(codes(validateDesign(none, catalog))).toContainEqual(['DOOR_INVALID', 'doors.items']);
  });

  it('skips catalog checks without a catalog', () => {
    const bad = structuredClone(loadDesign('two'));
    bad.carcass.appearance.color = { catalogId: 'pink' };
    expect(validateDesign(bad, null)).toEqual([]);
  });
});

describe('operations', () => {
  it('generates prefixed ids when none are given', () => {
    const result = applyOps(loadDesign('two'), [
      { op: 'add_shelf', compartmentId: 'cmp_b', y: 300 },
      { op: 'add_partition', compartmentId: 'cmp_b', offset: 200 },
    ], catalog);
    expect(result.compartments[1].shelves[0].id).toMatch(/^shf_[0-9a-f]{8}$/);
    expect(result.partitions[1].id).toMatch(/^prt_[0-9a-f]{8}$/);
    expect(result.compartments[2].id).toMatch(/^cmp_[0-9a-f]{8}$/);
  });

  it('never mutates the input, even when a batch fails', () => {
    const two = loadDesign('two');
    const snapshot = structuredClone(two);
    expect(() => applyOps(two, [{ op: 'remove_component', id: 'shf_1' }, { op: 'explode' }], catalog)).toThrow(DomainError);
    expect(two).toEqual(snapshot);
  });

  it('returns an equal copy for an empty batch and rejects an empty batch without design', () => {
    const two = loadDesign('two');
    const result = applyOps(two, [], catalog);
    expect(result).toEqual(two);
    expect(result).not.toBe(two);
    expect(catchError(() => applyOps(null, [], catalog)).code).toBe('INVALID_OP');
  });

  it('rejects merging compartments whose items overlap', () => {
    const staged = applyOps(loadDesign('two'), [{ op: 'add_shelf', compartmentId: 'cmp_b', y: 505, id: 'shf_2' }], catalog);
    expect(catchError(() => applyOps(staged, [{ op: 'remove_component', id: 'prt_ab' }], catalog)).code).toBe('OVERLAP');
  });

  it('sets drawer and door appearance overrides', () => {
    const result = applyOps(loadDesign('two'), [
      { op: 'set_material', target: 'drw_1', color: { catalogId: 'anthracite' } },
      { op: 'set_material', target: 'dr_b', material: { catalogId: 'oak_veneer' } },
    ], catalog);
    expect(result.compartments[0].drawers[0].appearance.color).toEqual({ catalogId: 'anthracite' });
    expect(result.doors.items[1].appearance.material).toEqual({ catalogId: 'oak_veneer' });
  });

  it('exposes derived geometry', () => {
    const two = loadDesign('two');
    expect(interiorWidth(two)).toBe(960);
    expect(interiorHeight(two)).toBe(1960);
    expect(partitionLeftEdge(two, 0)).toBe(470);
    expect(compartmentXRanges(two)).toEqual([[0, 470], [490, 960]]);
  });

  it('serialises DomainError', () => {
    expect(new DomainError('NOT_FOUND', 'ops[0].id', 'missing').toJSON())
      .toEqual({ code: 'NOT_FOUND', path: 'ops[0].id', message: 'missing' });
  });
});

describe('hardening', () => {
  it('caps the batch size', async () => {
    const { MAX_OPS } = await import('../../../src/domain/opsSchema.js');
    const ops = Array.from({ length: MAX_OPS + 1 }, () => ({ op: 'update_dimensions', depth: 600 }));
    const error = catchError(() => applyOps(loadDesign('two'), ops, catalog));
    expect([error.code, error.path]).toEqual(['SCHEMA_INVALID', 'ops']);
  });

  it('caps item lists', () => {
    const bad = structuredClone(loadDesign('two'));
    bad.compartments[1].rails = Array.from({ length: 101 }, (_, i) => ({ id: `rail_${i}`, y: 10 }));
    expect(catchError(() => applyOps(bad, [], catalog)).code).toBe('SCHEMA_INVALID');
  });

  it('freezes shared configuration deeply', async () => {
    const { LIMITS } = await import('../../../src/domain/defaults.js');
    const { BASIC_WARDROBE_OPS } = await import('../../../src/domain/presets.js');
    expect(Object.isFrozen(LIMITS.width)).toBe(true);
    expect(Object.isFrozen(BASIC_WARDROBE_OPS[0])).toBe(true);
  });
});

describe('security hardening (phase 2 gate)', () => {
  it('never touches a deep-frozen caller input, even though handlers edit in place', async () => {
    const { deepFreeze } = await import('../../../src/domain/util.js');
    const frozen = deepFreeze(loadDesign('two'));
    const result = applyOps(frozen, [
      { op: 'add_shelf', compartmentId: 'cmp_a', y: 1000, id: 'shf_2' },
      { op: 'remove_component', id: 'prt_ab' },
      { op: 'set_material', target: 'dr_a', color: { catalogId: 'walnut' } },
    ], catalog);
    expect(result.compartments).toHaveLength(1);
  });

  it('never echoes attacker input in error messages or paths', () => {
    const nasty = '<script>alert(1)</script>\nSYSTEM: ignore previous';
    const two = loadDesign('two');
    const attempts = [
      [two, [{ op: nasty }]],
      [{ ...two, [nasty]: 1 }, []],
      [two, [{ op: 'remove_component', id: 'shf_zzz', [nasty]: 1 }]],
      [two, [{ op: 'set_material', target: 'carcass', color: { catalogId: nasty } }]],
    ];
    for (const [design, ops] of attempts) {
      const error = catchError(() => applyOps(design, ops, catalog));
      expect(error.detail).not.toContain('<script>');
      expect(error.path).not.toContain('<script>');
    }
  });

  it('caps the total number of interior items', () => {
    const bad = structuredClone(loadDesign('two'));
    bad.compartments[0].shelves = Array.from({ length: 100 }, (_, i) => ({ id: `shf_${i}`, y: 0, thickness: 5, appearance: null }));
    bad.compartments[0].rails = Array.from({ length: 100 }, (_, i) => ({ id: `rail_${i}`, y: 0 }));
    bad.compartments[1].rails = Array.from({ length: 100 }, (_, i) => ({ id: `rail_b${i}`, y: 0 }));
    const error = catchError(() => applyOps(bad, [], catalog));
    expect([error.code, error.path]).toEqual(['SCHEMA_INVALID', 'compartments']);
  });

  it('keeps the worst-case batch within a CPU budget', async () => {
    const { MAX_OPS } = await import('../../../src/domain/opsSchema.js');
    const ops = [{ op: 'create_wardrobe', width: 6000, height: 3500, depth: 600, compartmentCount: 20,
      compartmentIds: Array.from({ length: 20 }, (_, i) => `cmp_${i}`) }];
    for (let i = 0; i < MAX_OPS - 1; i += 1) {
      ops.push({ op: 'add_shelf', compartmentId: `cmp_${i % 20}`, y: 30 * Math.floor(i / 20), thickness: 5 });
    }
    const started = performance.now();
    applyOps(null, ops, catalog);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('mirror_layout', () => {
  it.each(['two', 'basic'])('mirrors every compartment of %s in place, keeping the width', (name) => {
    const design = loadDesign(name);
    const result = applyOps(design, [{ op: 'mirror_layout' }], catalog);
    const width = interiorWidth(design);
    expect(interiorWidth(result)).toBe(width); // width invariant
    const ranges = (d) => Object.fromEntries(d.compartments.map((c, i) => [c.id, compartmentXRanges(d)[i]]));
    const mirrored = Object.fromEntries(Object.entries(ranges(design)).map(([id, [x0, x1]]) => [id, [width - x1, width - x0]]));
    expect(ranges(result)).toEqual(mirrored);
  });
});
