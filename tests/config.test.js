import assert from 'node:assert/strict';
import test from 'node:test';
import { CAR_PRESETS, getCar, getPaint } from '../src/game/cars/catalog.js';
import { detectTier } from '../src/game/config.js';
import { getSurface, SURFACES } from '../src/game/surfaces.js';

function fakeWindow({ coarse = false, width = 1440, dpr = 2, search = '', memory = 8 } = {}) {
  return {
    matchMedia: (query) => ({ matches: query.includes('coarse') ? coarse : false }),
    innerWidth: width,
    devicePixelRatio: dpr,
    location: { search },
    navigator: { deviceMemory: memory },
  };
}

test('desktop gets post-processing, 4K HDRI and 2048 shadows', () => {
  const tier = detectTier({ window: fakeWindow() });
  assert.equal(tier.id, 'desktop');
  assert.equal(tier.postprocessing, true);
  assert.equal(tier.bloom, true);
  assert.equal(tier.ssao, true);
  assert.equal(tier.vignette, true);
  assert.equal(tier.shadows, 2048);
  assert.equal(tier.hdriTier, 'desktop');
});

test('mobile turns post-processing off and drops to 1024 shadows', () => {
  const tier = detectTier({ window: fakeWindow({ coarse: true, width: 430 }) });
  assert.equal(tier.mobile, true);
  assert.equal(tier.postprocessing, false);
  assert.equal(tier.bloom, false);
  assert.equal(tier.ssao, false);
  assert.equal(tier.vignette, false);
  assert.equal(tier.shadows, 1024);
  assert.equal(tier.hdriTier, 'mobile');
  assert.ok(tier.textureBudgetMB <= 150, 'mobile texture budget must stay at or under 150 MB');
});

test('a ?quality= override wins over device detection', () => {
  assert.equal(detectTier({ window: fakeWindow({ coarse: true, search: '?quality=high' }) }).mobile, false);
  assert.equal(detectTier({ window: fakeWindow({ search: '?quality=low' }) }).low, true);
  assert.equal(detectTier({ window: fakeWindow({ search: '?quality=low' }) }).dustParticles, false);
});

test('car presets keep the M1 handling as the reference for the concept car', () => {
  const aurora = getCar('aurora-v12');
  assert.equal(aurora.physics.mass, 1180);
  assert.equal(aurora.physics.maxForwardForce, 2050);
  assert.equal(aurora.physics.serviceBrakeForce, 8500);
  assert.equal(aurora.physics.handbrakeForce, 11500);
  assert.equal(aurora.paint.length, 3, 'the concept car ships three paint options');
});

test('the SUV preset is heavier, torquier and slower than the concept', () => {
  const suv = getCar('sikandar-suv');
  const aurora = getCar('aurora-v12');
  assert.ok(suv.physics.mass > aurora.physics.mass);
  assert.ok(suv.physics.maxForwardForce > aurora.physics.maxForwardForce);
  assert.ok(suv.physics.topSpeedKmh < aurora.physics.topSpeedKmh);
  assert.ok(suv.physics.frictionSlip < aurora.physics.frictionSlip, 'the SUV should slide more');
  assert.equal(suv.paint.length, 3);
});

test('both cars resolve a paint option and fall back safely', () => {
  for (const id of Object.keys(CAR_PRESETS)) {
    assert.equal(getPaint(id, 'does-not-exist').id, getCar(id).paint[0].id);
  }
  assert.equal(getCar('unknown').id, 'aurora-v12');
});

test('the dirt surface is looser than asphalt and throws more dust', () => {
  const dirt = getSurface('dirt');
  const asphalt = getSurface('asphalt');
  assert.ok(dirt.frictionScale < asphalt.frictionScale);
  assert.ok(dirt.grip < asphalt.grip);
  assert.ok(dirt.dust > asphalt.dust);
  assert.ok(dirt.suspensionScale > 1, 'the trail should bounce a little more');
  assert.equal(getSurface('nope').id, 'asphalt');
  assert.equal(SURFACES.dirt.offTrackGrip < SURFACES.asphalt.offTrackGrip, true);
});
