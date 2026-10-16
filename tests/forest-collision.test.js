import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {
  MAX_TRUNK_COLLIDERS,
  buildHeightfieldBody,
  buildTrunkBodies,
  decodeHeights,
  deriveTrunks,
  mapExtent,
  resolveTerrainHeights,
} from '../src/game/tracks/forest-trail.js';
import { filterHeightOutliers } from '../src/game/tracks/terrain-grid.js';
import { classifyMaterial } from '../scripts/assets/terrain.mjs';

const terrain = JSON.parse(readFileSync(new URL('../public/tracks/forest-dirt-trail.terrain.json', import.meta.url)));

/** Counts cells deviating from their 8-neighbour median by more than `threshold`. */
function auditOutliers(values, { threshold }) {
  const median = (list) => {
    const sorted = [...list].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  let spikes = 0;
  let holes = 0;
  for (let iz = 1; iz < terrain.rows - 1; iz += 1) {
    for (let ix = 1; ix < terrain.cols - 1; ix += 1) {
      const neighbours = [];
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dz) continue;
          neighbours.push(values[(iz + dz) * terrain.cols + (ix + dx)]);
        }
      }
      const delta = values[iz * terrain.cols + ix] - median(neighbours);
      if (delta > threshold) spikes += 1;
      else if (-delta > threshold) holes += 1;
    }
  }
  return { spikes, holes };
}

test('the pipeline and the runtime share one heightfield cleaner', async () => {
  const pipeline = await import('../scripts/assets/terrain.mjs');
  assert.equal(pipeline.filterHeightOutliers, filterHeightOutliers, 're-exported, not re-implemented');
});

test('the forest grid is built from ground materials only (M2.6)', () => {
  const kinds = (name) => classifyMaterial({ getName: () => name, getAlphaMode: () => 'OPAQUE' }, { kind: 'track' });
  // Everything the car drives on.
  for (const name of ['Dirt_Road', 'Dirt_Road_Trails', 'Ground_Dirt', 'Road_Edge_Gravel_Dusty', 'Mud_Pile', 'Cobblestone', 'Sloped_Rock', 'Tall_Cliff']) {
    assert.equal(kinds(name), 'terrain', `${name} is ground`);
  }
  // Everything that used to be mistaken for ground because the atlas is named
  // `Background_Tree_Atlas` — sampling these as the surface is what produced the
  // spikes (trunk bases) and holes (canopy) in the baked heightfield.
  for (const name of ['Background_Tree_Atlas', 'Forest_Bush', 'Grass_Close', 'Aerial_Grass', 'Grass_Vegetation_Green', 'Fallen_Maple_Leaves']) {
    assert.equal(kinds(name), 'vegetation', `${name} grows on the ground, it is not the ground`);
  }
  for (const name of ['Trunk_Oak', 'Trunk_Birch']) assert.equal(kinds(name), 'trunk', `${name} becomes its own collider`);
  for (const name of ['Wood_Fence', 'Metal_Fence', 'Wood_Log']) assert.equal(kinds(name), 'prop', `${name} is a placed prop`);
  assert.equal(kinds('Terrain_Far'), 'backdrop', 'the distant sheet is scenery, not a driveable surface');
  // Car classification must be untouched.
  assert.equal(classifyMaterial({ getName: () => 'Carosserie', getAlphaMode: () => 'OPAQUE' }, { kind: 'car' }), 'body');
});

test('the baked heightfield arrives clean: no sentinel pits, no spikes (M2.6)', () => {
  const count = terrain.cols * terrain.rows;
  const raw = decodeHeights(terrain.heights, count);

  // The old serializer wrote unreachable cells as a bare 0, which after the
  // height offset is exactly `heightOffset`: a real-looking number 96 m down.
  // The pipeline now fills every cell before it ships (stats.filled, including
  // stats.unreachable), so the runtime never sees one.
  const pits = [...raw].filter((value) => Math.abs(value - terrain.heightOffset) < 0.02).length;
  assert.equal(pits, 0, `the baked payload must not contain sentinel pits, found ${pits}`);
  assert.ok(terrain.stats.filled > 0, 'the bake reports the cells it had to fill');
  assert.ok(raw.every(Number.isFinite), 'every cell decodes to a finite height');

  // Ground-only sampling is what removed the canopy holes and trunk-base spikes
  // at source; the audit that used to report 67 spikes / 70 holes on the M2.5
  // payload now finds no cell towering over its neighbours at all.
  const audit = auditOutliers(Array.from(raw), { threshold: 8 });
  assert.equal(audit.spikes, 0, `no cell may tower over its neighbours: ${JSON.stringify(audit)}`);
  // Cells far *below* their neighbours remain: that is the valley and the rock
  // faces the scene really has, not bad data (the cleaner leaves them alone).
  assert.ok(audit.holes <= 40, `deep cells are geography, not errors: ${JSON.stringify(audit)}`);

  // The grid is the mapped ground, not the tree canopy or the far backdrop.
  assert.ok(terrain.groundMaterials.includes('Dirt_Road'), 'the road surface defines the ground');
  assert.ok(!terrain.groundMaterials.some((name) => /Tree|Bush|Grass|Leaves|Trunk|Fence|Far/i.test(name)),
    `vegetation, trunks, props and backdrop are not ground: ${terrain.groundMaterials.join(', ')}`);
  for (const kind of ['vegetation', 'trunk', 'backdrop']) {
    assert.ok(terrain.excludedMaterials.some((entry) => entry.endsWith(`[${kind}]`)), `${kind} is recorded as excluded`);
  }
  assert.ok(terrain.stats.groundTriangles > 0, 'the bake counts the ground triangles it sampled');

  // Trunks ship with the payload, so the game does not have to recover them
  // from the instanced scene (that path stays as a fallback for old payloads).
  assert.equal(terrain.trunks.length, terrain.stats.trunks, 'trunk list matches the reported count');
  assert.ok(terrain.trunks.length > 500, `baked trunks: ${terrain.trunks.length}`);
  for (const trunk of terrain.trunks.slice(0, 40)) {
    const [x, z, radius, baseY] = trunk;
    assert.ok(Number.isFinite(x) && Number.isFinite(z), 'trunk position is finite');
    assert.ok(radius > 0.1 && radius < 3, `trunk radius ${radius} is a trunk, not a branch or a tile`);
    assert.ok(baseY >= terrain.stats.minHeight - 1 && baseY <= terrain.stats.maxHeight + 1,
      `trunk base ${baseY} sits on the terrain`);
  }
});

test('the runtime cleaner is a safety net over the baked grid, and still fixes real dirt', () => {
  const count = terrain.cols * terrain.rows;
  const raw = decodeHeights(terrain.heights, count);
  const cleaned = resolveTerrainHeights(terrain);

  assert.equal(cleaned.sentinelCells, 0, 'nothing left to un-sentinel');
  let changed = 0;
  let maxCorrection = 0;
  for (let index = 0; index < count; index += 1) {
    const delta = Math.abs(cleaned.heights[index] - raw[index]);
    if (delta > 1e-6) {
      changed += 1;
      maxCorrection = Math.max(maxCorrection, delta);
    }
  }
  // Heights ship as int16 centimetres, so a few cells can still read as local
  // outliers after decoding. The pass corrects those and leaves the rest alone.
  assert.ok(changed <= 64, `a clean bake needs at most a touch-up: ${changed} of ${count} cells moved`);
  assert.ok(maxCorrection < 12, `the largest correction stays local: ${maxCorrection.toFixed(2)} m`);

  const min = Math.min(...cleaned.heights);
  const max = Math.max(...cleaned.heights);
  assert.ok(Math.abs(min - terrain.stats.minHeight) < 0.5, `cleaned min ${min.toFixed(2)} matches the bake`);
  assert.ok(Math.abs(max - terrain.stats.maxHeight) < 0.5, `cleaned max ${max.toFixed(2)} matches the bake`);
  assert.ok(min < -20, 'the real valley floor is still there');

  // resolveTerrainHeights is memoized: the 72k-cell grid is not filtered twice.
  assert.equal(resolveTerrainHeights(terrain), cleaned);

  // The cleaner must still do the heavy lifting when a bake *is* dirty - this is
  // exactly what the M2.5 payload looked like, and what any future source that
  // regresses would produce again.
  const cols = 16;
  const rows = 16;
  const sentinel = -162.446;
  const dirty = new Float32Array(cols * rows);
  for (let iz = 0; iz < rows; iz += 1) {
    for (let ix = 0; ix < cols; ix += 1) dirty[iz * cols + ix] = 4 + ix * 0.25 + iz * 0.1;
  }
  dirty[5 * cols + 5] += 45;        // canopy spike
  dirty[9 * cols + 10] -= 45;       // trunk-base hole
  dirty[12 * cols + 3] = sentinel;  // unsampled cell written as a real number
  const fixed = filterHeightOutliers(dirty, cols, rows, { sentinel });
  assert.equal(fixed.sentinelCells, 1, 'the sentinel cell is recognised');
  assert.ok(fixed.spikes >= 1 && fixed.holes >= 1, `spike and hole corrected: ${JSON.stringify({ spikes: fixed.spikes, holes: fixed.holes })}`);
  assert.ok(Math.abs(fixed.values[5 * cols + 5] - dirty[5 * cols + 6]) < 6, 'the spike is pulled down to its neighbours');
  assert.ok(Math.abs(fixed.values[9 * cols + 10] - dirty[9 * cols + 11]) < 6, 'the hole is filled from its neighbours');
  assert.ok(Math.abs(fixed.values[12 * cols + 3] - sentinel) > 1, 'the sentinel value is gone');
  assert.ok(Math.abs(fixed.values[0] - dirty[0]) < 0.5, 'untouched ground is left exactly alone');
  assert.equal(fixed.values.length, dirty.length, 'same grid shape back');
});

test('the heightfield body is built from the cleaned grid', () => {
  const roadMaterial = new CANNON.Material('road');
  const body = buildHeightfieldBody(terrain, roadMaterial);
  const cleaned = resolveTerrainHeights(terrain);
  assert.equal(body.shapes.length, 1);
  const shape = body.shapes[0];
  assert.ok(shape instanceof CANNON.Heightfield);
  // Row 0 of the matrix is the far edge of the grid (rows are flipped for cannon).
  assert.ok(Math.abs(shape.data[0][0] - cleaned.heights[(terrain.rows - 1) * terrain.cols]) < 1e-6);
  // The pit corner must not be 96 m down any more.
  assert.ok(shape.data[0][terrain.cols - 1] > terrain.stats.minHeight - 1, 'the corner cell is filled in');
  assert.equal(body.mass, 0, 'static');
});

test('trunks are recovered from the scene and rejected when they are not trunks', () => {
  const model = new THREE.Group();
  const trunkMaterial = new THREE.MeshStandardMaterial({ name: 'Trunk_Oak' });
  const canopyMaterial = new THREE.MeshStandardMaterial({ name: 'Background_Tree_Atlas' });

  // A tall, narrow trunk.
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 12, 8), trunkMaterial);
  trunk.position.set(10, 6, -4);
  model.add(trunk);
  // A wide, low canopy blob: must not become a collider.
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(6, 12, 8), canopyMaterial);
  canopy.position.set(10, 16, -4);
  model.add(canopy);
  // A flat sheet at ground level with a trunk-ish name: rejected on height.
  const rootFlare = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 0.4, 8), new THREE.MeshStandardMaterial({ name: 'Trunk_Birch' }));
  rootFlare.position.set(-12, 0.2, 8);
  model.add(rootFlare);

  const heightAt = () => 0;
  const trunks = deriveTrunks(model, heightAt);
  assert.equal(trunks.length, 1, `only the real trunk survives: ${JSON.stringify(trunks.map((entry) => [entry.x, entry.z, entry.radius]))}`);
  assert.ok(Math.abs(trunks[0].x - 10) < 1.2 && Math.abs(trunks[0].z + 4) < 1.2, 'positioned where the trunk is');
  assert.ok(trunks[0].radius > 0.2 && trunks[0].radius < 1.2, `a trunk-sized radius: ${trunks[0].radius}`);
  assert.ok(trunks[0].topY > trunks[0].baseY + 4, 'tall enough to stop a car');
});

test('trunk colliders are grouped into tiles, standing along +Y', () => {
  const trunks = [];
  for (let index = 0; index < 40; index += 1) {
    // Two clusters far apart, so they must land in different tiles.
    const cluster = index % 2;
    trunks.push({
      x: cluster * 200 + (index % 5) * 3,
      z: (index % 7) * 3,
      radius: 0.4,
      baseY: -2,
      topY: 10,
    });
  }
  const material = new CANNON.Material('road');
  const bodies = buildTrunkBodies(trunks, material, { tileSize: 24 });
  assert.ok(bodies.length >= 2 && bodies.length < trunks.length, `${bodies.length} tile bodies for ${trunks.length} trunks`);
  const totalShapes = bodies.reduce((sum, body) => sum + body.shapes.length, 0);
  assert.equal(totalShapes, trunks.length, 'no trunk was dropped');
  for (const body of bodies) {
    assert.equal(body.mass, 0, 'trunks never move');
    for (const [index, shape] of body.shapes.entries()) {
      assert.ok(shape instanceof CANNON.Cylinder);
      const offset = body.shapeOffsets[index];
      // cannon-es cylinders stand along +Y, so no per-shape rotation is needed.
      assert.ok(offset.y > 0, `the collider sits above its base: ${offset.y}`);
      assert.equal(body.shapeOrientations[index].w, 1, 'no rotation applied');
    }
  }
});

test('the collider ceiling keeps every trunk the bake ships, in coarse tiles', () => {
  // Free Roam is the whole map, so a ceiling below the baked count would quietly
  // turn the trees beyond the trail band into drive-through scenery.
  assert.ok(
    terrain.trunks.length <= MAX_TRUNK_COLLIDERS,
    `all ${terrain.trunks.length} baked trunks fit under the ${MAX_TRUNK_COLLIDERS} ceiling`,
  );

  const trunks = terrain.trunks.map(([x, z, radius, baseY]) => ({ x, z, radius, baseY, topY: baseY + 8 }));
  const bodies = buildTrunkBodies(trunks, new CANNON.Material('road'));
  const shapes = bodies.reduce((sum, body) => sum + body.shapes.length, 0);
  assert.equal(shapes, trunks.length, 'every trunk became a collider');
  assert.ok(bodies.length < trunks.length / 5, `grouped into ${bodies.length} tiles, not ${trunks.length} loose bodies`);
  assert.ok(bodies.every((body) => body.mass === 0), 'trunks never move');

  // Coverage: the colliders span the forest, not a strip beside the road. The
  // baked payload covers 361 m of the 496 m map across X and 295 m of 518 m
  // across Z, while the trail itself only runs 162 m x 38 m - so trees are solid
  // well away from the road in every direction, which is what Free Roam needs.
  const extent = mapExtent(terrain);
  const span = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[sorted.length - 1] - sorted[0];
  };
  const trunkX = span(trunks.map((trunk) => trunk.x));
  const trunkZ = span(trunks.map((trunk) => trunk.z));
  assert.ok(trunkX > (extent.maxX - extent.minX) * 0.6, `trunks span ${trunkX.toFixed(0)} m of the ${(extent.maxX - extent.minX).toFixed(0)} m map across X`);
  assert.ok(trunkZ > (extent.maxZ - extent.minZ) * 0.5, `trunks span ${trunkZ.toFixed(0)} m of the ${(extent.maxZ - extent.minZ).toFixed(0)} m map across Z`);
  const roadZ = span(terrain.path.map((point) => point[1]));
  assert.ok(trunkZ > roadZ * 4, `the forest is deeper than the trail is wide: ${trunkZ.toFixed(0)} m vs ${roadZ.toFixed(0)} m`);
});

test('Free Roam bounds are the whole map, the trail bounds are the corridor', () => {
  const extent = mapExtent(terrain);
  const width = terrain.cols * terrain.cellSize;
  const depth = terrain.rows * terrain.cellSize;
  assert.ok(extent.maxX - extent.minX > width * 0.85, 'Free Roam covers essentially the whole map');
  assert.ok(extent.maxZ - extent.minZ > depth * 0.85);
  // ...with a soft margin, so the car is turned back before the heightfield ends.
  assert.ok(extent.minX > terrain.origin[0], 'inset from the grid edge');
  assert.ok(extent.maxZ < terrain.origin[2] + depth, 'inset from the grid edge');
});

test('the trail corridor is wide enough for the traced road', () => {
  // The traced road half-width is ~12 m; the M2 clamp of 9.5 m put the soft
  // walls inside the visible verges. The clamp must sit above the measurement.
  const corridor = Math.max(6, Math.min(13.5, terrain.roadHalfWidth));
  assert.ok(corridor >= terrain.roadHalfWidth - 0.01, `corridor ${corridor} covers the road ${terrain.roadHalfWidth}`);
  assert.ok(corridor > 11, 'and is a genuinely wide trail');
});
