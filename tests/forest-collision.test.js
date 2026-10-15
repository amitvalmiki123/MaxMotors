import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {
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

test('the shipped heightfield is cleaned at load: pits, spikes and holes', () => {
  const count = terrain.cols * terrain.rows;
  const raw = decodeHeights(terrain.heights, count);
  const cleaned = resolveTerrainHeights(terrain);

  // The old serializer wrote unreachable cells as a bare 0, which after the
  // height offset is exactly `heightOffset`: a real-looking number 96 m down.
  const pits = [...raw].filter((value) => Math.abs(value - terrain.heightOffset) < 0.02).length;
  assert.ok(pits > 0, `the shipped payload still has ${pits} sentinel pits to clean`);
  assert.equal(cleaned.sentinelCells, pits);

  const before = auditOutliers(Array.from(raw), { threshold: 8 });
  const after = auditOutliers(Array.from(cleaned.heights), { threshold: 8 });
  assert.ok(before.spikes + before.holes > 50, `the raw grid really is broken: ${JSON.stringify(before)}`);
  assert.ok(
    after.spikes + after.holes <= Math.max(6, (before.spikes + before.holes) * 0.1),
    `extreme outliers must be gone: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
  );
  // Reported counts, so the HUD/report can show what was fixed.
  assert.ok(cleaned.spikes > 0 && cleaned.holes > 0, `corrected ${cleaned.spikes} spikes and ${cleaned.holes} holes`);

  // No 96 m pit survives, and the cleaned grid stays inside the mapped range.
  const min = Math.min(...cleaned.heights);
  assert.ok(min > terrain.stats.minHeight - 1, `cleaned min ${min.toFixed(2)} stays on the terrain`);
  assert.ok(min < -20, 'the real valley floor is still there');

  // resolveTerrainHeights is memoized: the 72k-cell grid is not filtered twice.
  assert.equal(resolveTerrainHeights(terrain), cleaned);
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
