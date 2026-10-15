import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'meshoptimizer';

/**
 * GLB car loader + rigger.
 *
 * The shipped GLBs are already normalized by the asset pipeline (forward = -Z,
 * origin on the road under the car, metres, wheel pivots measured), so this
 * module only has to:
 *   1. apply the manifest transform,
 *   2. move each wheel's meshes under a steer→spin pivot pair,
 *   3. upgrade the paint to clearcoat MeshPhysicalMaterial, mark glass, and make
 *      head/tail lights emissive,
 *   4. drop any leftover brand decal material.
 *
 * `MeshoptDecoder` covers EXT_meshopt_compression; textures ship as WebP
 * (EXT_texture_webp), which the loader decodes natively in modern browsers.
 */

const PAINT_PATTERNS = [/carosserie/i, /carpaint/i, /body/i, /paint/i, /primary/i, /orange/i, /rouge/i, /vert/i];
const GLASS_PATTERNS = [/vitres/i, /glass/i, /window/i, /windshield/i];
const LIGHT_PATTERNS = [/light/i, /lamp/i, /led/i, /beam/i, /emissive/i, /lum/i, /break/i, /indicator/i, /feu/i];
const HEADLIGHT_PATTERNS = [/headlight/i, /head_?lamp/i, /front.*light/i, /fog/i, /led/i, /indicator/i, /drl/i];
const TAILLIGHT_PATTERNS = [/tail/i, /rear.*light/i, /back.*light/i, /brake/i, /break/i, /exhaust/i, /third/i];
const BRAND_PATTERNS = [/badge/i, /logo/i, /emblem/i, /decal/i, /mahindra/i, /lamborghini/i, /scorpio/i];

let cachedLoader = null;

export function createGLTFLoader() {
  if (cachedLoader) return cachedLoader;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  cachedLoader = loader;
  return loader;
}

export function loadGLTF(url, { onProgress } = {}) {
  const loader = createGLTFLoader();
  return new Promise((resolve, reject) => {
    loader.load(url, (gltf) => resolve(gltf), (event) => onProgress?.(event), (error) => reject(error));
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

export async function loadCarAssets(preset, { onProgress } = {}) {
  const [gltf, manifest] = await Promise.all([
    loadGLTF(preset.modelUrl, { onProgress }),
    fetchJson(preset.manifestUrl),
  ]);
  return { gltf, manifest };
}

function matchesAny(name, patterns) {
  const value = (name ?? '').toLowerCase();
  return patterns.some((pattern) => pattern.test(value));
}

function worldSize(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  return { box, size };
}

/**
 * Builds the drivable rig from a loaded GLB.
 * Returns `null`-safe info so the caller can fall back to the box car.
 */
export function buildCarRig({ gltf, manifest, preset, paint, tier }) {
  const root = gltf.scene;
  const transform = manifest?.transform ?? {};
  root.rotation.y = transform.yawRadians ?? 0;
  root.scale.setScalar(transform.scale ?? 1);
  if (Array.isArray(transform.position)) root.position.fromArray(transform.position);

  const group = new THREE.Group();
  group.name = `car:${preset.id}`;
  group.add(root);

  root.updateMatrixWorld(true);

  // --- wheels: steer (Y) -> spin (X) -> source meshes -----------------------
  const wheels = [];
  const problems = [];
  const wheelSpecs = (manifest?.wheels?.list ?? []).slice().sort((a, b) => {
    const order = { 'front-left': 0, 'front-right': 1, 'rear-left': 2, 'rear-right': 3 };
    return (order[a.corner] ?? 9) - (order[b.corner] ?? 9);
  });

  for (const [index, spec] of wheelSpecs.entries()) {
    const members = (spec.memberPaths ?? []).map((memberPath) => root.getObjectByProperty('name', memberPath.split('/').pop()));
    const unique = [...new Set(members.filter(Boolean))];
    if (!unique.length) {
      problems.push(`wheel ${spec.corner}: no meshes resolved`);
      continue;
    }

    const steerPivot = new THREE.Group();
    steerPivot.name = `wheel-steer:${spec.corner}`;
    steerPivot.position.fromArray(spec.position);
    const spinPivot = new THREE.Group();
    spinPivot.name = `wheel-spin:${spec.corner}`;
    steerPivot.add(spinPivot);
    group.add(steerPivot);

    for (const member of unique) {
      // `attach` keeps the world transform while re-parenting, and the spin
      // pivot compensates any rest rotation so the axle stays on +X.
      spinPivot.attach(member);
      if (Math.abs(member.rotation.y) > 1e-4) member.rotation.y *= -1;
    }

    // Tread diameter measured after re-parenting, so it includes source scales.
    const { size } = worldSize(spinPivot);
    const measuredDiameter = Math.max(size.y, size.z);
    const radius = measuredDiameter > 0.05 ? measuredDiameter / 2 : (spec.radius ?? 0.33);

    wheels.push({
      corner: spec.corner,
      index,
      front: spec.corner.startsWith('front'),
      steerPivot,
      spinPivot,
      radius,
      measured: Number(measuredDiameter.toFixed(3)),
      manifestRadius: spec.radius ?? null,
      source: spec.source ?? 'manifest',
      width: size.x,
    });
  }

  // --- materials -----------------------------------------------------------
  const paintMaterials = [];
  const glassMaterials = [];
  const headlightMaterials = [];
  const taillightMaterials = [];
  const wheelMaterials = [];
  const brandMaterials = [];
  let bodyTriangles = 0;

  const materialStats = new Map();
  root.traverse((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const triangles = object.geometry?.index ? object.geometry.index.count / 3 : (object.geometry?.attributes?.position?.count ?? 0) / 3;
    for (const material of materials) {
      if (!material) continue;
      const stats = materialStats.get(material) ?? { triangles: 0, meshes: [] };
      stats.triangles += triangles;
      stats.meshes.push(object.name);
      materialStats.set(material, stats);
    }
    object.castShadow = true;
    object.receiveShadow = true;
  });

  const largestBody = [...materialStats.entries()]
    .filter(([material]) => matchesAny(material.name, PAINT_PATTERNS))
    .sort((a, b) => b[1].triangles - a[1].triangles)[0];

  for (const [material, stats] of materialStats) {
    const name = material.name ?? '';
    if (matchesAny(name, BRAND_PATTERNS) && !matchesAny(name, PAINT_PATTERNS)) {
      brandMaterials.push(name);
      material.dispose?.();
      continue;
    }
    if (matchesAny(name, GLASS_PATTERNS) || (material.transmission ?? 0) > 0) {
      material.transparent = true;
      material.opacity = Math.min(0.42, material.opacity ?? 1);
      material.depthWrite = false;
      material.side = THREE.DoubleSide;
      material.roughness = Math.max(0.05, (material.roughness ?? 0.2) * 0.8);
      glassMaterials.push(material);
      continue;
    }
    if (matchesAny(name, LIGHT_PATTERNS) || (material.emissiveIntensity ?? 0) > 0.05) {
      material.emissive = material.emissive ?? new THREE.Color(0xfff1d0);
      material.emissiveIntensity = Math.max(material.emissiveIntensity ?? 0.8, 1.35);
      material.toneMapped = true;
      const meshNames = stats.meshes.join(' ');
      if (matchesAny(`${name} ${meshNames}`, TAILLIGHT_PATTERNS)) taillightMaterials.push(material);
      else if (matchesAny(`${name} ${meshNames}`, HEADLIGHT_PATTERNS)) headlightMaterials.push(material);
      else headlightMaterials.push(material);
      continue;
    }
    const isWheel = /wheel|tyre|tire|rim|jante|pneu/i.test(`${name} ${stats.meshes[0] ?? ''}`);
    if (isWheel) {
      wheelMaterials.push(material);
      continue;
    }
    if (material === largestBody?.[0] || (matchesAny(name, PAINT_PATTERNS) && stats.triangles > bodyTriangles)) {
      bodyTriangles = stats.triangles;
      paintMaterials.push(material);
    }
  }

  // Clearcoat paint: keep the baked normal/roughness/AO maps, override colour.
  for (const material of paintMaterials) {
    const physical = new THREE.MeshPhysicalMaterial({
      name: `${material.name}-paint`,
      color: new THREE.Color(paint?.color ?? '#d9b063'),
      map: material.map ?? null,
      normalMap: material.normalMap ?? null,
      roughnessMap: material.roughnessMap ?? null,
      metalnessMap: material.metalnessMap ?? null,
      aoMap: material.aoMap ?? null,
      alphaMap: material.alphaMap ?? null,
      emissiveMap: material.emissiveMap ?? null,
      metalness: paint?.metalness ?? 0.55,
      roughness: paint?.roughness ?? 0.25,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      envMapIntensity: tier?.mobile ? 0.9 : 1.25,
      side: material.side,
    });
    physical.userData.isPaint = true;
    physical.userData.bakedColor = material.color?.clone() ?? new THREE.Color(0xffffff);
    replaceMaterialInScene(root, material, physical);
  }

  for (const material of glassMaterials) {
    material.envMapIntensity = tier?.mobile ? 0.8 : 1.4;
  }

  const { box, size } = worldSize(group);

  return {
    group,
    root,
    wheels,
    complete: wheels.length === 4,
    problems,
    paintMaterials: [...new Set(paintMaterials.map((material) => findReplacement(root, material)))],
    glassMaterials,
    headlightMaterials: [...new Set(headlightMaterials)],
    taillightMaterials: [...new Set(taillightMaterials)],
    wheelMaterials,
    brandMaterials,
    bounds: { box, size },
    stats: {
      meshes: materialStats.size,
      triangles: [...materialStats.values()].reduce((sum, stats) => sum + stats.triangles, 0),
    },
  };
}

function replaceMaterialInScene(root, oldMaterial, newMaterial) {
  root.traverse((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (!materials.includes(oldMaterial)) return;
    const swapped = materials.map((material) => (material === oldMaterial ? newMaterial : material));
    object.material = Array.isArray(object.material) ? swapped : swapped[0];
  });
}

function findReplacement(root, oldMaterial) {
  let found = null;
  root.traverse((object) => {
    if (found || !object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (materials.some((material) => material?.userData?.isPaint || material?.name === `${oldMaterial.name}-paint`)) {
      found = materials.find((material) => material?.userData?.isPaint) ?? null;
    }
  });
  return found ?? oldMaterial;
}

/** Applies a paint palette entry (colour + finish) to a rig. */
export function applyPaint(rig, paint) {
  for (const material of rig.paintMaterials) {
    if (!material) continue;
    material.color.set(paint.color);
    material.metalness = paint.metalness ?? material.metalness;
    material.roughness = paint.roughness ?? material.roughness;
    material.needsUpdate = true;
  }
}

/** Spins/steers the visual wheels from physics telemetry. */
export function updateWheels(rig, { wheelInfos = [], steerAngle = 0 } = {}) {
  for (const wheel of rig.wheels) {
    const info = wheelInfos[wheel.index];
    if (info) {
      wheel.spinPivot.rotation.x = -(info.rotation ?? 0);
      const suspension = info.suspensionLength ?? 0;
      const rest = info.suspensionRestLength ?? suspension;
      wheel.steerPivot.position.y = (wheel.steerPivot.userData.restY ??= wheel.steerPivot.position.y)
        + Math.max(0, rest - suspension);
    }
    if (wheel.front) wheel.steerPivot.rotation.y = steerAngle;
  }
}

export function disposeCarRig(rig) {
  rig?.root?.traverse?.((object) => {
    if (!object.isMesh) return;
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material?.userData?.isPaint) material?.dispose?.();
    }
  });
}
