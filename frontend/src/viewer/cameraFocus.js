// Camera poses for the viewer. The camera is view state only: nothing here touches the design or the store.
import * as THREE from 'three';
import { frameOf } from './builders/frame.js';
import { toM } from './units.js';

export const FOCUS_MS = 400;

const easeOut = (t) => 1 - (1 - t) ** 3;

/** The general view: the whole wardrobe in frame (the pose the viewer starts with). */
export function overviewPose(design, fov) {
  const { width, height, depth } = design.dimensions;
  const target = new THREE.Vector3(toM(width / 2), toM(height / 2), toM(-depth / 2));
  const distance = (toM(Math.max(width, height)) / (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2)))) * 1.35;
  const position = new THREE.Vector3(target.x + distance * 0.35, target.y + distance * 0.12, distance);
  return { target, position };
}

/**
 * The pose that centres a compartment: the target moves to its middle and the camera slides by the same
 * amount, so the angle and the zoom the customer chose are kept. Null when the compartment is gone.
 */
export function compartmentPose(design, compartmentId, current) {
  const index = design.compartments.findIndex((compartment) => compartment.id === compartmentId);
  if (index < 0) return null;
  const [x0, x1] = frameOf(design).ranges[index];
  const { height, depth } = design.dimensions;
  const target = new THREE.Vector3(toM((x0 + x1) / 2), toM(height / 2), toM(-depth / 2));
  return { target, position: current.position.clone().add(target.clone().sub(current.target)) };
}

/** A timed move of the camera between two poses. `reduced` makes it a jump. */
export function createFlight(camera, controls) {
  let move = null;
  return {
    start(pose, reduced) {
      if (reduced) {
        move = null;
        camera.position.copy(pose.position);
        controls.target.copy(pose.target);
        return;
      }
      move = { from: { position: camera.position.clone(), target: controls.target.clone() }, to: pose, begun: null };
    },
    cancel() { move = null; },
    /** Call once per frame with the frame's timestamp (ms). */
    step(now) {
      if (!move) return;
      move.begun ??= now;
      const progress = Math.min((now - move.begun) / FOCUS_MS, 1);
      const eased = easeOut(progress);
      camera.position.lerpVectors(move.from.position, move.to.position, eased);
      controls.target.lerpVectors(move.from.target, move.to.target, eased);
      if (progress === 1) move = null;
    },
    get active() { return move !== null; },
  };
}
