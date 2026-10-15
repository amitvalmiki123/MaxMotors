import * as THREE from 'three';
import { isWheelName } from './names.js';
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
// Whole-word `led` / word-initial `lumi`: "tiled_carbon" and "aluminium" are not lamps.
const LIGHT_PATTERNS = [/light/i, /lamp/i, /(?:^|[^a-z])led(?:[^a-z]|$)/i, /beam/i, /emissive/i, /(?:^|[^a-z])lumi/i, /break/i, /indicator/i, /feu/i];
const HEADLIGHT_PATTERNS = [/headlight/i, /head_?lamp/i, /front.*light/i, /fog/i, /drl/i, /blanche/i];
const TAILLIGHT_PATTERNS = [/tail/i, /rear.*light/i, /back.*light/i, /brake/i, /break/i, /third/i, /rouge/i];
const INDICATOR_PATTERNS = [/indicator/i, /blinker/i, /turn.?signal/i, /orange/i, /amber/i];
const INTERIOR_PATTERNS = [/(?:^|[^a-z])int(?:_|$)/i, /interior/i, /seat/i, /dash/i, /cabin/i, /console/i, /steer/i];
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
      wheelish: isWheelName(object.name),
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
    // Priors mirror the asset pipeline (scripts/assets/optimize-glb.mjs) so the
    // runtime fallback agrees with the wheels baked into the manifest.
    expectedRadius: Math.max(0.12, carSize.z * 0.07),
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
  const materials = classifyCarMaterials(root, { paint, tier });

  const { box, size } = worldSize(group);

  return {
    group,
    root,
    wheels,
    complete: wheels.length === 4,
    problems,
    wheelDiagnostics,
    paintMaterials: materials.paintMaterials,
    glassMaterials: materials.glassMaterials,
    headlightMaterials: materials.lights.head,
    taillightMaterials: materials.lights.tail,
    indicatorMaterials: materials.lights.indicator,
    lightAnchors: materials.lightAnchors,
    wheelMaterials: materials.wheelMaterials,
    brandMaterials: materials.brandMaterials,
    bounds: { box, size },
    stats: materials.stats,
  };
}

const luminance = (color) => (color ? 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b : 0);

/** Black emissive is the three.js default (with emissiveIntensity = 1): not a lamp. */
function hasVisibleEmissive(material) {
  if (material.emissiveMap) return true;
  const emissive = material.emissive;
  if (!emissive) return false;
  return Math.max(emissive.r, emissive.g, emissive.b) > 0.02 && (material.emissiveIntensity ?? 1) > 0.05;
}

function hueRole(color) {
  if (!color) return null;
  const { r, g, b } = color;
  if (r > 0.3 && g < r * 0.45 && b < r * 0.45) return 'tail';
  if (r > 0.3 && g >= r * 0.2 && g <= r * 0.75 && b < r * 0.3) return 'indicator';
  return null;
}

/**
 * Classifies every material of a loaded car and applies the runtime treatment:
 * clearcoat paint on the exterior body, see-through glass, and emissive lamps
 * split into head / tail / indicator roles (a lamp material shared by front and
 * rear meshes is cloned so each end can switch on its own).
 *
 * `root` must be measured in rig space (the rig group has no parent yet).
 */
export function classifyCarMaterials(root, { paint = null, tier = null } = {}) {
  const usage = new Map();
  const meshBox = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
    const geometry = object.geometry;
    const triangles = geometry?.index ? geometry.index.count / 3 : (geometry?.attributes?.position?.count ?? 0) / 3;
    if (geometry && !geometry.boundingBox) geometry.computeBoundingBox();
    const center = geometry?.boundingBox
      ? meshBox.copy(geometry.boundingBox).applyMatrix4(object.matrixWorld).getCenter(new THREE.Vector3())
      : new THREE.Vector3();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      const entry = usage.get(material) ?? { triangles: 0, wheelTriangles: 0, interiorTriangles: 0, meshes: [] };
      entry.triangles += triangles;
      if (isWheelName(object.name)) entry.wheelTriangles += triangles;
      if (matchesAny(object.name, INTERIOR_PATTERNS)) entry.interiorTriangles += triangles;
      entry.meshes.push({ mesh: object, triangles, center });
      usage.set(material, entry);
    }
  });

  const glassMaterials = [];
  const wheelMaterials = [];
  const brandMaterials = [];
  const lightMaterials = [];
  const paintCandidates = [];
  for (const [material, entry] of usage) {
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
      material.envMapIntensity = tier?.mobile ? 0.8 : 1.4;
      glassMaterials.push(material);
      continue;
    }
    if (matchesAny(name, LIGHT_PATTERNS) || hasVisibleEmissive(material)) {
      lightMaterials.push(material);
      continue;
    }
    if (isWheelName(name) || entry.wheelTriangles > entry.triangles * 0.5) {
      wheelMaterials.push(material);
      continue;
    }
    const interior = matchesAny(name, INTERIOR_PATTERNS) || entry.interiorTriangles > entry.triangles * 0.5;
    if (!interior && matchesAny(name, PAINT_PATTERNS)) paintCandidates.push([material, entry]);
  }

  // One exterior paint: the biggest candidate, plus its duplicates (`Paint.001`).
  const stem = (name) => String(name ?? '').toLowerCase().replace(/[._-]?\d+$/, '');
  paintCandidates.sort((left, right) => right[1].triangles - left[1].triangles);
  const primary = paintCandidates[0]?.[0] ?? null;
  const paintSources = primary ? paintCandidates.filter(([material]) => stem(material.name) === stem(primary.name)).map(([material]) => material) : [];
  const paintMaterials = [];
  for (const material of paintSources) {
    // Clearcoat paint: keep the baked normal/roughness/AO maps, override colour.
    const physical = new THREE.MeshPhysicalMaterial({
      name: `${material.name}-paint`,
      color: new THREE.Color(paint?.color ?? '#d9b063'),
      map: material.map ?? null,
      normalMap: material.normalMap ?? null,
      roughnessMap: material.roughnessMap ?? null,
      metalnessMap: material.metalnessMap ?? null,
      aoMap: material.aoMap ?? null,
      alphaMap: material.alphaMap ?? null,
      metalness: paint?.metalness ?? 0.55,
      roughness: paint?.roughness ?? 0.25,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      envMapIntensity: tier?.mobile ? 0.9 : 1.25,
      side: material.side,
    });
    physical.userData.isPaint = true;
    // The source finish, so tools (the material audit) can show the factory paint.
    physical.userData.bakedColor = material.color?.clone() ?? new THREE.Color(0xffffff);
    physical.userData.bakedMetalness = material.metalness ?? 0.5;
    physical.userData.bakedRoughness = material.roughness ?? 0.4;
    replaceMaterialInScene(root, material, physical);
    paintMaterials.push(physical);
  }

  // Lamps: decide a role per mesh (mesh name, material name, colour, then which
  // end of the car it sits on), and clone a material shared across roles.
  const lights = { head: [], tail: [], indicator: [] };
  const anchors = { head: [], tail: [] };
  for (const material of lightMaterials) {
    const entry = usage.get(material);
    const lamp = hasVisibleEmissive(material) || luminance(material.color) > 0.25 || Boolean(material.map);
    if (!lamp) continue; // a dark housing or bezel: leave it alone
    const roleOf = ({ mesh, center }) => {
      const label = `${mesh.name}`;
      if (matchesAny(label, INDICATOR_PATTERNS)) return 'indicator';
      if (matchesAny(label, TAILLIGHT_PATTERNS)) return 'tail';
      if (matchesAny(label, HEADLIGHT_PATTERNS)) return 'head';
      if (matchesAny(material.name, INDICATOR_PATTERNS)) return 'indicator';
      if (matchesAny(material.name, TAILLIGHT_PATTERNS)) return 'tail';
      if (matchesAny(material.name, HEADLIGHT_PATTERNS)) return 'head';
      const hue = hueRole(hasVisibleEmissive(material) ? material.emissive : material.color);
      if (hue) return hue;
      return center.z <= 0 ? 'head' : 'tail';
    };
    const byRole = new Map();
    for (const use of entry.meshes) {
      const role = roleOf(use);
      const list = byRole.get(role) ?? [];
      list.push(use);
      byRole.set(role, list);
    }
    const ranked = [...byRole.entries()].sort((left, right) => (
      right[1].reduce((sum, use) => sum + use.triangles, 0) - left[1].reduce((sum, use) => sum + use.triangles, 0)
    ));
    ranked.forEach(([role, uses], index) => {
      const target = index === 0 ? material : material.clone();
      if (index > 0) {
        target.name = `${material.name}-${role}`;
        for (const { mesh } of uses) {
          mesh.material = Array.isArray(mesh.material)
            ? mesh.material.map((candidate) => (candidate === material ? target : candidate))
            : target;
        }
      }
      if (!hasVisibleEmissive(target)) {
        target.emissive = new THREE.Color(role === 'tail' ? 0xff2414 : role === 'indicator' ? 0xff8a1a : 0xfff1d6);
      }
      target.userData.lampRole = role;
      target.userData.baseEmissiveIntensity = Math.max(target.emissiveIntensity ?? 1, 1);
      target.toneMapped = true;
      lights[role].push(target);
      if (anchors[role]) for (const { center } of uses) anchors[role].push(center.toArray());
    });
  }

  // Lamp anchors: one point per side (left/right of the centreline) per role.
  const lightAnchors = {};
  for (const [role, points] of Object.entries(anchors)) {
    const sides = [points.filter((point) => point[0] < 0), points.filter((point) => point[0] >= 0)];
    lightAnchors[role] = sides
      .filter((list) => list.length)
      .map((list) => [0, 1, 2].map((axis) => list.reduce((sum, point) => sum + point[axis], 0) / list.length));
  }

  return {
    paintMaterials,
    glassMaterials,
    lights,
    lightAnchors,
    wheelMaterials,
    brandMaterials,
    stats: {
      meshes: usage.size,
      triangles: [...usage.values()].reduce((sum, entry) => sum + entry.triangles, 0),
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
