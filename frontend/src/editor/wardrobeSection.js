// Always-visible wardrobe settings: overall dimensions, doors and main materials.
// Inputs report their own errors inline; buttons/selects report under their section.
import { appearanceControls } from './appearanceControls.js';
import { actionResult, lengthField, countField, el, section, segmented } from './fields.js';
import { dimensionOps, doorTypeOps } from './opsFromForm.js';

function dimensionsRow(design, run, unit) {
  const { width, height, depth } = design.dimensions;
  return el('div', { className: 'field-row field-row--3' }, [
    lengthField({ unit, label: 'Width', mm: width, testId: 'dim-width', onCommit: (mm) => run(dimensionOps('width', mm)) }),
    lengthField({ unit, label: 'Height', mm: height, testId: 'dim-height', onCommit: (mm) => run(dimensionOps('height', mm)) }),
    lengthField({ unit, label: 'Depth', mm: depth, testId: 'dim-depth', onCommit: (mm) => run(dimensionOps('depth', mm)) }),
  ]);
}

export function wardrobeSection({ design, catalog, run, unit }) {
  const { doors } = design;
  const wardrobe = section('Wardrobe', [dimensionsRow(design, run, unit)]);
  const runDoors = (ops) => actionResult(wardrobe, run(ops));
  wardrobe.append(segmented({
    label: 'Doors',
    testId: 'door-type',
    value: doors.type,
    options: [{ value: 'hinged', label: 'Hinged' }, { value: 'sliding', label: 'Sliding' }, { value: 'none', label: 'None' }],
    onChange: (type) => runDoors(doorTypeOps(type)),
  }));
  if (doors.type === 'sliding') {
    wardrobe.append(countField({
      label: 'Sliding panels', value: doors.items.length, testId: 'sliding-count',
      onCommit: (count) => run(doorTypeOps('sliding', count)),
    }));
  }

  const materials = section('Materials', []);
  const runMaterials = (ops) => actionResult(materials, run(ops));
  materials.append(appearanceControls({ catalog, appearance: design.carcass.appearance, target: 'carcass', run: runMaterials, label: 'Carcass & interior' }));
  if (doors.type !== 'none') {
    materials.append(appearanceControls({ catalog, appearance: doors.appearance, target: 'doors', run: runMaterials, label: 'Doors' }));
  }
  return [wardrobe, materials];
}
