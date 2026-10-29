import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FOCUS_MS, compartmentPose, createFlight, overviewPose } from '../../../src/viewer/cameraFocus.js';
import { frameOf } from '../../../src/viewer/builders/frame.js';
import { loadDesign } from '../domain/helpers.js';

const design = loadDesign('basic');
const close = (a, b) => expect(a).toBeCloseTo(b, 9);

describe('camera poses', () => {
  const overview = overviewPose(design, 40);

  it('the overview looks at the middle of the whole wardrobe', () => {
    close(overview.target.x, 1.0); close(overview.target.y, 1.2); close(overview.target.z, -0.3);
  });

  it('a compartment pose targets the middle of that compartment', () => {
    const [x0, x1] = frameOf(design).ranges[1];
    const pose = compartmentPose(design, 'cmp_middle', overview);
    close(pose.target.x, (x0 + x1) / 2000);
    close(pose.target.y, 1.2); close(pose.target.z, -0.3);
  });

  it('the camera slides with the target, so angle and zoom are kept', () => {
    const pose = compartmentPose(design, 'cmp_right', overview);
    const before = overview.position.clone().sub(overview.target);
    const after = pose.position.clone().sub(pose.target);
    expect(after.distanceTo(before)).toBeCloseTo(0, 9);
  });

  it('a compartment that does not exist gives no pose', () => {
    expect(compartmentPose(design, 'cmp_nope', overview)).toBeNull();
  });
});

describe('createFlight', () => {
  const setup = () => {
    const camera = { position: new THREE.Vector3(0, 0, 5) };
    const controls = { target: new THREE.Vector3(0, 0, 0) };
    const pose = { position: new THREE.Vector3(2, 0, 5), target: new THREE.Vector3(2, 0, 0) };
    return { camera, controls, pose, flight: createFlight(camera, controls) };
  };

  it('moves smoothly and ends exactly on the pose', () => {
    const { camera, controls, pose, flight } = setup();
    flight.start(pose, false);
    flight.step(1000);
    expect(controls.target.x).toBeCloseTo(0, 9); // first frame: nothing moved yet
    flight.step(1000 + FOCUS_MS / 2);
    expect(controls.target.x).toBeGreaterThan(0.5);
    expect(controls.target.x).toBeLessThan(2);
    expect(flight.active).toBe(true);
    flight.step(1000 + FOCUS_MS);
    expect(controls.target.x).toBe(2);
    expect(camera.position.x).toBe(2);
    expect(flight.active).toBe(false);
  });

  it('jumps at once when the customer prefers reduced motion', () => {
    const { camera, controls, pose, flight } = setup();
    flight.start(pose, true);
    expect(controls.target.x).toBe(2);
    expect(camera.position.x).toBe(2);
    expect(flight.active).toBe(false);
  });

  it('cancel stops the move where it is', () => {
    const { controls, pose, flight } = setup();
    flight.start(pose, false);
    flight.step(0);
    flight.step(100);
    const at = controls.target.x;
    flight.cancel();
    flight.step(1000);
    expect(controls.target.x).toBe(at);
  });
});
