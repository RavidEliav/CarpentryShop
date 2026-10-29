// Click-to-select via raycasting. A drag (orbit) is not a click.
import * as THREE from 'three';

const CLICK_TOLERANCE_PX = 5;

export function attachPicking({ dom, camera, getTargets, onPick, onHover = () => {}, onDoubleClick = () => {} }) {
  const raycaster = new THREE.Raycaster();
  let down = null;

  const onPointerDown = (event) => {
    down = { x: event.clientX, y: event.clientY };
  };
  const hitAt = (event) => {
    const rect = dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    // Refresh world matrices first: a scene rebuilt since the last rendered frame would otherwise be
    // picked at its identity transform, and the click would miss (flaky when frames are slow).
    camera.updateMatrixWorld();
    const targets = getTargets();
    targets.forEach((object) => object.updateMatrixWorld(true));
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObjects(targets, false)[0] ?? null;
  };
  const onPointerUp = (event) => {
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_TOLERANCE_PX) return;
    down = null;
    onPick(hitAt(event));
  };
  // Hover feedback (cursor). Throttled to one raycast per frame; ignored while dragging.
  let hoverFrame = 0;
  const onPointerMove = (event) => {
    if (event.buttons || hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      onHover(hitAt(event));
    });
  };

  const onDblClick = (event) => onDoubleClick(hitAt(event));

  dom.addEventListener('pointerdown', onPointerDown);
  dom.addEventListener('pointerup', onPointerUp);
  dom.addEventListener('pointermove', onPointerMove);
  dom.addEventListener('dblclick', onDblClick);
  return () => {
    cancelAnimationFrame(hoverFrame);
    dom.removeEventListener('pointerdown', onPointerDown);
    dom.removeEventListener('pointerup', onPointerUp);
    dom.removeEventListener('pointermove', onPointerMove);
    dom.removeEventListener('dblclick', onDblClick);
  };
}
