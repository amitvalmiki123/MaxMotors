import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { CAMERA_MODES, ORBIT_MAX_KMH, chaseFraming, createCameraDirector, orbitOffset, wrapAngle } from '../src/game/cameras.js';

function makeDirector() {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
  const director = createCameraDirector({ camera, element: null });
  return { camera, director };
}

/** Chassis pose facing -Z (yaw 0), then rotated by `yaw` about +Y. */
function pose(yaw = 0, position = { x: 0, y: 1, z: 0 }) {
  const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
  return {
    position,
    quaternion: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
    velocity: { x: forward.x * 30, y: 0, z: forward.z * 30 },
    yawRate: 0,
    steerAngle: 0,
    carSize: { x: 1.9, y: 1.2, z: 4.5 },
  };
}

test('wrapAngle folds into (-π, π]', () => {
  assert.ok(Math.abs(wrapAngle(0)) < 1e-12);
  assert.ok(Math.abs(wrapAngle(Math.PI * 2) - 0) < 1e-9);
  assert.ok(Math.abs(wrapAngle(-Math.PI * 3) - Math.PI) < 1e-9);
  assert.ok(Math.abs(wrapAngle(3 * Math.PI) - Math.PI) < 1e-9);
  for (const angle of [-40, -7, 0, 3, 11, 90]) {
    const wrapped = wrapAngle(angle);
    assert.ok(wrapped > -Math.PI - 1e-9 && wrapped <= Math.PI + 1e-9, `${angle} -> ${wrapped}`);
    assert.ok(Math.abs(wrapAngle(wrapped) - wrapped) < 1e-12, 'idempotent');
  }
});

test('chase framing opens up with speed and leans out of a corner', () => {
  const slow = chaseFraming({ speedKmh: 5, topSpeedKmh: 165 });
  const fast = chaseFraming({ speedKmh: 165, topSpeedKmh: 165 });
  assert.ok(fast.distance > slow.distance, 'the camera pulls back with speed');
  assert.ok(fast.fov > slow.fov, 'and widens the FOV');
  assert.ok(fast.fov <= 76 && slow.fov >= 58, 'within the configured range');
  assert.ok(fast.lookAhead > slow.lookAhead, 'looking further down the road');

  // Turning left (positive yaw rate) moves the camera to the outside of the turn.
  const left = chaseFraming({ speedKmh: 80, yawRate: 1.2 });
  const right = chaseFraming({ speedKmh: 80, yawRate: -1.2 });
  assert.ok(left.lateral > 0 && right.lateral < 0, 'the offset flips with the turn direction');
  assert.ok(Math.abs(left.lateral) <= 0.85 && Math.abs(right.lateral) <= 0.85, 'and is clamped');
  assert.equal(chaseFraming({ speedKmh: 80, yawRate: 0 }).lateral, 0, 'no offset in a straight line');
});

test('orbit offset: relativeYaw 0 is straight behind the car, whatever its heading', () => {
  for (const heading of [0, 0.7, -2.1, Math.PI]) {
    const behind = orbitOffset({ relativeYaw: 0, pitch: 0.3, distance: 8, headingYaw: heading });
    // Behind the car means opposite its forward direction (-Z rotated by heading).
    const forwardX = -Math.sin(heading);
    const forwardZ = -Math.cos(heading);
    const flat = Math.hypot(behind.x, behind.z);
    assert.ok((behind.x / flat) * forwardX + (behind.z / flat) * forwardZ < -0.99, `behind at heading ${heading}`);

    const front = orbitOffset({ relativeYaw: Math.PI, pitch: 0.3, distance: 8, headingYaw: heading });
    assert.ok((front.x / flat) * forwardX + (front.z / flat) * forwardZ > 0.99, `in front at heading ${heading}`);
  }
  const high = orbitOffset({ relativeYaw: 0, pitch: 1.2, distance: 8, headingYaw: 0 });
  assert.ok(high.y > 6, 'pitch lifts the camera');
  const level = orbitOffset({ relativeYaw: 0, pitch: 0, distance: 8, headingYaw: 0 });
  assert.ok(Math.abs(level.y) < 1e-9, 'pitch 0 is level with the car');
  assert.ok(Math.abs(Math.hypot(level.x, level.y, level.z) - 8) < 1e-9, 'distance is honoured');
});

test('orbit engages at any speed (M2.6: it used to be parked-car only)', () => {
  assert.equal(ORBIT_MAX_KMH, Infinity, 'there is no speed gate any more');
  const { camera, director } = makeDirector();
  assert.equal(director.orbitAvailable, true);

  // Settle into chase at 150 km/h, then ask for orbit.
  for (let index = 0; index < 30; index += 1) director.update({ deltaTime: 1 / 60, speedKmh: 150, topSpeedKmh: 165, ...pose(0) });
  const chaseDistance = camera.position.length();
  assert.equal(director.setMode('orbit'), 'orbit');
  assert.equal(director.mode, 'orbit', 'orbit engaged while driving');
  for (let index = 0; index < 30; index += 1) director.update({ deltaTime: 1 / 60, speedKmh: 150, topSpeedKmh: 165, ...pose(0) });
  assert.equal(director.mode, 'orbit', 'and it stays: no speed-based hand-back');
  assert.ok(Math.abs(camera.position.length() - chaseDistance) < 6, 'it picks up from where the camera already was');
  director.dispose();
});

test('the orbit angle is locked to the car: it follows the car through a turn', () => {
  const { camera, director } = makeDirector();
  const RADIUS = 20;
  const SPEED = 21;
  const arc = (yaw) => ({ x: Math.sin(yaw) * -RADIUS, y: 1, z: Math.cos(yaw) * -RADIUS });
  const frame = (yaw) => {
    const point = arc(yaw);
    director.update({ deltaTime: 1 / 60, speedKmh: SPEED * 3.6, ...pose(yaw, point) });
    return point;
  };
  /** Bearing of the camera around the car, measured relative to the car's heading. */
  const relativeBearing = (yaw) => {
    const point = arc(yaw);
    return wrapAngle(Math.atan2(camera.position.x - point.x, camera.position.z - point.z) - yaw);
  };

  for (let index = 0; index < 40; index += 1) frame(0);

  // Put the camera on a three-quarter view *before* engaging orbit: entering
  // straight from chase would leave relativeYaw at 0 and the test would pass
  // without proving anything.
  const start = arc(0);
  camera.position.set(start.x + 5.2, 2.6, start.z + 3);
  director.setMode('orbit');
  frame(0);
  const before = relativeBearing(0);
  assert.ok(Math.abs(before) > 0.6, `engaged from a real off-axis view: ${before.toFixed(3)} rad`);
  assert.ok(Math.abs(wrapAngle(before - director.orbitYaw)) < 1e-6, 'the stored angle is the relative one');

  // Drive the car through a 90° left-hand corner at ~75 km/h.
  let yaw = 0;
  for (let index = 0; index < 90; index += 1) {
    yaw += (Math.PI / 2) / 90;
    frame(yaw);
  }
  const after = relativeBearing(yaw);
  assert.ok(
    Math.abs(wrapAngle(after - before)) < 0.08,
    `the chosen angle survives the turn: ${before.toFixed(3)} -> ${after.toFixed(3)} rad relative to the car`,
  );
  assert.equal(director.mode, 'orbit', 'still orbiting at the end of the corner');
  // In *world* space the camera swung right round with the car, which is the
  // point: it kept its angle relative to the car rather than staying put.
  const worldBearing = Math.atan2(camera.position.x - arc(yaw).x, camera.position.z - arc(yaw).z);
  assert.ok(Math.abs(wrapAngle(worldBearing)) > 0.6, `the world bearing moved with the car: ${worldBearing.toFixed(3)}`);
  director.dispose();
});

test('C cycles chase → orbit → cockpit → chase at any speed', () => {
  const { director } = makeDirector();
  assert.deepEqual(CAMERA_MODES, ['chase', 'orbit', 'cockpit']);
  assert.equal(director.mode, 'chase');
  for (let index = 0; index < 10; index += 1) director.update({ deltaTime: 1 / 60, speedKmh: 140, ...pose(0) });
  assert.equal(director.cycle(), 'orbit', 'orbit is reachable at 140 km/h');
  director.update({ deltaTime: 1 / 60, speedKmh: 140, ...pose(0) });
  assert.equal(director.mode, 'orbit', 'no forced hand-back at speed');
  assert.equal(director.cycle(), 'cockpit');
  assert.equal(director.cycle(), 'chase');
  assert.equal(director.cycle(), 'orbit');
  director.dispose();
});

test('the cockpit camera sits at the driver-head anchor in rig space', () => {
  const { camera, director } = makeDirector();
  const carGroup = new THREE.Group();
  carGroup.position.set(10, 1, -4);
  carGroup.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4);
  const head = new THREE.Vector3(-0.38, 0.845, -0.3);
  director.setMode('cockpit');
  for (let index = 0; index < 60; index += 1) {
    director.update({ deltaTime: 1 / 60, speedKmh: 0, ...pose(0.4, { x: 10, y: 1, z: -4 }), carGroup, cockpitHead: head });
  }
  const expected = head.clone().applyMatrix4(carGroup.matrixWorld);
  assert.ok(camera.position.distanceTo(expected) < 1e-6, `head anchor honoured: ${camera.position.toArray()} vs ${expected.toArray()}`);
  assert.ok(camera.near < 0.05, 'the near plane comes in so the dash is not clipped');
  assert.ok(camera.fov > 68, 'a wider cockpit FOV');

  // Leaving the cockpit restores the driving near plane.
  director.setMode('chase');
  director.update({ deltaTime: 1 / 60, speedKmh: 0, ...pose(0.4, { x: 10, y: 1, z: -4 }) });
  assert.ok(camera.near >= 0.1);
  director.dispose();
});

test('chase stays above the ground and follows the slope ahead', () => {
  const { camera, director } = makeDirector();
  // A hill: ground rises 0.25 m per metre of +Z.
  const groundHeightAt = (x, z) => z * 0.25;
  for (let index = 0; index < 120; index += 1) {
    director.update({
      deltaTime: 1 / 60,
      speedKmh: 40,
      ...pose(0, { x: 0, y: 40 * 0.25 + 0.6, z: 40 }),
      groundHeightAt,
    });
  }
  assert.ok(camera.position.y > groundHeightAt(camera.position.x, camera.position.z) + 0.5, 'the camera never dips into the hill');
  director.dispose();
});
