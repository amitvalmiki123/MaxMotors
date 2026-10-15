import * as THREE from 'three';
import { clusterWheels, descriptorFromBounds } from './wheel-clusters.js';

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

/**
 * The GLTFLoader and the meshopt decoder are imported on demand: together they
 * are a large part of the bundle and nothing needs them until a model loads.
 */
export async function createGLTFLoader() {
  if (cachedLoader) return cachedLoader;
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('meshoptimizer'),
  ]);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  cachedLoader = loader;
  return loader;
}

export async function loadGLTF(url, { onProgress } = {}) {
  const loader = await createGLTFLoader();
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

const WHEEL_NODE_PATTERN = /wheel|tyre|tire|rim|pneu|roue|jante/i;
/** Cannon's wheel order; `updateWheels` indexes `wheelInfos` with it. */
const WHEEL_ORDER = ['front-left', 'front-right', 'rear-left', 'rear-right'];

/**
 * Mirrors `THREE.PropertyBinding.sanitizeNodeName`, which `GLTFLoader` applies to
 * every node name (it strips `[].:/` and turns whitespace into `_`). Pipeline
 * paths are compared against loaded names, so both sides must sanitize.
 */
export function sanitizeNodeName(name) {
  return String(name ?? '').replace(/\s/g, '_').replace(/[[\].:/]/g, '');
}

/**
 * Resolves a pipeline node path such as `/0:Sketchfab_model/1:root/3:wheel_rf`.
 *
 * The leading number of each segment is the child index inside its parent, which
 * is stable — real exports repeat node names, and `GLTFLoader` renames
 * duplicates (`Object_5`, `Object_5_1`), so index paths are the only form that
 * survives a round trip through the loader. Legacy `name#occurrence` and plain
 * `name` segments are still accepted, matched against sanitized names.
 */
export function resolveNodePath(root, nodePath) {
  if (!nodePath) return null;
  const segments = String(nodePath).split('/').filter(Boolean);
  let current = root;
  for (const segment of segments) {
    let next = null;
    const separator = segment.indexOf(':');
    if (separator > 0) {
      const index = Number.parseInt(segment.slice(0, separator), 10);
      next = Number.isInteger(index) ? current.children[index] ?? null : null;
      if (next) {
        const expected = sanitizeNodeName(segment.slice(separator + 1));
        const actual = sanitizeNodeName(next.name);
        // Index wins; the name is a courtesy check so a stale manifest is loud.
        if (expected && actual && !actual.startsWith(expected)) {
          console.info(`Node path drift: expected "${expected}", found "${actual}"`);
        }
      }
    } else {
      const [rawName, rawIndex] = segment.split('#');
      const wanted = Number.parseInt(rawIndex ?? '0', 10) || 0;
      const name = sanitizeNodeName(rawName);
      let seen = 0;
      for (const child of current.children) {
        if (!sanitizeNodeName(child.name).startsWith(name)) continue;
        if (seen === wanted) {
          next = child;
          break;
        }
        seen += 1;
      }
    }
    if (!next) return null;
    current = next;
  }
  return current === root ? null : current;
}

/**
 * Collects disc-shaped mesh candidates from the loaded scene, measured in the
 * rig group's space (the group has no parent while the rig is built, so its
 * world matrix is the identity and `matrixWorld` is already group-local).
 *
 * Only the *node* name is inspected: these exports reuse wheel material names on
 * doors and dashboards (`int_door_lf_wheel_rf.2_0`), so mesh/material names
 * would drag interior trim into the wheel pivots.
 */
export function collectSceneCandidates(root) {
  const candidates = [];
  const objects = new Map();
  const box = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if (!object.isMesh || object.isInstancedMesh || !object.geometry) return;
    const geometry = object.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox) return;
    box.copy(geometry.boundingBox).applyMatrix4(object.matrixWorld);
    candidates.push(descriptorFromBounds({
      id: object.uuid,
      name: object.name || '(unnamed)',
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
      wheelish: WHEEL_NODE_PATTERN.test(object.name || ''),
    }));
    objects.set(object.uuid, object);
  });
  return { candidates, objects };
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
  // The rig is clustered from the loaded scene first (shape + naming, see
  // wheel-clusters.js) and only falls back to the manifest's recorded node paths
  // when that cannot explain four wheels.
  const wheels = [];
  const problems = [];
  const wheelDiagnostics = [];
  const wheelSpecs = (manifest?.wheels?.list ?? []).slice().sort((a, b) => {
    const order = { 'front-left': 0, 'front-right': 1, 'rear-left': 2, 'rear-right': 3 };
    return (order[a.corner] ?? 9) - (order[b.corner] ?? 9);
  });

  const plans = [];
  const { candidates, objects } = collectSceneCandidates(root);
  const carBox = new THREE.Box3().setFromObject(root);
  const carSize = carBox.getSize(new THREE.Vector3());
  const carCenter = carBox.getCenter(new THREE.Vector3());
  const clusters = clusterWheels(candidates, {
    modelWidth: carSize.x,
    modelCenterX: carCenter.x,
    groundY: carBox.min.y,
    height: carSize.y,
    halfLength: carSize.z / 2,
  });
  wheelDiagnostics.push({
    source: 'scene',
    detected: clusters.wheels.length,
    wheelbase: clusters.wheelbase,
    track: clusters.track,
    radius: clusters.radius,
    estimate: clusters.radiusEstimate,
  });

  if (clusters.complete) {
    for (const cluster of clusters.wheels) {
      const members = cluster.members.map((id) => objects.get(id)).filter(Boolean);
      if (!members.length) continue;
      plans.push({ corner: cluster.corner, position: cluster.center, members, source: 'scene' });
    }
  }

  if (plans.length !== 4) {
    if (plans.length) wheelDiagnostics.push({ source: 'scene', warning: 'incomplete, using the manifest' });
    plans.length = 0;
    for (const spec of wheelSpecs) {
      const members = (spec.memberPaths ?? []).map((memberPath) => resolveNodePath(root, memberPath));
      const unique = [...new Set(members.filter(Boolean))];
      if (!unique.length) {
        problems.push(`wheel ${spec.corner}: no meshes resolved`);
        continue;
      }
      if (!Array.isArray(spec.position)) {
        problems.push(`wheel ${spec.corner}: manifest has no position`);
        continue;
      }
      plans.push({ corner: spec.corner, position: spec.position, members: unique, source: 'manifest', spec });
    }
  }

  for (const plan of plans) {
    const steerPivot = new THREE.Group();
    steerPivot.name = `wheel-steer:${plan.corner}`;
    steerPivot.position.set(plan.position[0], plan.position[1], plan.position[2]);
    const spinPivot = new THREE.Group();
    spinPivot.name = `wheel-spin:${plan.corner}`;
    steerPivot.add(spinPivot);
    group.add(steerPivot);
    group.updateMatrixWorld(true);

    for (const member of plan.members) {
      // `attach` keeps the world transform while re-parenting, and the spin
      // pivot compensates any rest rotation so the axle stays on +X.
      spinPivot.attach(member);
      if (Math.abs(member.rotation.y) > 1e-4) member.rotation.y *= -1;
    }

    // Tread diameter measured after re-parenting, so it includes source scales.
    const { size } = worldSize(spinPivot);
    const measuredDiameter = Math.max(size.y, size.z);
    const measured = measuredDiameter > 0.05 ? measuredDiameter / 2 : null;
    const radius = measured ?? plan.spec?.radius ?? 0.33;

    wheels.push({
      corner: plan.corner,
      index: WHEEL_ORDER.indexOf(plan.corner),
      front: plan.corner.startsWith('front'),
      steerPivot,
      spinPivot,
      radius,
      measured: measured === null ? null : Number(measuredDiameter.toFixed(3)),
      manifestRadius: plan.spec?.radius ?? null,
      source: plan.source,
      width: size.x,
      members: plan.members.length,
    });
  }

  // A manifest corner order that disagrees with the scene is worth knowing about
  // (it usually means the shipped manifest is stale), but never blocks the rig.
  const manifestWheelbase = manifest?.wheels?.wheelbase ?? null;
  if (manifestWheelbase !== null && clusters.wheelbase !== null
    && Math.abs(manifestWheelbase - clusters.wheelbase) > Math.max(0.25, Math.abs(clusters.wheelbase) * 0.2)) {
    problems.push(`manifest wheelbase ${manifestWheelbase} vs measured ${clusters.wheelbase}`);
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
    wheelDiagnostics,
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
