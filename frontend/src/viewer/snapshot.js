// A clean, more photographic picture of the design for the carpenter PDF: rendered once, off
// screen, in its own small "studio" (wall + floor, soft shadows, environment reflections, wood
// grain), so it never disturbs the live viewer. It renders from the design only, like everything
// in the viewer, and the look is a visual prototype, not a material specification.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildWardrobe, disposeWardrobe } from './buildWardrobe.js';
import { createMaterials, FINISH_ROUGHNESS } from './materials.js';
import { toM } from './units.js';

// About the shape of the picture box on the PDF's first page, so the wardrobe fills it.
export const SNAPSHOT_SIZE = Object.freeze({ width: 1200, height: 1300 });
const WALL = '#ebe7e0';
const FLOOR = '#d8d1c6';
// ASSUMPTION: which catalog entries read as wood in the picture (visual only).
const WOOD_MATERIALS = new Set(['oak_veneer', 'birch_plywood', 'solid_oak']);
const WOOD_COLORS = new Set(['natural_oak', 'walnut']);

/** Deterministic pseudo-random numbers, so the same design always gives the same picture. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** A procedural vertical grain on the base colour (canvas texture). */
function woodTexture(hex) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const random = seeded(parseInt(hex.slice(1), 16));
  for (let i = 0; i < 70; i += 1) {
    const x = random() * canvas.width;
    const dark = random() < 0.6;
    ctx.strokeStyle = dark ? `rgba(60, 35, 15, ${0.08 + random() * 0.16})` : `rgba(255, 240, 215, ${0.04 + random() * 0.08})`;
    ctx.lineWidth = 0.6 + random() * 2.2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    const sway = 3 + random() * 10;
    const phase = random() * Math.PI * 2;
    for (let y = 0; y <= canvas.height; y += 16) {
      ctx.lineTo(x + Math.sin(y / 140 + phase) * sway, y);
    }
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** The viewer's materials, upgraded for the picture: physical shading, clearcoat on gloss, wood grain. */
function snapshotMaterials(catalog) {
  const base = createMaterials(catalog);
  const cache = new Map();
  const textures = [];
  return {
    ...base,
    forAppearance(appearance) {
      const key = JSON.stringify(appearance);
      if (!cache.has(key)) {
        const plain = base.forAppearance(appearance);
        const finish = appearance.finish.custom ? null : appearance.finish.catalogId;
        const wood = WOOD_MATERIALS.has(appearance.material.catalogId) || WOOD_COLORS.has(appearance.color.catalogId);
        const material = new THREE.MeshPhysicalMaterial({
          color: wood ? '#ffffff' : plain.color.clone(),
          roughness: FINISH_ROUGHNESS[finish] ?? plain.roughness,
          metalness: 0,
          clearcoat: finish === 'gloss' ? 0.6 : 0,
          clearcoatRoughness: 0.15,
        });
        if (wood) {
          material.map = woodTexture(`#${plain.color.getHexString()}`);
          textures.push(material.map);
        }
        cache.set(key, material);
      }
      return cache.get(key);
    },
    dispose() {
      cache.forEach((material) => material.dispose());
      textures.forEach((texture) => texture.dispose());
      base.dispose();
    },
  };
}

function studio(design, renderer) {
  const { width, height, depth } = design.dimensions;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(WALL);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = environment;
  scene.environmentIntensity = 0.4;

  scene.add(new THREE.HemisphereLight('#ffffff', '#cfc6b8', 0.6));
  const sun = new THREE.DirectionalLight('#fff6ea', 2.2);
  const reach = toM(Math.max(width, height)) * 1.6;
  sun.position.set(toM(width / 2) - reach * 0.5, reach * 1.1, reach);
  sun.target.position.set(toM(width / 2), 0, toM(-depth / 2));
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 6;
  sun.shadow.bias = -0.0004;
  Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 0.1, far: reach * 4 });
  scene.add(sun, sun.target);

  // A wall just behind the wardrobe and a floor: they catch the soft shadow, like a showroom photo.
  const size = toM(Math.max(width, height)) * 6;
  const surfaces = [
    [WALL, (mesh) => mesh.position.set(toM(width / 2), size / 2, toM(-depth) - 0.012)],
    [FLOOR, (mesh) => {
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(toM(width / 2), -0.0005, 0);
    }],
  ].map(([colour, place]) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ color: colour, roughness: 0.95 }));
    mesh.receiveShadow = true;
    place(mesh);
    scene.add(mesh);
    return mesh;
  });
  return { scene, environment, surfaces };
}

function frameCamera(camera, design) {
  const { width, height, depth } = design.dimensions;
  const center = new THREE.Vector3(toM(width / 2), toM(height / 2), toM(-depth / 2));
  const vertical = toM(height) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  const horizontal = toM(width) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
  const distance = Math.max(vertical, horizontal) * 1.28;
  camera.position.set(center.x + distance * 0.32, center.y + distance * 0.07, distance);
  camera.lookAt(center);
}

/**
 * Render the design to a data URL: JPEG by default (smaller than PNG for the PDF), or `type: 'image/png'`
 * for a picture the customer saves. Throws when WebGL is unavailable; callers fall back to the PDF's own
 * illustration or say the picture is not available.
 */
export function renderSnapshot(design, catalog, { width = SNAPSHOT_SIZE.width, height = SNAPSHOT_SIZE.height, type = 'image/jpeg' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  // Everything after the context exists is inside try, so a failure never leaks a WebGL context.
  let materials = null;
  let group = null;
  let staged = null;
  try {
    materials = snapshotMaterials(catalog);
    group = buildWardrobe(design, materials, { doorsVisible: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    staged = studio(design, renderer);
    group.traverse((object) => {
      if (object.isMesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    staged.scene.add(group);
    const camera = new THREE.PerspectiveCamera(22, width / height, 0.05, 80);
    frameCamera(camera, design);
    renderer.render(staged.scene, camera);
    return type === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.9);
  } finally {
    if (group) disposeWardrobe(group);
    if (staged) {
      staged.environment.dispose();
      staged.surfaces.forEach((mesh) => {
        mesh.geometry.dispose();
        mesh.material.dispose();
      });
    }
    materials?.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
