/**
 * Terrain analysis shared by the inspection reports and the shipped track data.
 *
 * The forest source is a photogrammetry-style scene, so gameplay data is baked
 * here instead of being guessed at runtime:
 *   - an occupancy grid (lowest ground hit + which material won) used to find
 *     the dirt road and to feed `assets/reports/*.map.txt|png`,
 *   - a road mask + traced centreline that becomes the track bounds / soft
 *     walls of Forest Dirt Trail,
 *   - a height grid the game turns into a cannon-es Heightfield collider.
 */
import { isWheelName } from '../../src/game/cars/names.js';
import { filterHeightOutliers } from '../../src/game/tracks/terrain-grid.js';
import { Buffer } from 'node:buffer';
import sharp from 'sharp';

/**
 * Surfaces the car can actually drive on — the ground.
 *
 * M2.6: this used to be `road|dirt|ground|terrain|soil|mud|gravel|sand|grass|
 * rock|cliff|path|leaves|aerial|forest|tree|trunk|bush|vegetation`, which
 * matched *every* material in the forest scene (its atlas is named
 * `Background_Tree_Atlas`, so "tree" alone matched all 26). Two consequences:
 * nothing was ever skipped by SKIP_PATTERN (which is guarded by
 * `!GROUND_PATTERN.test(label)`), and the heightfield sampled the 105 m tall
 * canopy, the 70k-triangle trunk atlas and standing grass cards as if they were
 * the ground. Taking the *lowest* hit per cell then produced a surface full of
 * trunk-base spikes and canopy holes — the 224 spikes / 223 holes measured on
 * the shipped heightfield, and the reason the car was thrown around the trail.
 *
 * The pattern is now strictly the ground: soil, rock and road surfaces.
 */
export const GROUND_PATTERN = /road|dirt|ground|terrain|soil|mud|gravel|sand|rock|cliff|path|cobble|puddle|trail|earth|stone/i;
/**
 * Anything that grows on, or is placed on, the ground: it must be excluded from
 * the heightfield (it is not a surface you drive on) but trunks are extracted
 * separately as their own colliders — see extractTrunks().
 */
export const VEGETATION_PATTERN = /tree|trunk|canopy|atlas|bush|shrub|grass|vegetation|lea(f|ves)|foliage|fern|aerial|branch|pine|oak|birch|maple|ivy|moss|flower|plant/i;
/** Placed props: fences, logs, signs. Not ground, not trees — just skipped. */
// Word-anchored on purpose: a bare `rail` matched "Dirt_Road_*Trails*" and a
// bare `post` would match "Compost_Heap", quietly deleting road from the grid.
export const PROP_PATTERN = /fence|wire|wood_log|(^|_)log($|_)|sign|(^|_)post($|_)|gate|barrier|(^|_)rail($|_)|stump|lamp|bench/i;
/**
 * Backdrop sheets: the distant terrain/skyline card a scene uses to hide its
 * own edge. It is ground-*coloured* but it is not ground you can drive on — it
 * sits tens of metres below the playable basin and intersects it, which is where
 * the 38 m single-cell steps in the baked heightfield came from. Excluded from
 * the collider; the runtime also slope-limits whatever a stale bake still has.
 */
export const BACKDROP_PATTERN = /terrain_far|far_terrain|distant|skyline|backdrop|horizon|_far$/i;
/** Trunk materials, i.e. the vegetation worth giving a solid collider. */
export const TRUNK_PATTERN = /trunk|_log|wood_log|stump/i;
export const ROAD_PATTERN = /(^|[^a-z])(dirt_road|road|gravel|track|path|cobble)([^a-z]|$)/i;
/**
 * Geometry that must not contribute to the terrain grid. Kept deliberately
 * narrow: the forest scene names its tree atlas `Background_Tree_Atlas`, which
 * is scenery, not a skybox — blanket-matching "background" would delete the
 * very ground the track needs.
 */
export const SKIP_PATTERN = /sky|skybox|cloud|billboard|canopy|fence|wire|light_?ing|water/i;

/**
 * Material classification. Explicit name patterns always win over the alpha
 * heuristic: photogrammetry exports mark foliage and even roads as BLEND, and
 * misreading a dirt road as glass would silently delete the track.
 */
export function classifyMaterial(material, { kind = 'car' } = {}) {
  const name = (material?.getName?.() ?? '').toLowerCase();
  const alpha = material?.getAlphaMode?.() ?? 'OPAQUE';
  if (!name && alpha === 'MASK') return 'cutout';
  if (isWheelName(name)) return 'wheel';
  if (/light|lamp|led|beam|emissive|lum|feu/.test(name)) return 'light';
  if (/interior|seat|cabin|dash|steer|(?:^|[^a-z])int_/.test(name)) return 'interior';
  // Tracks: split the scene into what *is* the ground and what merely stands on
  // it. Only 'terrain' is sampled into the heightfield; 'trunk' becomes its own
  // cylinder collider (extractTrunks); vegetation, props, decals and backdrop
  // sheets are recorded for the report and left out of the collider.
  if (kind === 'track') {
    if (BACKDROP_PATTERN.test(name)) return 'backdrop';
    if (PROP_PATTERN.test(name)) return 'prop';
    if (VEGETATION_PATTERN.test(name)) return TRUNK_PATTERN.test(name) ? 'trunk' : 'vegetation';
    if (ROAD_PATTERN.test(name) || GROUND_PATTERN.test(name)) return 'terrain';
    if (/decal/.test(name)) return 'decal';
    return 'terrain';
  }
  if (GROUND_PATTERN.test(name)) return 'terrain';
  if (/badge|logo|emblem|decal|plate/.test(name)) return 'badge';
  if (/glass|window|wind|transparent|screen|vitres/.test(name)) return 'glass';
  if (/body|paint|shell|exterior|carosserie|primary|carbon/.test(name)) return 'body';
  if (/chrome|metal|trim|grill|bumper|door|hood/.test(name)) return 'trim';
  if (alpha === 'BLEND' && kind === 'car') return 'glass';
  if (alpha === 'MASK') return 'cutout';
  return kind === 'track' ? 'terrain' : 'body';
}

export function squaredDistance(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

export function transformPoint(matrix, point) {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

/** World-space triangle soup with a material index per triangle. */
export function collectTriangles(document, { kind = 'car' } = {}) {
  const triangles = [];
  const materials = [];
  const materialIndex = new Map();

  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const world = node.getWorldMatrix();
    const nodeLabel = `${node.getName()} ${mesh.getName()}`;
    // The guard is the *road*: with the M2.6 ground-only pattern, GROUND_PATTERN
    // no longer matches every node label (the atlas is called
    // `Background_Tree_Atlas`), so SKIP_PATTERN can fire on scenery that shares a
    // node name with something the track needs.
    const skippedNode = SKIP_PATTERN.test(nodeLabel) && !ROAD_PATTERN.test(nodeLabel);

    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      if (!position) continue;
      const material = primitive.getMaterial();
      const materialName = material?.getName?.() ?? '(none)';
      if (!materialIndex.has(materialName)) {
        materialIndex.set(materialName, materials.length);
        materials.push({
          name: materialName,
          class: classifyMaterial(material, { kind }),
          triangles: 0,
          primitives: 0,
          skipped: skippedNode,
        });
      }
      const entry = materials[materialIndex.get(materialName)];
      entry.primitives += 1;
      entry.skipped = entry.skipped || skippedNode;

      const indices = primitive.getIndices();
      const count = indices ? indices.getCount() : position.getCount();
      const read = (index) => transformPoint(world, position.getElement(index, [0, 0, 0]));
      for (let i = 0; i + 2 < count; i += 3) {
        const ia = indices ? indices.getScalar(i) : i;
        const ib = indices ? indices.getScalar(i + 1) : i + 1;
        const ic = indices ? indices.getScalar(i + 2) : i + 2;
        triangles.push({ a: read(ia), b: read(ib), c: read(ic), m: materialIndex.get(materialName) });
        entry.triangles += 1;
      }
    }
  }

  return { triangles, materials };
}

function triangleHeightAt(triangle, x, z) {
  const { a, b, c } = triangle;
  const v0x = b[0] - a[0];
  const v0z = b[2] - a[2];
  const v1x = c[0] - a[0];
  const v1z = c[2] - a[2];
  const det = v0x * v1z - v1x * v0z;
  if (Math.abs(det) < 1e-12) return null;
  const px = x - a[0];
  const pz = z - a[2];
  const u = (px * v1z - v1x * pz) / det;
  const v = (v0x * pz - px * v0z) / det;
  if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) return null;
  return a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]);
}

/**
 * Samples the scene on an XZ grid. For every cell we keep the lowest and the
 * highest ground hit; the lowest is the terrain itself (foliage sits above it).
 */
export function buildTerrainGrid({ triangles, materials, bounds, cellSize = 2, maxCells = 320 }) {
  const min = bounds.min;
  const max = bounds.max;
  const spanX = max[0] - min[0];
  const spanZ = max[2] - min[2];
  let step = Math.max(cellSize, Math.max(spanX, spanZ) / maxCells);
  const cols = Math.max(8, Math.ceil(spanX / step));
  const rows = Math.max(8, Math.ceil(spanZ / step));

  const buckets = new Map();
  const key = (ix, iz) => ix * 100003 + iz;
  const MAX_CELLS_PER_TRIANGLE = 4096;

  const insert = (index, tri, depth) => {
    const x0 = Math.min(tri.a[0], tri.b[0], tri.c[0]);
    const x1 = Math.max(tri.a[0], tri.b[0], tri.c[0]);
    const z0 = Math.min(tri.a[2], tri.b[2], tri.c[2]);
    const z1 = Math.max(tri.a[2], tri.b[2], tri.c[2]);
    const ix0 = Math.max(0, Math.floor((x0 - min[0]) / step));
    const ix1 = Math.min(cols - 1, Math.floor((x1 - min[0]) / step));
    const iz0 = Math.max(0, Math.floor((z0 - min[2]) / step));
    const iz1 = Math.min(rows - 1, Math.floor((z1 - min[2]) / step));
    if (ix1 < ix0 || iz1 < iz0) return;
    if ((ix1 - ix0 + 1) * (iz1 - iz0 + 1) > MAX_CELLS_PER_TRIANGLE) {
      // Ground planes can be a single enormous quad; split it instead of
      // dropping it, otherwise the terrain grid would lose the ground.
      if (depth >= 12) return;
      const edges = [
        { from: tri.a, to: tri.b, length: squaredDistance(tri.a, tri.b) },
        { from: tri.b, to: tri.c, length: squaredDistance(tri.b, tri.c) },
        { from: tri.c, to: tri.a, length: squaredDistance(tri.c, tri.a) },
      ].sort((left, right) => right.length - left.length);
      const [first, second] = edges;
      const midpoint = [0, 1, 2].map((axis) => (first.from[axis] + first.to[axis]) / 2);
      const opposite = [tri.a, tri.b, tri.c].find((corner) => corner !== first.from && corner !== first.to);
      insert(index, { a: first.from, b: midpoint, c: opposite, m: tri.m }, depth + 1);
      insert(index, { a: midpoint, b: first.to, c: opposite, m: tri.m }, depth + 1);
      void second;
      return;
    }
    for (let ix = ix0; ix <= ix1; ix += 1) {
      for (let iz = iz0; iz <= iz1; iz += 1) {
        const cellKey = key(ix, iz);
        const bucket = buckets.get(cellKey);
        if (bucket) bucket.push(index);
        else buckets.set(cellKey, [index]);
      }
    }
  };

  // Only ground-class triangles contribute. Trunks, canopy, grass cards, leaf
  // litter, fences and logs are recorded (they are needed for the trunk
  // colliders and the reports) but never sampled as a driveable surface.
  let groundTriangles = 0;
  for (let index = 0; index < triangles.length; index += 1) {
    const tri = triangles[index];
    const material = materials[tri.m];
    if (!material || material.skipped || material.class !== 'terrain') continue;
    groundTriangles += 1;
    insert(index, tri, 0);
  }

  const low = new Float64Array(cols * rows).fill(Number.NaN);
  const high = new Float64Array(cols * rows).fill(Number.NaN);
  const materialGrid = new Int16Array(cols * rows).fill(-1);
  const roadGrid = new Uint8Array(cols * rows);

  for (let iz = 0; iz < rows; iz += 1) {
    const z = min[2] + (iz + 0.5) * step;
    for (let ix = 0; ix < cols; ix += 1) {
      const x = min[0] + (ix + 0.5) * step;
      const bucket = buckets.get(key(ix, iz));
      if (!bucket) continue;
      let lowest = Infinity;
      let highest = -Infinity;
      let lowestMaterial = -1;
      let roadLow = Infinity;
      let roadMaterial = -1;
      for (const index of bucket) {
        const tri = triangles[index];
        const material = materials[tri.m];
        if (material.class !== 'terrain') continue;
        const y = triangleHeightAt(tri, x, z);
        if (y === null) continue;
        if (y < lowest) {
          lowest = y;
          lowestMaterial = tri.m;
        }
        if (y > highest) highest = y;
        // The dirt road is the surface the car actually drives on; where it
        // covers a cell it wins over whatever ground mesh sits underneath.
        if (ROAD_PATTERN.test(material.name) && y < roadLow) {
          roadLow = y;
          roadMaterial = tri.m;
        }
      }
      const cell = iz * cols + ix;
      if (roadMaterial >= 0) {
        low[cell] = roadLow;
        high[cell] = Math.max(highest, roadLow);
        materialGrid[cell] = roadMaterial;
        roadGrid[cell] = 1;
      } else if (lowestMaterial >= 0) {
        low[cell] = lowest;
        high[cell] = Math.max(highest, lowest);
        materialGrid[cell] = lowestMaterial;
      }
    }
  }

  return {
    min: [min[0], min[2]],
    cellSize: step,
    cols,
    rows,
    low,
    high,
    materialGrid,
    roadGrid,
    materials,
    groundTriangles,
    /** Material names that were allowed to define the ground (for the report). */
    groundMaterials: materials.filter((entry) => entry.class === 'terrain').map((entry) => entry.name),
    excludedMaterials: materials.filter((entry) => entry.class !== 'terrain').map((entry) => `${entry.name} [${entry.class}]`),
  };
}

// The heightfield cleaner lives with the runtime (src/game/tracks/terrain-grid.js)
// and is re-exported here: the pipeline and the game must apply exactly the same
// filter, or a cell one side keeps and the other removes becomes a ramp or a pit.
export { filterHeightOutliers } from '../../src/game/tracks/terrain-grid.js';

/**
 * Fills holes so the grid can be used as a heightfield collider.
 *
 * Neighbour propagation alone cannot reach a corner that is cut off from the
 * sampled region, and `serializeTrail` used to write those cells as a bare 0 —
 * which, after the height offset, became a 96 m pit at the map corner and
 * launched anything that rolled into it. A final global pass therefore fills
 * whatever is left from the median of the finite cells, so the payload never
 * contains a sentinel.
 *
 * @returns {{values: Float64Array, holes: number, unreachable: number}}
 */
export function fillHoles(grid, { maxIterations = 64 } = {}) {
  const { cols, rows, low } = grid;
  const filled = Float64Array.from(low);
  const holes = [...low].filter((value) => !Number.isFinite(value)).length;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let patched = 0;
    for (let iz = 0; iz < rows; iz += 1) {
      for (let ix = 0; ix < cols; ix += 1) {
        const cell = iz * cols + ix;
        if (Number.isFinite(filled[cell])) continue;
        let sum = 0;
        let count = 0;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = ix + dx;
          const nz = iz + dz;
          if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
          const value = filled[nz * cols + nx];
          if (Number.isFinite(value)) {
            sum += value;
            count += 1;
          }
        }
        if (count) {
          filled[cell] = sum / count;
          patched += 1;
        }
      }
    }
    if (!patched) break;
  }

  // Anything still unfilled is unreachable from the sampled region (a grid
  // corner outside the source geometry): give it the scene's median height so
  // it is flat and boring rather than a pit.
  let unreachable = 0;
  const finite = [...filled].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const median = finite.length ? finite[Math.floor(finite.length / 2)] : 0;
  for (let index = 0; index < filled.length; index += 1) {
    if (Number.isFinite(filled[index])) continue;
    filled[index] = median;
    unreachable += 1;
  }

  return { values: filled, holes, unreachable };
}

/**
 * Finds the trees.
 *
 * The trunk atlas is a single merged primitive covering every trunk in the
 * scene, so trunks are recovered by clustering their triangle centroids on a
 * coarse XZ grid: a cluster that is tall and narrow is a trunk, a cluster that
 * is wide or short is a branch fan, a root flare or a bush. Each survivor
 * becomes a cylinder collider in the game (see tracks/forest-trail.js), which
 * is what makes hitting a tree stop the car instead of letting it drive through
 * the forest.
 *
 * @returns {Array<[number, number, number, number]>} `[x, z, radius, baseY]`
 */
export function extractTrunks({ triangles, materials, min: origin }, {
  cellSize = 2.4,
  minHeight = 3.2,
  minRadius = 0.14,
  maxRadius = 1.5,
  maxLean = 0.55,
} = {}) {
  const buckets = new Map();
  for (const tri of triangles) {
    const material = materials[tri.m];
    if (!material || material.skipped || material.class !== 'trunk') continue;
    for (const corner of [tri.a, tri.b, tri.c]) {
      const ix = Math.floor((corner[0] - origin[0]) / cellSize);
      const iz = Math.floor((corner[2] - origin[1]) / cellSize);
      const key = `${ix}:${iz}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { ix, iz, count: 0, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, minY: Infinity, maxY: -Infinity, sumX: 0, sumZ: 0 };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      bucket.minX = Math.min(bucket.minX, corner[0]);
      bucket.maxX = Math.max(bucket.maxX, corner[0]);
      bucket.minZ = Math.min(bucket.minZ, corner[2]);
      bucket.maxZ = Math.max(bucket.maxZ, corner[2]);
      bucket.minY = Math.min(bucket.minY, corner[1]);
      bucket.maxY = Math.max(bucket.maxY, corner[1]);
      bucket.sumX += corner[0];
      bucket.sumZ += corner[2];
    }
  }

  const trunks = [];
  for (const bucket of buckets.values()) {
    if (bucket.count < 24) continue;
    const width = bucket.maxX - bucket.minX;
    const depth = bucket.maxZ - bucket.minZ;
    const height = bucket.maxY - bucket.minY;
    const radius = Math.max(width, depth) / 2;
    if (height < minHeight) continue;
    if (radius < minRadius || radius > maxRadius) continue;
    // A trunk is roughly vertical: if its footprint is much wider than it is
    // across at the base it is a branch fan or two merged trees, not a collider.
    if (Math.min(width, depth) > height * maxLean) continue;
    trunks.push([
      Number((bucket.sumX / bucket.count).toFixed(2)),
      Number((bucket.sumZ / bucket.count).toFixed(2)),
      Number(Math.max(minRadius, radius).toFixed(2)),
      Number(bucket.minY.toFixed(2)),
    ]);
  }
  return trunks;
}

/**
 * Traces a centreline through the road mask, walking row by row away from the
 * widest road row so S-bends are followed instead of averaged.
 */
export function extractRoadPath(grid, { smooth = 3 } = {}) {
  const { cols, rows, cellSize, min, low } = grid;
  const runsPerRow = [];
  for (let iz = 0; iz < rows; iz += 1) {
    const runs = [];
    let start = -1;
    for (let ix = 0; ix < cols; ix += 1) {
      const isRoad = grid.roadGrid[iz * cols + ix] === 1;
      if (isRoad && start === -1) start = ix;
      if ((!isRoad || ix === cols - 1) && start !== -1) {
        const end = isRoad && ix === cols - 1 ? ix : ix - 1;
        runs.push({ start, end });
        start = -1;
      }
    }
    runsPerRow.push(runs);
  }

  let widest = { index: -1, width: 0 };
  runsPerRow.forEach((runs, index) => {
    for (const run of runs) {
      const width = run.end - run.start + 1;
      if (width > widest.width) widest = { index, width, row: index };
    }
  });
  if (widest.index === -1) return { path: [], roadHalfWidth: 0, coverage: 0 };

  const centreForRow = (index, hint) => {
    const runs = runsPerRow[index];
    if (!runs.length) return null;
    let best = runs[0];
    let bestDistance = Infinity;
    for (const run of runs) {
      const centre = (run.start + run.end + 1) / 2;
      const distance = hint === null ? Math.abs(centre - cols / 2) : Math.abs(centre - hint);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = run;
      }
    }
    return { centre: (best.start + best.end + 1) / 2, width: best.end - best.start + 1 };
  };

  const centres = new Array(rows).fill(null);
  let hint = null;
  for (let iz = widest.index; iz >= 0; iz -= 1) {
    const found = centreForRow(iz, hint);
    if (!found) continue;
    centres[iz] = found;
    hint = found.centre;
  }
  hint = null;
  for (let iz = widest.index; iz < rows; iz += 1) {
    const found = centreForRow(iz, hint);
    if (!found) continue;
    centres[iz] = found;
    hint = found.centre;
  }

  const path = [];
  let widthSum = 0;
  let widthCount = 0;
  for (let iz = 0; iz < rows; iz += 1) {
    const found = centres[iz];
    if (!found) {
      if (path.length) path.push(null);
      continue;
    }
    if (found) {
      widthSum += found.width;
      widthCount += 1;
    }
    const x = min[0] + found.centre * cellSize;
    const z = min[1] + (iz + 0.5) * cellSize;
    const cell = iz * cols + Math.min(cols - 1, Math.max(0, Math.round(found.centre - 0.5)));
    const y = low[cell];
    path.push([x, Number.isFinite(y) ? y : null, z]);
  }

  // Smooth Y and drop the gap markers, then decimate to ~1 point / 3 cells.
  const points = path.filter(Boolean);
  const smoothed = points.map((point, index) => {
    const slice = points.slice(Math.max(0, index - smooth), index + smooth + 1);
    const validY = slice.map((entry) => entry[1]).filter((value) => Number.isFinite(value));
    const y = validY.length ? validY.reduce((sum, value) => sum + value, 0) / validY.length : 0;
    return [point[0], y, point[2]];
  });
  // One centreline point per grid cell (~2 m) keeps the soft walls smooth
  // through tight bends without a huge payload.
  const decimated = smoothed;

  const roadCells = grid.roadGrid.reduce((sum, value) => sum + value, 0);
  return {
    path: decimated,
    roadHalfWidth: widthCount ? (widthSum / widthCount / 2) * cellSize : 0,
    coverage: roadCells / (cols * rows),
    roadCells,
  };
}

/** Renders the roadmap as ASCII + PNG for review. */
export async function writeOccupancyArtifacts(grid, { asciiPath, pngPath, label, path = [] }) {
  const { cols, rows, materialGrid, roadGrid, low, materials } = grid;
  const usage = new Map();
  for (const value of materialGrid) usage.set(value, (usage.get(value) ?? 0) + 1);
  const ordered = [...usage.entries()].filter(([value]) => value >= 0).sort((a, b) => b[1] - a[1]).map(([value]) => value);
  const glyphs = '#*+oxABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@%&=?!';
  const legend = new Map();
  ordered.forEach((value, index) => legend.set(value, glyphs[index] ?? '.'));

  const roadCells = new Set();
  for (let iz = 0; iz < rows; iz += 1) {
    for (let ix = 0; ix < cols; ix += 1) {
      if (roadGrid[iz * cols + ix] === 1) roadCells.add(`${iz}:${ix}`);
    }
  }
  const pathCells = new Map();
  path.forEach((point) => {
    if (!point) return;
    const ix = Math.floor((point[0] - grid.min[0]) / grid.cellSize);
    const iz = Math.floor((point[2] - grid.min[1]) / grid.cellSize);
    pathCells.set(`${iz}:${ix}`, '•');
  });

  const asciiRows = [];
  for (let iz = rows - 1; iz >= 0; iz -= 1) {
    let line = '';
    for (let ix = 0; ix < cols; ix += 1) {
      const cellKey = `${iz}:${ix}`;
      if (pathCells.has(cellKey)) line += '•';
      else if (roadCells.has(cellKey)) line += '=';
      else if (materialGrid[iz * cols + ix] >= 0) line += legend.get(materialGrid[iz * cols + ix]) ?? '.';
      else line += ' ';
    }
    asciiRows.push(line);
  }

  const heights = [...low].filter((value) => Number.isFinite(value));
  const header = [
    `# ${label} occupancy map (cell ${grid.cellSize.toFixed(2)} m, ${cols}x${rows})`,
    `# x: ${grid.min[0].toFixed(2)} .. ${(grid.min[0] + cols * grid.cellSize).toFixed(2)}   z: ${grid.min[1].toFixed(2)} .. ${(grid.min[1] + rows * grid.cellSize).toFixed(2)}`,
    `# ground height: ${heights.length ? Math.min(...heights).toFixed(2) : 'n/a'} .. ${heights.length ? Math.max(...heights).toFixed(2) : 'n/a'}`,
    `# legend: "=" road material, "•" traced centreline`,
    ...ordered.map((value, index) => `#   ${glyphs[index]}  ${materials[value]?.name ?? '(none)'} [${materials[value]?.class ?? '?'}] cells=${usage.get(value)} tris=${materials[value]?.triangles ?? 0}`),
    '# rows are printed +Z (top) -> -Z (bottom), columns -X -> +X',
    ...asciiRows,
  ];
  if (asciiPath) await (await import('node:fs/promises')).writeFile(asciiPath, `${header.join('\n')}\n`);

  if (pngPath) {
    const palette = ordered.map((value, index) => {
      const material = materials[value];
      if (material && ROAD_PATTERN.test(material.name)) return [196, 140, 84];
      const colors = [[92, 138, 74], [86, 96, 104], [128, 190, 220], [180, 96, 88], [214, 200, 120], [140, 110, 190], [90, 200, 150]];
      return colors[index % colors.length];
    });
    const buffer = Buffer.alloc(cols * rows * 4);
    for (let iz = 0; iz < rows; iz += 1) {
      for (let ix = 0; ix < cols; ix += 1) {
        const cell = iz * cols + ix;
        const value = materialGrid[cell];
        const index = ordered.indexOf(value);
        let color = index === -1 ? [14, 18, 20] : palette[index];
        if (roadGrid[cell] === 1) color = [188, 132, 76];
        if (pathCells.has(`${iz}:${ix}`)) color = [255, 220, 120];
        const offset = ((rows - 1 - iz) * cols + ix) * 4;
        buffer[offset] = color[0];
        buffer[offset + 1] = color[1];
        buffer[offset + 2] = color[2];
        buffer[offset + 3] = 255;
      }
    }
    await sharp(buffer, { raw: { width: cols, height: rows, channels: 4 } }).png().toFile(pngPath);
  }

  return { legend: ordered.map((value, index) => ({ glyph: glyphs[index], material: materials[value]?.name, cells: usage.get(value) })) };
}

/** Compact JSON payload the game reads to build the heightfield + soft walls. */
export function serializeTrail(grid, { path, roadHalfWidth, id, heightOffset = 0, trunks = [] }) {
  const { values: filled, holes, unreachable } = fillHoles(grid);
  // Single-cell spikes and holes are removed *before* encoding: the runtime
  // builds a cannon-es Heightfield straight from this payload, so a bad cell is
  // a physical ramp or pit under the car, not a visual glitch.
  const cleaned = filterHeightOutliers(filled, grid.cols, grid.rows);
  const heights = new Int16Array(grid.cols * grid.rows);
  for (let index = 0; index < cleaned.values.length; index += 1) {
    const value = (Number.isFinite(cleaned.values[index]) ? cleaned.values[index] : 0) + heightOffset;
    heights[index] = Math.max(-32000, Math.min(32000, Math.round(value * 100)));
  }
  // Base64 keeps the payload small; the game decodes into Int16 centimetres.
  const encoded = Buffer.from(heights.buffer, heights.byteOffset, heights.byteLength).toString('base64');

  let min = Infinity;
  let max = -Infinity;
  for (const value of cleaned.values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  return {
    id,
    cellSize: Number(grid.cellSize.toFixed(4)),
    cols: grid.cols,
    rows: grid.rows,
    origin: [Number(grid.min[0].toFixed(3)), 0, Number(grid.min[1].toFixed(3))],
    heightEncoding: 'int16-centimeters',
    heights: encoded,
    heightOffset: Number(heightOffset.toFixed(3)),
    roadHalfWidth: Number(roadHalfWidth.toFixed(3)),
    // The centreline lives in the same shifted space as `heights` so the game
    // can feed both straight into physics without extra arithmetic.
    path: path.filter(Boolean).map((point) => [
      Number(point[0].toFixed(3)),
      Number((point[1] + heightOffset).toFixed(3)),
      Number(point[2].toFixed(3)),
    ]),
    /**
     * Tree-trunk colliders as `[x, z, radius, baseY]`, in the same shifted
     * space. The game turns each into a cylinder body, so a tree stops the car
     * instead of the car driving through it (see tracks/forest-trail.js).
     */
    trunks: (trunks ?? []).map(([x, z, radius, baseY]) => [
      Number(x.toFixed(2)),
      Number(z.toFixed(2)),
      Number(radius.toFixed(2)),
      Number((baseY + heightOffset).toFixed(2)),
    ]),
    /** Which materials were allowed to define the ground (the M2.6 fix). */
    groundMaterials: grid.groundMaterials ?? [],
    excludedMaterials: grid.excludedMaterials ?? [],
    stats: {
      minHeight: Number(((Number.isFinite(min) ? min : 0) + heightOffset).toFixed(3)),
      maxHeight: Number(((Number.isFinite(max) ? max : 0) + heightOffset).toFixed(3)),
      groundTriangles: grid.groundTriangles ?? 0,
      /** Cells the outlier filter corrected, and cells it found on the first pass. */
      spikes: cleaned.spikes,
      holes: cleaned.holes,
      /** Cells with no ground hit at all, filled by neighbour propagation. */
      filled: holes,
      /** Cells too far from any hit to propagate to, filled with the median. */
      unreachable,
      trunks: (trunks ?? []).length,
    },
  };
}
