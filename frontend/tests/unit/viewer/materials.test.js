import { describe, expect, it } from 'vitest';
import { createMaterials } from '../../../src/viewer/materials.js';
import { loadCatalog } from '../domain/helpers.js';

const appearance = (color, material = 'melamine') => ({
  material: { catalogId: material },
  color: { catalogId: color },
  finish: { catalogId: 'matte' },
});

describe('createMaterials', () => {
  it.each([
    ['sage_green', '8f9e83'],
    ['navy_blue', '2b3a52'],
    ['sand_beige', 'd9c8ad'],
    ['olive_green', '6b6f45'],
    ['terracotta', 'b5654a'],
  ])('renders the catalog colour %s from its hex', (id, hex) => {
    const material = createMaterials(loadCatalog()).forAppearance(appearance(id, 'birch_plywood'));
    expect(material.color.getHexString()).toBe(hex);
  });

  it('offers solid oak as a material', () => {
    expect(loadCatalog().materials.map((m) => m.id)).toContain('solid_oak');
  });
});
