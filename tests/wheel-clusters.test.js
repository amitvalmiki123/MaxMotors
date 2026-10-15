import assert from 'node:assert/strict';
import test from 'node:test';
import { clusterWheels, descriptorFromBounds, estimateWheelRadius } from '../src/game/cars/wheel-clusters.js';

function wheel(name, x, y, z, radius, width = 0.26, wheelish = true) {
  return descriptorFromBounds({
    id: name,
    name,
    min: [x - width / 2, y - radius, z - radius],
    max: [x + width / 2, y + radius, z + radius],
    wheelish,
  });
}

function body(name, min, max) {
  return descriptorFromBounds({ id: name, name, min, max });
}

test('wheel radius comes from the most repeated disc size, not the largest part', () => {
  const candidates = [
    wheel('wheel-fl', -0.8, 0.38, -1.5, 0.38),
    wheel('wheel-fr', 0.8, 0.38, -1.5, 0.38),
    wheel('wheel-rl', -0.8, 0.38, 1.2, 0.38),
    wheel('wheel-rr', 0.8, 0.38, 1.2, 0.38),
    body('roof_scoop', [-0.3, 1.4, -0.4], [0.3, 1.6, 0.4]),
  ];
  const estimate = estimateWheelRadius(candidates, 1.9);
  assert.ok(estimate, 'expected a radius estimate');
  assert.ok(Math.abs(estimate.radius - 0.38) < 0.001, `expected 0.38, got ${estimate.radius}`);
  assert.equal(estimate.support, 4);
});

test('mirrored pairs yield four wheels with rim and tyre merged into one hub', () => {
  const candidates = [
    // Rim + tyre on the left front hub, only a tyre on the right front hub.
    wheel('rim-fl', -0.62, 0.26, -1.04, 0.21, 0.05, false),
    wheel('tyre-fl', -0.7, 0.26, -1.04, 0.21, 0.23),
    wheel('tyre-fr', 0.7, 0.26, -1.04, 0.21, 0.23),
    wheel('rim-rl', -0.62, 0.26, 1.04, 0.21, 0.05, false),
    wheel('tyre-rl', -0.7, 0.26, 1.04, 0.21, 0.23),
    wheel('tyre-rr', 0.7, 0.26, 1.04, 0.21, 0.23),
    // A door and the roof are disc-like but far too big to be wheels.
    wheel('door_lf', -0.86, 1.02, -0.42, 0.69, 0.42, false),
    wheel('door_rf', 0.87, 1.02, -0.41, 0.69, 0.44, false),
    body('body_shell', [-1, 0, -2], [1, 1, 2]),
  ];
  const result = clusterWheels(candidates, {
    modelWidth: 2,
    modelCenterX: 0,
    groundY: 0,
    height: 1.6,
  });

  assert.equal(result.complete, true, `expected 4 wheels, got ${result.wheels.length}`);
  assert.deepEqual(
    result.wheels.map((entry) => entry.corner).sort(),
    ['front-left', 'front-right', 'rear-left', 'rear-right'],
  );
  assert.ok(Math.abs(result.wheelbase - 2.08) < 0.01, `wheelbase ${result.wheelbase}`);
  // The hub sits between the rim and the outer tyre face, so the measured track
  // is a little narrower than the outer-to-outer width.
  assert.ok(result.track > 1.25 && result.track < 1.45, `track ${result.track}`);
  const frontLeft = result.wheels.find((entry) => entry.corner === 'front-left');
  assert.equal(frontLeft.memberNames.length, 2, 'rim and tyre should share the front-left pivot');
});

test('a single-mesh car still gets four quadrant wheels', () => {
  const candidates = [
    wheel('one', -0.75, 0.3, -1.2, 0.3, 0.24),
    wheel('two', 0.75, 0.3, -1.2, 0.3, 0.24),
    wheel('three', -0.75, 0.3, 1.2, 0.3, 0.24),
    wheel('four', 0.75, 0.3, 1.2, 0.3, 0.24),
  ];
  const result = clusterWheels(candidates, { modelWidth: 1.8, height: 1.3 });
  assert.equal(result.complete, true);
  assert.equal(result.radiusEstimate.radius, 0.3);
});

test('body panels that overlap the centreline are never scored as wheels', () => {
  const panel = body('underbody_plate', [-0.9, 0, -2], [0.9, 0.2, 2]);
  const candidates = [panel, ...['fl', 'fr', 'rl', 'rr'].map((id, index) => wheel(
    `wheel_${id}`,
    index % 2 === 0 ? -0.8 : 0.8,
    0.35,
    index < 2 ? -1.4 : 1.4,
    0.35,
  ))];
  const result = clusterWheels(candidates, { modelWidth: 1.8, height: 1.4 });
  assert.equal(result.complete, true);
  const names = result.wheels.flatMap((entry) => entry.memberNames);
  assert.ok(!names.includes('underbody_plate'), 'the underbody must not be rigged to a wheel');
});
