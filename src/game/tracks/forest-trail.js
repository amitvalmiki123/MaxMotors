import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { loadGLTF } from '../cars/loader.js';
import { SURFACES } from '../surfaces.js';
import {
  createHeightSampler,
  decodeHeights,
  filterHeightOutliers,
  heightfieldMatrix,
} from './terrain-grid.js';

/**
 * Forest Dirt Trail — the CC BY 4.0 "Dirt Road Through Forest" scene (99.Miles)
 * with gameplay geometry baked by the asset pipeline:
 *
 *   public/tracks/forest-dirt-trail.glb          simplified + instanced scene
 *   public/tracks/forest-dirt-trail.terrain.json  heightfield + dirt-road path
 *
 * The terrain JSON carries a 2 m height grid (int16 centimetres, base64) that
 * becomes a cannon-es Heightfield, so the car drives on the real ground shape,
 * and a traced dirt-road centreline that defines the track bounds and the soft
 * walls that nudge the car back onto the trail.
 *
 * M2.6 reworks the ground, because the baked grid was measured from *every*
 * material the scene happened to call terrain — which, in a forest, included the
 * 105 m canopy, the 70k-triangle trunk atlas and standing grass cards. Taking
 * the lowest hit per cell turned that into a surface of spikes and holes: the
 * shipped payload measured 224 spikes and 223 holes (plus a 7×7 corner of cells
 * the bake never reached, written as a bare 0 and read back as a 96 m pit). The
 * car was being thrown around the trail by its own collision mesh.
 *
 * Two layers now fix that, because the shipped payload cannot be re-baked in the
 * browser:
 *   - the pipeline rebuilds the grid from ground materials only and filters it
 *     before writing (scripts/assets/terrain.mjs);
 *   - the runtime applies the *same* filter (tracks/terrain-grid.js, shared) to
 *     whatever payload it is given, and slope-limits the seam where the source's
 *     far-terrain sheet crosses the near grid.
 *
 * It also adds tree-trunk colliders, so hitting a tree stops the car instead of
 * letting it drive through the forest, and a **Free Roam** mode: the same scene
 * and the same collider, but the corridor soft-walls are replaced by a soft
 * outer edge at the heightfield boundary and the whole map is in play.
 */

const TRACK_ID = 'forest-dirt-trail';
const FREE_ROAM_ID = 'forest-free-roam';
const MODEL_URL = '/tracks/forest-dirt-trail.glb';
const TERRAIN_URL = '/tracks/forest-dirt-trail.terrain.json';
const DEFAULT_MANIFEST_URL = '/tracks/forest-dirt-trail.manifest.json';

/**
 * Corridor half-width used for the soft walls.
 *
 * M2.6 widened it: the traced road is ~12 m to the half-width and the M2 clamp
 * of 9.5 m put the soft walls inside the visible verges, so the trail felt like
 * a slot. The clamp now sits above the measured value and only guards against a
 * bad bake.
 */
const MAX_CORRIDOR_HALF_WIDTH = 13.5;
const MIN_CORRIDOR_HALF_WIDTH = 6;
/** Free Roam keeps this much of the heightfield edge as a soft margin. */
const FREE_ROAM_EDGE_MARGIN = 14;

export { decodeHeights };

/**
 * Decodes and cleans the shipped height grid.
 *
 * Memoized per terrain payload: the grid is 72k cells and both the heightfield
 * body and the sampler need it, so it must not be filtered twice.
 *
 * @returns {{heights: Float32Array, raw: Float32Array, spikes: number, holes: number,
 *            sentinelCells: number, steepCells: number}}
 */
const cleanedCache = new WeakMap();
export function resolveTerrainHeights(terrain) {
  if (cleanedCache.has(terrain)) return cleanedCache.get(terrain);
  const count = terrain.cols * terrain.rows;
  const raw = typeof terrain.heights === 'string'
    ? decodeHeights(terrain.heights, count)
    : Float32Array.from(terrain.heights ?? new Float32Array(count));
  // `sentinel`: the old serializer wrote unreachable cells as a bare 0, which
  // after the height offset becomes exactly `heightOffset` — a real-looking
  // number 96 m below the terrain. Treat it as "no data" and fill it in.
  const cleaned = filterHeightOutliers(raw, terrain.cols, terrain.rows, {
    sentinel: terrain.heightOffset ?? null,
  });
  const entry = {
    raw,
    heights: cleaned.values,
    spikes: cleaned.spikes,
    holes: cleaned.holes,
    sentinelCells: cleaned.sentinelCells,
    steepCells: cleaned.steepCells,
  };
  cleanedCache.set(terrain, entry);
  return entry;
}

export function buildHeightfieldBody(terrain, material) {
  const { cols, rows, cellSize, origin, heightOffset } = terrain;
  // `terrain.heights` is the base64 payload from the JSON, decoded and cleaned by
  // resolveTerrainHeights: it used to be indexed as-is, which filled the
  // heightfield with single characters ('A', '/', …) so every raycast missed.
  const { heights } = resolveTerrainHeights(terrain);
  // cannon's Heightfield lives in the local X/Y plane with heights along +Z, and
  // data[i][j] maps to (x = i, y = j). Rotating the body -90° about X turns local
  // +Z into world +Y and local +Y into world -Z, so rows are flipped here.
  const shape = new CANNON.Heightfield(heightfieldMatrix(heights, cols, rows), { elementSize: cellSize });
  const body = new CANNON.Body({ mass: 0, material });
  body.addShape(shape);
  // The pipeline bakes `heightOffset` into every stored height (and the road
  // path), see serializeTrail() in scripts/assets/terrain.mjs. Adding it again
  // here sank the collider ~160 m under the spawn point.
  void heightOffset;
  body.position.set(origin[0], 0, origin[2] + (rows - 1) * cellSize);
  body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  body.updateAABB?.();
  return body;
}

/** Nearest point on the road polyline, with a hint index for cheap per-frame use. */
function createPathIndexer(path) {
  const points = path.map(([x, y, z]) => ({ x, y, z }));
  let hint = 0;

  const segmentDistance = (x, z, from, to) => {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const lengthSquared = dx * dx + dz * dz;
    let t = lengthSquared > 0 ? ((x - from.x) * dx + (z - from.z) * dz) / lengthSquared : 0;
    t = Math.max(0, Math.min(1, t));
    const px = from.x + dx * t;
    const pz = from.z + dz * t;
    const py = from.y + (to.y - from.y) * t;
    return { distance: Math.hypot(x - px, z - pz), py, index: 0 };
  };

  return {
    points,
    nearest(x, z) {
      let best = { distance: Infinity, py: 0, index: hint };
      const count = points.length;
      const visit = (index) => {
        const from = points[index];
        const to = points[(index + 1) % count];
        const result = segmentDistance(x, z, from, to);
        if (result.distance < best.distance) best = { ...result, index };
      };
      // Local window around the previous frame's answer, plus a coarse global
      // sweep so the car can be teleported (reset / spawn) safely.
      const window = Math.min(24, Math.max(4, Math.floor(count / 8)));
      for (let offset = -window; offset <= window; offset += 1) {
        visit(((hint + offset) % count + count) % count);
      }
      const global = Math.max(4, Math.floor(count / 12));
      for (let step = 0; step < global; step += 1) visit(Math.floor((step / global) * count));
      hint = best.index;
      const direction = {
        x: points[(best.index + 1) % count].x - points[best.index].x,
        z: points[(best.index + 1) % count].z - points[best.index].z,
      };
      return { ...best, direction, hint: best.index };
    },
  };
}

/**
 * Spawn on the first stretch of the trail where the ground under a car is
 * flat and stays drivable for the next few centreline points. The traced path
 * starts at the map edge, where the baked heightfield has 18–20 m steps (the
 * far-terrain layer bleeds into the grid) — spawning on `path[0]` put a wheel
 * over a 3.7 m drop.
 */
export function pickSpawnIndex(points, heightAt, { lookAhead = 6, maxRoughness = 0.35, maxSlope = 0.08 } = {}) {
  const score = (index) => {
    const point = points[index];
    const ahead = points[Math.min(points.length - 1, index + 2)];
    const behind = points[Math.max(0, index - 2)];
    let dx = ahead.x - behind.x;
    let dz = ahead.z - behind.z;
    const length = Math.hypot(dx, dz) || 1;
    dx /= length;
    dz /= length;
    const samples = [];
    for (const along of [-1.6, 0, 1.6]) {
      for (const side of [-1, 0, 1]) samples.push(heightAt(point.x + dx * along - dz * side, point.z + dz * along + dx * side));
    }
    const slope = (heightAt(point.x + dx * 3, point.z + dz * 3) - heightAt(point.x - dx * 3, point.z - dz * 3)) / 6;
    return { roughness: Math.max(...samples) - Math.min(...samples), slope: Math.abs(slope) };
  };
  const scores = points.map((_, index) => score(index));
  const smooth = (index) => scores[index].roughness < maxRoughness && scores[index].slope < maxSlope;
  for (let index = 0; index < points.length - lookAhead; index += 1) {
    let ok = true;
    for (let step = 0; step <= lookAhead && ok; step += 1) ok = smooth(index + step);
    if (ok) return index;
  }
  return scores.reduce((best, entry, index) => (entry.roughness < scores[best].roughness ? index : best), 0);
}

const TRUNK_MATERIAL = /trunk/i;

/**
 * Recovers the trees from the loaded scene.
 *
 * The trunk atlas ships as one merged primitive per species covering every trunk
 * in the forest, so trunks are found by clustering their vertices on a coarse XZ
 * grid: a cluster that is tall and narrow is a trunk, one that is wide or short
 * is a branch fan, a root flare or a bush. Vertices are sampled with a stride so
 * a 70k-triangle atlas costs a few milliseconds rather than a hitch.
 *
 * Used only when the pipeline has not baked `terrain.trunks` into the payload —
 * the baked list is preferred because it is measured from the unsimplified
 * source geometry.
 *
 * @returns {Array<{x: number, z: number, radius: number, baseY: number, topY: number}>}
 */
export function deriveTrunks(model, heightAt, {
  cellSize = 2.4,
  minHeight = 3.2,
  minRadius = 0.16,
  maxRadius = 1.6,
  maxLean = 0.6,
  maxVerticesPerMesh = 6000,
} = {}) {
  model.updateMatrixWorld(true);
  const buckets = new Map();
  const point = new THREE.Vector3();
  const instance = new THREE.Matrix4();
  const up = new THREE.Vector3();

  const addPoint = (x, y, z) => {
    const key = `${Math.floor(x / cellSize)}:${Math.floor(z / cellSize)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { count: 0, sumX: 0, sumZ: 0, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, minY: Infinity, maxY: -Infinity };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    bucket.sumX += x;
    bucket.sumZ += z;
    bucket.minX = Math.min(bucket.minX, x);
    bucket.maxX = Math.max(bucket.maxX, x);
    bucket.minZ = Math.min(bucket.minZ, z);
    bucket.maxZ = Math.max(bucket.maxZ, z);
    bucket.minY = Math.min(bucket.minY, y);
    bucket.maxY = Math.max(bucket.maxY, y);
  };

  model.traverse((object) => {
    const isInstanced = Boolean(object.isInstancedMesh);
    if (!object.isMesh && !isInstanced) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (!materials.some((material) => TRUNK_MATERIAL.test(material?.name ?? ''))) return;
    const position = object.geometry?.getAttribute('position');
    if (!position?.count) return;
    // Sampled: the trunk atlas is one merged primitive covering every trunk in
    // the scene (25k triangles here), and a cluster only needs enough points to
    // measure its footprint and height.
    const stride = Math.max(1, Math.ceil(position.count / maxVerticesPerMesh));
    const instances = isInstanced ? object.count : 1;
    for (let copy = 0; copy < instances; copy += 1) {
      if (isInstanced) {
        object.getMatrixAt(copy, instance);
        instance.premultiply(object.matrixWorld);
        // A trunk stands up: an instance tipped more than ~25° off vertical is a
        // fallen log or a branch fan, and colliding with either is wrong.
        up.set(0, 1, 0).applyMatrix4(new THREE.Matrix4().extractRotation(instance));
        if (up.y < 0.9) continue;
      }
      for (let index = 0; index < position.count; index += stride) {
        point.fromBufferAttribute(position, index);
        // Read the source vertex fresh for every instance: transforming the
        // previous instance's already-transformed point compounds the matrices.
        if (isInstanced) point.applyMatrix4(instance);
        else point.applyMatrix4(object.matrixWorld);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        addPoint(point.x, point.y, point.z);
      }
    }
  });

  const trunks = [];
  for (const bucket of buckets.values()) {
    if (bucket.count < 12) continue;
    const width = bucket.maxX - bucket.minX;
    const depth = bucket.maxZ - bucket.minZ;
    const height = bucket.maxY - bucket.minY;
    const radius = Math.max(width, depth) / 2;
    if (height < minHeight || radius < minRadius || radius > maxRadius) continue;
    if (Math.min(width, depth) > height * maxLean) continue;
    const x = bucket.sumX / bucket.count;
    const z = bucket.sumZ / bucket.count;
    // Seat the collider on the *cleaned* heightfield, not on the mesh's own
    // lowest vertex: a trunk base sampled into a hole would float or sink.
    const groundY = heightAt(x, z);
    trunks.push({ x, z, radius, baseY: groundY, topY: groundY + Math.min(18, Math.max(4.5, height)) });
  }
  return trunks;
}

/**
 * Builds the trunk colliders.
 *
 * One static body per ~24 m tile rather than one per tree: the wheel raycasts
 * test every body's AABB each step, so 500 loose bodies would cost far more than
 * 500 cylinders grouped into a few dozen tiles.
 */
export function buildTrunkBodies(trunks, material, { tileSize = 24 } = {}) {
  const tiles = new Map();
  for (const trunk of trunks) {
    const key = `${Math.floor(trunk.x / tileSize)}:${Math.floor(trunk.z / tileSize)}`;
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key).push(trunk);
  }
  const bodies = [];
  for (const [key, group] of tiles) {
    const body = new CANNON.Body({ mass: 0, material });
    body.type = CANNON.Body.STATIC;
    const centre = { x: 0, z: 0 };
    for (const trunk of group) {
      centre.x += trunk.x / group.length;
      centre.z += trunk.z / group.length;
    }
    for (const trunk of group) {
      const height = Math.max(2, trunk.topY - trunk.baseY);
      const shape = new CANNON.Cylinder(trunk.radius * 0.85, trunk.radius, height, 7);
      // cannon-es cylinders stand along +Y, so only the offset is needed.
      body.addShape(shape, new CANNON.Vec3(trunk.x - centre.x, trunk.baseY + height / 2 - 0.35, trunk.z - centre.z));
    }
    body.position.set(centre.x, 0, centre.z);
    body.name = `trunk-tile:${key}`;
    bodies.push(body);
  }
  return bodies;
}

/**
 * The scene, its terrain payload and its colliders are shared by Forest Dirt
 * Trail and Free Roam: they are the same place with different rules, and a
 * 15 MB scene must not be fetched twice (or build two heightfields).
 */
let sharedAssets = null;
let sharedPromise = null;

async function loadSharedAssets({ quality, onStatus, manifestUrl }) {
  if (sharedAssets) return sharedAssets;
  if (sharedPromise) return sharedPromise;
  sharedPromise = (async () => {
    const [gltf, terrain, manifest] = await Promise.all([
      loadGLTF(MODEL_URL),
      fetch(TERRAIN_URL).then((response) => {
        if (!response.ok) throw new Error(`${TERRAIN_URL} -> HTTP ${response.status}`);
        return response.json();
      }),
      fetch(manifestUrl).then((response) => (response.ok ? response.json() : null)).catch(() => null),
    ]);

    const model = gltf.scene;
    const textureAnisotropy = quality?.anisotropy ?? 4;
    let meshes = 0;
    let triangles = 0;
    model.traverse((object) => {
      if (!object.isMesh && !object.isInstancedMesh) return;
      meshes += 1;
      object.castShadow = true;
      object.receiveShadow = true;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        for (const key of ['map', 'normalMap', 'roughnessMap', 'aoMap']) {
          if (material[key]) material[key].anisotropy = textureAnisotropy;
        }
        // Photogrammetry foliage often ships double-sided alpha; keep it cheap.
        if (material.transparent && material.opacity >= 0.99) material.transparent = false;
      }
      const geometry = object.geometry;
      if (geometry) {
        const position = geometry.getAttribute('position');
        const index = geometry.getIndex();
        const count = index ? index.count : (position?.count ?? 0);
        triangles += (count / 3) * (object.isInstancedMesh ? object.count : 1);
      }
    });
    // The terrain JSON (heights + road path) lives in the pipeline's shifted
    // space: source height + `heightOffset`. The GLB still carries the source
    // heights, so the visual scene is moved into the same space as the collider.
    model.position.y = terrain.heightOffset ?? 0;

    const cleaned = resolveTerrainHeights(terrain);
    const heightAt = createHeightSampler(terrain, cleaned.heights);
    const pathIndexer = createPathIndexer(terrain.path);

    // Trunk colliders: baked by the pipeline when the payload has them, derived
    // from the loaded scene otherwise (the shipped payload predates the bake).
    const baked = Array.isArray(terrain.trunks) && terrain.trunks.length;
    const trunks = baked
      ? terrain.trunks.map(([x, z, radius, baseY]) => ({
        x,
        z,
        radius,
        baseY: heightAt(x, z) - 0.2,
        topY: heightAt(x, z) + Math.max(5, Math.min(16, radius * 12)),
      }))
      : deriveTrunks(model, heightAt);
    // A trunk standing in the middle of the road is a bake artifact, not a tree.
    const corridor = Math.max(MIN_CORRIDOR_HALF_WIDTH, Math.min(MAX_CORRIDOR_HALF_WIDTH, terrain.roadHalfWidth ?? 6));
    const roadClearance = Math.min(4, corridor * 0.35);
    const usable = trunks.filter((trunk) => pathIndexer.nearest(trunk.x, trunk.z).distance > roadClearance);

    // Cap the collider count: the trees nearest the road are the ones worth
    // hitting, and every extra body costs the wheel raycasts an AABB test.
    const MAX_TRUNK_BODIES = 700;
    const colliders = usable.length > MAX_TRUNK_BODIES
      ? usable
        .map((trunk) => ({ trunk, distance: pathIndexer.nearest(trunk.x, trunk.z).distance }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, MAX_TRUNK_BODIES)
        .map((entry) => entry.trunk)
      : usable;

    // One shared scene graph for both modes: Forest Dirt Trail and Free Roam are
    // the same place with different rules, and the model cannot be parented to
    // two groups at once.
    const group = new THREE.Group();
    group.name = 'track:forest';
    group.visible = false;
    group.add(model);

    sharedAssets = {
      group,
      model,
      terrain,
      manifest,
      cleaned,
      heightAt,
      pathIndexer,
      corridor,
      trunks: colliders,
      trunksFound: usable.length,
      trunksFrom: baked ? 'baked' : 'scene',
      references: 0,
      stats: { meshes, triangles: Math.round(triangles) },
    };
    return sharedAssets;
  })().catch((error) => {
    sharedPromise = null;
    throw error;
  });
  return sharedPromise;
}

/** Soft outer limits of the whole heightfield, for Free Roam. Exported for tests. */
export function mapExtent(terrain) {
  return {
    minX: terrain.origin[0] + FREE_ROAM_EDGE_MARGIN,
    maxX: terrain.origin[0] + (terrain.cols - 1) * terrain.cellSize - FREE_ROAM_EDGE_MARGIN,
    minZ: terrain.origin[2] + FREE_ROAM_EDGE_MARGIN,
    maxZ: terrain.origin[2] + (terrain.rows - 1) * terrain.cellSize - FREE_ROAM_EDGE_MARGIN,
  };
}

/**
 * @param {object} options
 * @param {'trail'|'free-roam'} [options.mode]
 */
export async function createForestDirtTrail({
  scene,
  physics,
  quality,
  onStatus = () => {},
  manifestUrl = DEFAULT_MANIFEST_URL,
  mode = 'trail',
}) {
  const freeRoam = mode === 'free-roam';
  const trackId = freeRoam ? FREE_ROAM_ID : TRACK_ID;
  const assets = await loadSharedAssets({ quality, onStatus: (status) => onStatus({ track: trackId, ...status }), manifestUrl });
  const { terrain, cleaned, heightAt, pathIndexer, corridor, trunks } = assets;

  // Both modes share one scene graph (see loadSharedAssets): whichever track is
  // selected makes it visible.
  const group = assets.group;
  if (!group.parent) scene.add(group);
  assets.references += 1;
  // The cleanup report is emitted per track, because the shared load only runs
  // for whichever mode was selected first.
  onStatus({
    track: trackId,
    credits: assets.manifest?.credits ?? null,
    terrain: {
      spikes: cleaned.spikes,
      holes: cleaned.holes,
      sentinelCells: cleaned.sentinelCells,
      steepCells: cleaned.steepCells,
      trunks: trunks.length,
      trunksFound: assets.trunksFound,
      trunksFrom: assets.trunksFrom,
    },
  });

  // Collider: the baked heightfield, cleaned at load. It is only in the physics
  // world while this track is active (see activate/deactivate): at true terrain
  // heights it would otherwise intersect the test circuit, which shares the
  // world origin.
  assets.heightfieldBody ??= buildHeightfieldBody(terrain, physics.roadMaterial ?? physics.groundMaterial);
  assets.trunkBodies ??= buildTrunkBodies(trunks, physics.roadMaterial ?? physics.groundMaterial);
  const heightfieldBody = assets.heightfieldBody;
  const trunkBodies = assets.trunkBodies;

  // The world's flat safety plane sits at y ≈ 0, above most of this terrain
  // (-66 m … +11 m): a car spawned under it gets launched by the plane contact.
  // While the forest is active the plane drops below the lowest terrain point.
  const safetyPlaneY = (terrain.stats?.minHeight ?? -100) - 6;
  let restorePlaneY = null;
  let active = false;
  const movePlane = (y) => {
    const plane = physics.groundBody;
    if (!plane) return;
    plane.position.y = y;
    plane.aabbNeedsUpdate = true;
    plane.updateAABB?.();
    if (physics.world.broadphase) physics.world.broadphase.dirty = true;
  };

  const spawnIndex = pickSpawnIndex(pathIndexer.points, heightAt);
  const spawnPoint = pathIndexer.points[spawnIndex];
  const nextPoint = pathIndexer.points[Math.min(pathIndexer.points.length - 1, spawnIndex + 1)];
  const spawnYaw = Math.atan2(-(nextPoint.x - spawnPoint.x), -(nextPoint.z - spawnPoint.z));
  const extent = mapExtent(terrain);

  const bounds = freeRoam
    ? {
      // Free Roam: the whole map is the track, so "on track" keeps meaning
      // "on the dirt road" (that is what decides the grip modifier) while the
      // driveable area is bounded by the heightfield edge, not the corridor.
      halfWidth: corridor,
      pathIndexer,
      extent,
      freeRoam: true,
      isOnTrack(x, z) {
        return pathIndexer.nearest(x, z).distance <= corridor + 0.5;
      },
      distance(x, z) {
        return pathIndexer.nearest(x, z).distance;
      },
      isInside(x, z) {
        return x >= extent.minX && x <= extent.maxX && z >= extent.minZ && z <= extent.maxZ;
      },
    }
    : {
      halfWidth: corridor,
      pathIndexer,
      freeRoam: false,
      isOnTrack(x, z) {
        return pathIndexer.nearest(x, z).distance <= corridor + 0.5;
      },
      distance(x, z) {
        return pathIndexer.nearest(x, z).distance;
      },
      isInside(x, z) {
        return pathIndexer.nearest(x, z).distance <= corridor + 34;
      },
    };

  let wallForce = 0;
  let wallEvents = 0;

  /**
   * Soft edge for Free Roam: a spring that only starts past the margin and gets
   * progressively firmer, so driving off the end of the map feels like heavy
   * undergrowth rather than a wall.
   */
  function freeRoamEdge(body, deltaTime) {
    const overshoot = Math.max(
      extent.minX - body.position.x,
      body.position.x - extent.maxX,
      extent.minZ - body.position.z,
      body.position.z - extent.maxZ,
    );
    if (overshoot <= 0 || !Number.isFinite(overshoot)) {
      wallForce *= Math.max(0, 1 - deltaTime * 3);
      return;
    }
    const strength = Math.min(1, overshoot / 18);
    const dx = clampToRange(body.position.x, extent.minX, extent.maxX) - body.position.x;
    const dz = clampToRange(body.position.z, extent.minZ, extent.maxZ) - body.position.z;
    const length = Math.hypot(dx, dz) || 1;
    const force = body.mass * 11 * strength;
    body.applyForce(
      new CANNON.Vec3((dx / length) * force, 0, (dz / length) * force),
      new CANNON.Vec3(body.position.x, body.position.y, body.position.z),
    );
    const damping = 1 - Math.min(0.5, strength * 0.8 * deltaTime * 3);
    body.velocity.scale(damping, body.velocity);
    wallForce = strength;
    wallEvents += 1;
  }

  return {
    id: trackId,
    mode,
    name: freeRoam ? 'Forest Free Roam' : 'Forest Dirt Trail',
    subtitle: freeRoam ? 'Whole map, soft outer edge' : 'Loose surface, soft walls',
    surface: SURFACES.dirt,
    group,
    model: assets.model,
    terrain,
    heights: cleaned.heights,
    roadHalfWidth: corridor,
    bounds,
    path: pathIndexer.points,
    spawn: {
      position: { x: spawnPoint.x, y: spawnPoint.y + 0.6, z: spawnPoint.z },
      yaw: spawnYaw,
    },
    physics: { heightfieldBody, trunkBodies },
    spawnIndex,
    /** Bilinear ground height: contact shadow, dust height, camera horizon. */
    groundHeightAt: heightAt,
    /** What the load-time cleanup did to the baked grid (diagnostics / reports). */
    terrainCleaning: {
      spikes: cleaned.spikes,
      holes: cleaned.holes,
      sentinelCells: cleaned.sentinelCells,
      steepCells: cleaned.steepCells,
      trunks: trunks.length,
    },
    stats: {
      meshes: assets.stats.meshes,
      triangles: assets.stats.triangles,
      corridor: Number(corridor.toFixed(2)),
      heightfield: { cols: terrain.cols, rows: terrain.rows, cellSize: terrain.cellSize },
      heightRange: [terrain.stats?.minHeight ?? 0, terrain.stats?.maxHeight ?? 0],
      trunks: trunks.length,
      spikesRemoved: cleaned.spikes,
      holesRemoved: cleaned.holes,
    },
    get wallForce() {
      return wallForce;
    },
    get wallEvents() {
      return wallEvents;
    },
    setVisible(visible) {
      group.visible = visible;
    },
    /** The world ground plane would slice through the hills: the forest hides it. */
    hidesWorldGround: true,
    /** Puts the collider into the physics world (called by the game on select). */
    activate() {
      if (active) return;
      active = true;
      const { world } = physics;
      if (!world.bodies.includes(heightfieldBody)) world.addBody(heightfieldBody);
      for (const body of trunkBodies) {
        if (!world.bodies.includes(body)) world.addBody(body);
      }
      restorePlaneY = physics.groundBody?.position.y ?? null;
      movePlane(safetyPlaneY);
    },
    deactivate() {
      if (!active) return;
      active = false;
      physics.world.removeBody(heightfieldBody);
      for (const body of trunkBodies) physics.world.removeBody(body);
      if (restorePlaneY !== null) movePlane(restorePlaneY);
    },
    get active() {
      return active;
    },
    /**
     * Trail: soft walls past the corridor pull the car back towards the trail and
     * scrub speed — deliberately a spring, not a collision, so brushing a tree
     * line slows you down instead of stopping the car dead.
     *
     * Free Roam: the whole map is in play and the corridor spring is replaced by
     * the soft outer edge at the heightfield boundary.
     */
    update(deltaTime, car) {
      if (!car?.chassisBody) return;
      const body = car.chassisBody;
      if (freeRoam) {
        freeRoamEdge(body, deltaTime);
        return;
      }
      const nearest = pathIndexer.nearest(body.position.x, body.position.z);
      const overshoot = nearest.distance - corridor;
      if (overshoot <= 0 || !Number.isFinite(overshoot)) {
        wallForce *= Math.max(0, 1 - deltaTime * 3);
        return;
      }
      const strength = Math.min(1, overshoot / 4);
      const targetX = pathIndexer.points[nearest.index]?.x ?? body.position.x;
      const targetZ = pathIndexer.points[nearest.index]?.z ?? body.position.z;
      const dx = targetX - body.position.x;
      const dz = targetZ - body.position.z;
      const length = Math.hypot(dx, dz) || 1;
      const force = body.mass * 9 * strength;
      body.applyForce(
        new CANNON.Vec3((dx / length) * force, 0, (dz / length) * force),
        new CANNON.Vec3(body.position.x, body.position.y, body.position.z),
      );
      // Scrub speed proportional to how far past the trail the car has gone.
      const damping = 1 - Math.min(0.55, strength * 0.9 * deltaTime * 3);
      body.velocity.scale(damping, body.velocity);
      wallForce = strength;
      wallEvents += 1;
    },
    dispose() {
      this.deactivate();
      // Shared assets: only the last track to go actually tears the scene down.
      assets.references = Math.max(0, (assets.references ?? 1) - 1);
      if (assets.references > 0) return;
      group.traverse((object) => {
        if (!object.isMesh && !object.isInstancedMesh) return;
        object.geometry?.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          for (const key of ['map', 'normalMap', 'roughnessMap', 'aoMap']) material?.[key]?.dispose?.();
          material?.dispose?.();
        }
      });
      group.removeFromParent();
      sharedAssets = null;
      sharedPromise = null;
    },
  };
}

function clampToRange(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Test/diagnostic helper: forgets the shared scene so it can be rebuilt. */
export function resetForestAssets() {
  sharedAssets = null;
  sharedPromise = null;
}
