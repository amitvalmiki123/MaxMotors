import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { loadGLTF } from '../cars/loader.js';
import { SURFACES } from '../surfaces.js';

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
 */

const TRACK_ID = 'forest-dirt-trail';
const MODEL_URL = '/tracks/forest-dirt-trail.glb';
const TERRAIN_URL = '/tracks/forest-dirt-trail.terrain.json';
const DEFAULT_MANIFEST_URL = '/tracks/forest-dirt-trail.manifest.json';

/** Corridor half-width used for the soft walls (clamped: the real road is wide). */
const MAX_CORRIDOR_HALF_WIDTH = 9.5;
const MIN_CORRIDOR_HALF_WIDTH = 4.5;
const WALL_MARGIN = 2.5;

export function decodeHeights(encoded, expectedLength) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const view = new Int16Array(bytes.buffer, bytes.byteOffset, Math.min(expectedLength, bytes.length / 2));
  const heights = new Float32Array(expectedLength);
  for (let index = 0; index < heights.length; index += 1) heights[index] = (view[index] ?? 0) / 100;
  return heights;
}

export function buildHeightfieldBody(terrain, material) {
  const { cols, rows, cellSize, origin, heightOffset } = terrain;
  // `terrain.heights` is the base64 payload from the JSON. It used to be indexed
  // as-is, which filled the heightfield with single characters ('A', '/', …):
  // every raycast missed and the wheels never touched the trail.
  const heights = typeof terrain.heights === 'string'
    ? decodeHeights(terrain.heights, cols * rows)
    : terrain.heights;
  // cannon's Heightfield lives in the local X/Y plane with heights along +Z, and
  // data[i][j] maps to (x = i, y = j). Rotating the body -90° about X turns local
  // +Z into world +Y and local +Y into world -Z, so rows are flipped here.
  const matrix = [];
  for (let i = 0; i < cols; i += 1) {
    const column = new Array(rows);
    for (let j = 0; j < rows; j += 1) {
      const zIndex = rows - 1 - j;
      column[j] = heights[zIndex * cols + i];
    }
    matrix.push(column);
  }

  const shape = new CANNON.Heightfield(matrix, { elementSize: cellSize });
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

export async function createForestDirtTrail({ scene, physics, quality, onStatus = () => {}, manifestUrl = DEFAULT_MANIFEST_URL }) {
  const group = new THREE.Group();
  group.name = `track:${TRACK_ID}`;
  group.visible = false;
  scene.add(group);

  const [gltf, terrain, manifest] = await Promise.all([
    loadGLTF(MODEL_URL),
    fetch(TERRAIN_URL).then((response) => {
      if (!response.ok) throw new Error(`${TERRAIN_URL} -> HTTP ${response.status}`);
      return response.json();
    }),
    fetch(manifestUrl).then((response) => (response.ok ? response.json() : null)).catch(() => null),
  ]);

  onStatus({
    track: TRACK_ID,
    credits: manifest?.credits ?? null,
  });

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
  group.add(model);

  // Collider: the baked heightfield. It is only in the physics world while this
  // track is active (see activate/deactivate): at true terrain heights it would
  // otherwise intersect the test circuit, which shares the world origin.
  const heightfieldBody = buildHeightfieldBody(terrain, physics.roadMaterial ?? physics.groundMaterial);
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

  const heights = decodeHeights(terrain.heights, terrain.cols * terrain.rows);
  const pathIndexer = createPathIndexer(terrain.path);
  const corridor = Math.max(MIN_CORRIDOR_HALF_WIDTH, Math.min(MAX_CORRIDOR_HALF_WIDTH, terrain.roadHalfWidth ?? 6));

  const spawnPoint = pathIndexer.points[0];
  const spawnDirection = pathIndexer.nearest(spawnPoint.x, spawnPoint.z).direction;
  const spawnYaw = Math.atan2(-spawnDirection.x, -spawnDirection.z);

  const bounds = {
    halfWidth: corridor,
    pathIndexer,
    isOnTrack(x, z) {
      return pathIndexer.nearest(x, z).distance <= corridor + 0.5;
    },
    distance(x, z) {
      return pathIndexer.nearest(x, z).distance;
    },
  };

  let wallForce = 0;
  let wallEvents = 0;

  return {
    id: TRACK_ID,
    name: 'Forest Dirt Trail',
    subtitle: 'Loose surface, soft walls',
    surface: SURFACES.dirt,
    group,
    model,
    terrain,
    heights,
    roadHalfWidth: corridor,
    bounds,
    path: pathIndexer.points,
    spawn: {
      position: { x: spawnPoint.x, y: spawnPoint.y + 0.6, z: spawnPoint.z },
      yaw: spawnYaw,
    },
    physics: { heightfieldBody },
    /** Bilinear ground height, used for the contact shadow and dust height. */
    groundHeightAt(x, z) {
      const { cols, rows, cellSize, origin } = terrain;
      const fx = (x - origin[0]) / cellSize;
      const fz = (z - origin[2]) / cellSize;
      const ix = Math.max(0, Math.min(cols - 2, Math.floor(fx)));
      const iz = Math.max(0, Math.min(rows - 2, Math.floor(fz)));
      const tx = Math.max(0, Math.min(1, fx - ix));
      const tz = Math.max(0, Math.min(1, fz - iz));
      const at = (cx, cz) => heights[Math.max(0, Math.min(rows - 1, cz)) * cols + Math.max(0, Math.min(cols - 1, cx))];
      const top = at(ix, iz) * (1 - tx) + at(ix + 1, iz) * tx;
      const bottom = at(ix, iz + 1) * (1 - tx) + at(ix + 1, iz + 1) * tx;
      return top * (1 - tz) + bottom * tz;
    },
    stats: {
      meshes,
      triangles: Math.round(triangles),
      corridor: Number(corridor.toFixed(2)),
      heightfield: { cols: terrain.cols, rows: terrain.rows, cellSize: terrain.cellSize },
      heightRange: [terrain.stats?.minHeight ?? 0, terrain.stats?.maxHeight ?? 0],
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
      physics.world.addBody(heightfieldBody);
      restorePlaneY = physics.groundBody?.position.y ?? null;
      movePlane(safetyPlaneY);
    },
    deactivate() {
      if (!active) return;
      active = false;
      physics.world.removeBody(heightfieldBody);
      if (restorePlaneY !== null) movePlane(restorePlaneY);
    },
    get active() {
      return active;
    },
    /**
     * Soft walls: past the corridor the car is pulled back towards the trail and
     * scrubbed of speed. Deliberately a spring, not a collision, so brushing a
     * tree line slows you down instead of stopping the car dead.
     */
    update(deltaTime, car) {
      if (!car?.chassisBody) return;
      const body = car.chassisBody;
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
    },
  };
}
