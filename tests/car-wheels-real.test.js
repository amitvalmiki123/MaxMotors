import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clusterWheels,
  descriptorFromBounds,
  inCornerBand,
  sitsOnGround,
} from '../src/game/cars/wheel-clusters.js';

/** Descriptor from a centre + full size, the form the exporters report. */
function part(name, center, size, wheelish = false) {
  const min = center.map((value, axis) => value - size[axis] / 2);
  const max = center.map((value, axis) => value + size[axis] / 2);
  return descriptorFromBounds({ id: name, name, min, max, wheelish });
}

/**
 * Real candidate geometry of the owner-supplied Scorpio-N (2.18 x 1.85 x 4.67 m,
 * measured from the committed inspect tree). The four wheel nodes sit at
 * (+-0.79, 0.38, -1.56) and (+-0.79, 0.38, +1.19) with a 0.76 m tyre, so the
 * correct answer is a 2.75 m wheelbase, a 1.58 m track and a 0.38 m radius.
 * The decoys are the parts that used to steal the corners: they are mirrored,
 * disc-shaped and mid-height.
 */
function sikandarCandidates() {
  const candidates = [];
  const wheels = [
    ['front-left', -0.79, -1.56],
    ['front-right', 0.79, -1.56],
    ['rear-left', -0.79, 1.19],
    ['rear-right', 0.79, 1.19],
  ];
  for (const [corner, x, z] of wheels) {
    const mirror = Math.sign(x) < 0 ? -1 : 1;
    candidates.push(part(`wheel_${corner}_tyre`, [x, 0.38, z], [0.26, 0.76, 0.76], true));
    candidates.push(part(`wheel_${corner}_rim`, [x - 0.08 * mirror, 0.38, z], [0.06, 0.49, 0.49], true));
    candidates.push(part(`wheel_${corner}_brake`, [x - 0.03 * mirror, 0.38, z - 0.01], [0.05, 0.33, 0.33]));
    candidates.push(part(`wheel_${corner}_cover`, [x - 0.04 * mirror, 0.41, z + 0.12], [0.07, 0.2, 0.12]));
  }
  candidates.push(
    part('chassis_shell', [0, 1.02, -0.08], [1.91, 1.49, 4.57], true),
    part('interior_body', [0, 0.77, 0.72], [1.35, 0.49, 2.2], true),
    part('steering_wheel', [0.39, 1.16, -0.5], [0.32, 0.16, 0.12], true),
    part('dashboard_dial_l', [-0.44, 0.79, -0.7], [0.08, 0.68, 0.68], true),
    part('dashboard_dial_r', [0.44, 0.79, -0.7], [0.08, 0.68, 0.68], true),
    part('door_card_l', [-0.86, 1.02, -0.42], [0.42, 0.69, 0.69], true),
    part('door_card_r', [0.86, 1.02, -0.41], [0.44, 0.69, 0.69], true),
    part('headlight', [0, 0.96, -2.11], [1.76, 0.24, 0.36]),
    part('taillight', [0, 1.16, 1.96], [1.62, 0.15, 0.2]),
    part('mirror_l', [-1.08, 1.2, -0.62], [0.28, 0.16, 0.22]),
    part('mirror_r', [1.08, 1.2, -0.62], [0.28, 0.16, 0.22]),
  );
  return candidates;
}

const SIKANDAR_CONTEXT = {
  modelWidth: 2.176,
  modelCenterX: 0,
  groundY: 0,
  height: 1.847,
  halfLength: 4.673 / 2,
};

test('the Scorpio-N cluster lands on its real wheel corners', () => {
  const result = clusterWheels(sikandarCandidates(), SIKANDAR_CONTEXT);

  assert.equal(result.complete, true, `expected 4 wheels, got ${result.wheels.length}`);
  assert.deepEqual(
    result.wheels.map((wheel) => wheel.corner),
    ['front-left', 'front-right', 'rear-left', 'rear-right'],
  );
  assert.ok(Math.abs(result.wheelbase - 2.75) < 0.12, `wheelbase ${result.wheelbase}`);
  assert.ok(Math.abs(result.track - 1.58) < 0.1, `track ${result.track}`);
  assert.ok(Math.abs(result.radius - 0.38) < 0.04, `radius ${result.radius}`);
  assert.ok(Math.abs(result.frontZ + 1.56) < 0.12, `frontZ ${result.frontZ}`);
  assert.ok(Math.abs(result.rearZ - 1.19) < 0.12, `rearZ ${result.rearZ}`);

  for (const wheel of result.wheels) {
    const left = wheel.corner.endsWith('left');
    const front = wheel.corner.startsWith('front');
    assert.equal(Math.sign(wheel.center[0]), left ? -1 : 1, `${wheel.corner} x sign`);
    assert.equal(Math.sign(wheel.center[2]), front ? -1 : 1, `${wheel.corner} z sign`);
    assert.ok(wheel.members.length >= 3, `${wheel.corner} should own its tyre, rim and brake`);
  }
});

test('mid-height interior trim is rejected by the ground and corner priors', () => {
  const cockpitDrums = sikandarCandidates().filter((candidate) => candidate.name.startsWith('dashboard')
    || candidate.name.startsWith('door_card')
    || candidate.name.startsWith('steering'));

  assert.ok(cockpitDrums.length >= 4, 'fixture should contain the decoys');
  for (const candidate of cockpitDrums) {
    assert.equal(sitsOnGround(candidate, SIKANDAR_CONTEXT), false, `${candidate.name} should not sit on the ground`);
  }
  // The real tyre passes both priors.
  const tyre = sikandarCandidates().find((candidate) => candidate.name === 'wheel_front-left_tyre');
  assert.equal(sitsOnGround(tyre, SIKANDAR_CONTEXT), true);
  assert.equal(inCornerBand(tyre, SIKANDAR_CONTEXT), true);
});

test('a body panel too big to be a wheel never becomes a hub', () => {
  const result = clusterWheels(sikandarCandidates(), SIKANDAR_CONTEXT);
  const names = result.wheels.flatMap((wheel) => wheel.memberNames);
  for (const decoy of ['chassis_shell', 'interior_body', 'headlight', 'taillight']) {
    assert.ok(!names.includes(decoy), `${decoy} must not be rigged to a wheel`);
  }
});

/**
 * Real candidate geometry of the owner-supplied Terzo Millennio (2.65 x 0.75 x
 * 3.56 m). Its wheels sit at (+-0.63, 0.27, -1.04) and (+-0.67, 0.25, +1.04) with
 * a 0.45 m tyre: a 2.08 m wheelbase, a 1.30 m track and a 0.225 m radius. The
 * dangerous decoys are the side skirts (+-0.64, 0.25, -0.58) — mirrored discs of
 * exactly wheel size, only a third of a wheelbase away from the front axle.
 */
function auroraCandidates() {
  const candidates = [];
  for (const [corner, x, z] of [['front-left', -0.63, -1.04], ['front-right', 0.63, -1.04], ['rear-left', -0.67, 1.04], ['rear-right', 0.67, 1.04]]) {
    const mirror = Math.sign(x) < 0 ? -1 : 1;
    candidates.push(part(`wheel_${corner}_tyre`, [x, corner.startsWith('front') ? 0.27 : 0.25, z], [0.39, 0.45, 0.46], true));
    candidates.push(part(`wheel_${corner}_rim`, [x - 0.14 * mirror, 0.27, z], [0.12, 0.45, 0.46], true));
    candidates.push(part(`wheel_${corner}_motion`, [x - 0.15 * mirror, 0.28, z], [0.09, 0.45, 0.45], true));
  }
  candidates.push(
    part('skirt_l', [-0.64, 0.25, -0.58], [0.3, 0.34, 0.46]),
    part('skirt_r', [0.64, 0.25, -0.58], [0.3, 0.34, 0.46]),
    part('cockpit_drum', [0, 0.4, 0.15], [0.9, 0.61, 0.96], true),
    part('rear_deck', [0, 0.54, 0.98], [0.78, 0.27, 0.68]),
    part('rear_wing_l', [-0.72, 0.62, 1.2], [0.5, 0.12, 0.12]),
    part('rear_wing_r', [0.72, 0.62, 1.2], [0.5, 0.12, 0.12]),
    part('glass_door_l', [-0.86, 0.5, 0.2], [0.14, 0.44, 0.9], true),
    part('glass_door_r', [0.86, 0.5, 0.2], [0.14, 0.44, 0.9], true),
    part('chassis_floor', [0, 0.16, 0], [1.6, 0.2, 2.6], true),
  );
  return candidates;
}

const AURORA_CONTEXT = {
  modelWidth: 2.647,
  modelCenterX: -0.1115,
  groundY: 0.012,
  height: 0.752,
  halfLength: 3.556 / 2,
};

test('the Terzo Millennio cluster lands on its real wheel corners', () => {
  const result = clusterWheels(auroraCandidates(), AURORA_CONTEXT);

  assert.equal(result.complete, true, `expected 4 wheels, got ${result.wheels.length}`);
  assert.deepEqual(
    result.wheels.map((wheel) => wheel.corner),
    ['front-left', 'front-right', 'rear-left', 'rear-right'],
  );
  assert.ok(Math.abs(result.wheelbase - 2.08) < 0.15, `wheelbase ${result.wheelbase}`);
  assert.ok(Math.abs(result.track - 1.3) < 0.12, `track ${result.track}`);
  assert.ok(Math.abs(result.radius - 0.225) < 0.03, `radius ${result.radius}`);

  const names = result.wheels.flatMap((wheel) => wheel.memberNames);
  for (const decoy of ['skirt_l', 'skirt_r', 'cockpit_drum', 'glass_door_l', 'chassis_floor']) {
    assert.ok(!names.includes(decoy), `${decoy} must not be rigged to a wheel`);
  }
});
