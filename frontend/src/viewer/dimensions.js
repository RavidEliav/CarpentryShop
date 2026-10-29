// Dimension indicators: overall W/H/D lines with labels, plus a label for the selected
// component. Labels are CSS2D DOM nodes written with textContent only (never HTML).
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { describeSelection } from './format.js';
import { formatWithUnit } from '../units/displayUnits.js';
import { toM } from './units.js';

const OFFSET = 80; // mm, distance of dimension lines from the carcass (visual only)

function label(text, className) {
  const element = document.createElement('div');
  element.className = className;
  element.textContent = text;
  return new CSS2DObject(element);
}

export function createDimensions(scene) {
  const layer = new THREE.Group();
  layer.name = 'dimensions';
  scene.add(layer);
  const lineMaterial = new THREE.LineBasicMaterial({ color: '#5b6470' });

  const line = (from, to) => {
    const geometry = new THREE.BufferGeometry().setFromPoints([from, to].map(([x, y, z]) => new THREE.Vector3(toM(x), toM(y), toM(z))));
    layer.add(new THREE.Line(geometry, lineMaterial));
  };

  const place = (object, [x, y, z]) => {
    object.position.set(toM(x), toM(y), toM(z));
    layer.add(object);
  };

  const clear = () => {
    layer.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.element) child.element.remove();
    });
    layer.clear();
  };

  return {
    update(group, design, selection, unit = 'cm') {
      clear();
      const { width: w, height: h, depth: d } = design.dimensions;
      line([0, h + OFFSET, 0], [w, h + OFFSET, 0]);
      place(label(`W ${formatWithUnit(w, unit)}`, 'dim-label'), [w / 2, h + OFFSET, 0]);
      line([-OFFSET, 0, 0], [-OFFSET, h, 0]);
      place(label(`H ${formatWithUnit(h, unit)}`, 'dim-label'), [-OFFSET, h / 2, 0]);
      line([w + OFFSET, 0, 0], [w + OFFSET, 0, -d]);
      place(label(`D ${formatWithUnit(d, unit)}`, 'dim-label'), [w + OFFSET, 0, -d / 2]);

      if (!selection || !group) return;
      const target = group.children.find((mesh) => mesh.userData.componentId === selection.id);
      const anchor = target ? target.position : new THREE.Vector3(toM(w / 2), toM(h / 2), 0);
      const selected = label(describeSelection(design, selection, unit), 'dim-label dim-label--selected');
      selected.position.copy(anchor);
      selected.center.set(0.5, 1.6); // sit above the component instead of covering it
      layer.add(selected);
    },
    dispose() {
      clear();
      lineMaterial.dispose();
    },
  };
}
