/**
 * Material audit viewer, driven by scripts/assets/render-compare.mjs.
 *
 * Every column is lit by the same HDRI (image-based lighting only, no extra
 * lights) and rendered from the same camera, so any difference between the
 * source and the optimized column comes from the optimize step, and any
 * difference between the optimized and the in-game column comes from the game's
 * runtime material treatment (src/game/cars/loader.js).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'meshoptimizer';
import { buildCarRig } from '/src/game/cars/loader.js';
import { getCar } from '/src/game/cars/catalog.js';

/** Camera directions in game space (front = -Z, left = -X, up = +Y). */
const VIEWS = {
  front34: [-0.64, 0.3, -0.72],
  rear34: [0.64, 0.3, 0.72],
  side: [-1, 0.12, 0.0001],
};

let renderer = null;
let environment = null;
let background = null;
let hdriSource = 'none';
let frame = null;
const slots = new Map();
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

function sceneStats(root) {
  let meshes = 0;
  let triangles = 0;
  const materials = new Set();
  root.traverse((object) => {
    if (!object.isMesh) return;
    meshes += 1;
    const geometry = object.geometry;
    const count = geometry.index ? geometry.index.count : geometry.attributes.position.count;
    triangles += count / 3;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material) materials.add(material.name || '(unnamed)');
    }
  });
  return { meshes, triangles: Math.round(triangles), materials: [...materials].sort() };
}

async function setup({ width, height, hdri }) {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  document.body.appendChild(renderer.domElement);
  const pmrem = new THREE.PMREMGenerator(renderer);
  try {
    if (!hdri) throw new Error('no HDRI file');
    const texture = await new HDRLoader().setDataType(THREE.HalfFloatType).loadAsync(hdri);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    environment = pmrem.fromEquirectangular(texture).texture;
    background = texture;
    hdriSource = `hdri ${texture.image?.width ?? '?'}x${texture.image?.height ?? '?'}`;
  } catch (error) {
    environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    background = new THREE.Color(0x8a9096);
    hdriSource = `room-environment fallback (${error?.message ?? error})`;
  }
  const gl = renderer.getContext();
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    hdri: hdriSource,
    gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  };
}

async function load({ column, url, manifest, carId, inGame = false }) {
  const gltf = await loader.loadAsync(url);
  let root;
  if (inGame) {
    const preset = getCar(carId);
    root = buildCarRig({ gltf, manifest, preset, paint: preset.paint[0], tier: { mobile: false } }).group;
  } else {
    // Same placement the game applies (manifest transform), so columns align.
    const transform = manifest?.transform ?? {};
    const model = gltf.scene;
    model.rotation.y = transform.yawRadians ?? 0;
    model.scale.setScalar(transform.scale ?? 1);
    if (Array.isArray(transform.position)) model.position.fromArray(transform.position);
    root = new THREE.Group();
    root.add(model);
  }
  const scene = new THREE.Scene();
  scene.environment = environment;
  scene.add(root);
  root.updateMatrixWorld(true);
  slots.set(column, { scene, root });
  if (column === 'source' || !frame) {
    const box = new THREE.Box3().setFromObject(root);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    frame = { center: sphere.center, radius: sphere.radius, size: box.getSize(new THREE.Vector3()).toArray() };
  }
  return sceneStats(root);
}

function render({ column, view, mask = false }) {
  const slot = slots.get(column);
  if (!slot) throw new Error(`column ${column} is not loaded`);
  const { width, height } = renderer.domElement;
  const camera = new THREE.PerspectiveCamera(28, width / height, 0.02, frame.radius * 40);
  const direction = new THREE.Vector3(...VIEWS[view]).normalize();
  const distance = (frame.radius / Math.sin(THREE.MathUtils.degToRad(14))) * 0.98;
  camera.position.copy(frame.center).addScaledVector(direction, distance);
  camera.lookAt(frame.center);
  if (mask) {
    slot.scene.background = null;
    renderer.setClearColor(0x000000, 0);
  } else {
    slot.scene.background = background;
    slot.scene.backgroundBlurriness = 0.45;
    renderer.setClearColor(0x000000, 1);
  }
  renderer.render(slot.scene, camera);
  return renderer.domElement.toDataURL('image/png');
}

function unloadAll() {
  for (const { scene } of slots.values()) {
    scene.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry?.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        for (const value of Object.values(material ?? {})) if (value?.isTexture) value.dispose();
        material?.dispose?.();
      }
    });
  }
  slots.clear();
  frame = null;
}

window.__audit = { setup, load, render, unloadAll, views: Object.keys(VIEWS), ready: true };
