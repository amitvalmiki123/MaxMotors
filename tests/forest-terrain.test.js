import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getCar } from '../src/game/cars/catalog.js';
import { createVehiclePhysics, getVehicleTelemetry, resetVehicle, stepVehicle } from '../src/game/physics.js';
import { buildHeightfieldBody, decodeHeights, pickSpawnIndex } from '../src/game/tracks/forest-trail.js';

const terrain = JSON.parse(readFileSync(new URL('../public/tracks/forest-dirt-trail.terrain.json', import.meta.url)));
const heights = decodeHeights(terrain.heights, terrain.cols * terrain.rows);

function heightAt(x, z) {
  const ix = Math.round((x - terrain.origin[0]) / terrain.cellSize);
  const iz = Math.round((z - terrain.origin[2]) / terrain.cellSize);
  return heights[iz * terrain.cols + ix];
}

test('stored heights and the road path share one space (the offset is baked in)', () => {
  const [x, y, z] = terrain.path[0];
  assert.ok(Math.abs(heightAt(x, z) - y) < 1.5, `road point y ${y} vs terrain ${heightAt(x, z)}`);
});

test('a car spawned on the forest trail settles on the heightfield instead of being launched', () => {
  for (const carId of ['aurora-v12', 'sikandar-suv']) {
    const physics = createVehiclePhysics({ preset: getCar(carId).physics });
    const body = buildHeightfieldBody(terrain, physics.roadMaterial);
    physics.world.addBody(body);
    // What the track does on activate(): the flat safety plane drops below the terrain.
    physics.groundBody.position.y = terrain.stats.minHeight - 6;
    physics.groundBody.aabbNeedsUpdate = true;
    const points = terrain.path.map(([px, py, pz]) => ({ x: px, y: py, z: pz }));
    const bilinear = (px, pz) => {
      const fx = (px - terrain.origin[0]) / terrain.cellSize;
      const fz = (pz - terrain.origin[2]) / terrain.cellSize;
      const ix = Math.floor(fx);
      const iz = Math.floor(fz);
      const g = (cx, cz) => heights[cz * terrain.cols + cx];
      return (g(ix, iz) * (1 - (fx - ix)) + g(ix + 1, iz) * (fx - ix)) * (1 - (fz - iz)) + (g(ix, iz + 1) * (1 - (fx - ix)) + g(ix + 1, iz + 1) * (fx - ix)) * (fz - iz);
    };
    const index = pickSpawnIndex(points, bilinear);
    const { x, y, z } = points[index];
    const next = points[index + 1];
    resetVehicle(physics, { position: { x, y: y + 0.6, z }, yaw: Math.atan2(-(next.x - x), -(next.z - z)) });
    let peak = 0;
    for (let step = 0; step < 180; step += 1) {
      stepVehicle(physics, {}, 1 / 60);
      peak = Math.max(peak, getVehicleTelemetry(physics).speedKmh);
    }
    const chassis = physics.chassisBody.position;
    const ground = heightAt(chassis.x, chassis.z);
    assert.ok(peak < 25, `${carId}: peak speed ${peak.toFixed(1)} km/h while settling`);
    assert.ok(chassis.y > ground - 0.2 && chassis.y < ground + 1.6, `${carId}: chassis y ${chassis.y.toFixed(2)} vs ground ${ground.toFixed(2)}`);
    // Every tyre on the trail (the path's first point straddled a 3.7 m drop).
    physics.world.step(1 / 60);
    assert.ok(physics.vehicle.wheelInfos.every((wheel) => wheel.raycastResult.hasHit), `${carId}: all four wheels touch the terrain at the spawn`);
  }
});
