import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { STEERING_RATIO, attachCockpit, createProceduralSteeringWheel } from '../src/game/cars/cockpit-rig.js';
import { getCar } from '../src/game/cars/catalog.js';

/** The Aurora's baked cockpit block, as shipped in its manifest. */
const AURORA_COCKPIT = {
  source: 'estimate',
  driverSide: 'left',
  head: [-0.38, 0.76, -0.315],
  steeringWheel: { center: [-0.38, 0.56, -0.735], axis: [0, 0.375, 0.927], radius: 0.17, node: null, material: null },
};
/** The SUV's, which was measured from its real `steering_dummy` node. */
const SUV_COCKPIT = {
  source: 'steering-node',
  driverSide: 'right',
  head: [0.375, 1.425, 0.006],
  steeringWheel: { center: [0.374, 1.176, -0.408], axis: [0.003, 0.338, 0.941], radius: 0.18, node: 'steering_dummy', material: null },
};

function makeRig(carId, { bounds, withWheelNode = false } = {}) {
  const group = new THREE.Group();
  group.name = 'car:test';
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(bounds ? bounds.max[0] - bounds.min[0] : 1.9, bounds ? bounds.max[1] - bounds.min[1] : 1, bounds ? bounds.max[2] - bounds.min[2] : 4.4),
    new THREE.MeshStandardMaterial({ name: 'Carosserie' }),
  );
  if (bounds) body.position.set((bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2);
  group.add(body);
  let steeringNode = null;
  if (withWheelNode) {
    // A real, named wheel: a torus of 0.18 m radius standing in for `steering_dummy`.
    steeringNode = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.02, 8, 24), new THREE.MeshStandardMaterial({ name: 'int_steering' }));
    steeringNode.name = 'steering_dummy';
    steeringNode.position.fromArray(SUV_COCKPIT.steeringWheel.center);
    group.add(steeringNode);
  }
  group.updateMatrixWorld(true);
  const box = bounds ? new THREE.Box3(new THREE.Vector3(...bounds.min), new THREE.Vector3(...bounds.max)) : new THREE.Box3().setFromObject(group);
  return {
    group,
    root: group,
    preset: getCar(carId),
    steeringNode,
    bounds: { box, size: box.getSize(new THREE.Vector3()) },
  };
}

const AURORA_BOUNDS = { min: [-1.056, -0.04, -2.25], max: [1.056, 0.912, 2.25] };
const SUV_BOUNDS = { min: [-0.95, 0.1, -2.3], max: [0.95, 1.95, 2.3] };

test('the Aurora\u2019s eye point is raised, and stays under the roof', () => {
  const rig = makeRig('aurora-v12', { bounds: AURORA_BOUNDS });
  const cockpit = attachCockpit(rig, { cockpit: AURORA_COCKPIT });
  const [dx, dy, dz] = getCar('aurora-v12').cockpit.headOffset;
  assert.ok(Math.abs(cockpit.head.y - (AURORA_COCKPIT.head[1] + dy)) < 1e-9, `head raised by ${dy} m: ${cockpit.head.y}`);
  assert.ok(Math.abs(cockpit.head.x - (AURORA_COCKPIT.head[0] + dx)) < 1e-9);
  assert.ok(Math.abs(cockpit.head.z - (AURORA_COCKPIT.head[2] + dz)) < 1e-9);
  assert.ok(cockpit.head.y < AURORA_BOUNDS.max[1] - 0.04, 'the eyes stay inside the canopy');
  assert.ok(cockpit.head.y > AURORA_COCKPIT.head[1] + 0.05, 'and are no longer in the driver\u2019s lap');
  assert.equal(cockpit.anchorSource, 'estimate');
});

test('the correction can never push the eyes through the roof', () => {
  const rig = makeRig('aurora-v12', { bounds: AURORA_BOUNDS });
  const cockpit = attachCockpit(rig, { cockpit: AURORA_COCKPIT }, { cockpit: { headOffset: [0, 4, 0] } });
  assert.ok(cockpit.head.y <= AURORA_BOUNDS.max[1] - 0.045 + 1e-9, `clamped to the roof: ${cockpit.head.y}`);
});

test('the Aurora gets a smaller, lower wheel than the baked estimate', () => {
  const rig = makeRig('aurora-v12', { bounds: AURORA_BOUNDS });
  const cockpit = attachCockpit(rig, { cockpit: AURORA_COCKPIT });
  const override = getCar('aurora-v12').cockpit;
  assert.equal(cockpit.source, 'procedural', 'the concept car has no wheel node, so one is built');
  assert.equal(cockpit.wheelRadius, override.wheelRadius, `rim is ${override.wheelRadius} m, not the estimated 0.17`);
  assert.ok(cockpit.wheelRadius < AURORA_COCKPIT.steeringWheel.radius, 'smaller than the bake');

  // Measure the built rim in the pivot's own frame (the disc is its XY plane).
  const pivot = cockpit.steering;
  const quaternion = pivot.quaternion.clone();
  pivot.quaternion.identity();
  pivot.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(pivot).getSize(new THREE.Vector3());
  pivot.quaternion.copy(quaternion);
  const measured = Math.max(size.x, size.y) / 2;
  assert.ok(Math.abs(measured - override.wheelRadius) < override.wheelRadius * 0.15, `built rim measures ${measured.toFixed(3)} m`);

  const [ox, oy, oz] = override.wheelOffset;
  assert.ok(Math.abs(pivot.position.y - (AURORA_COCKPIT.steeringWheel.center[1] + oy)) < 1e-9, 'tucked lower under the dash');
  assert.ok(Math.abs(pivot.position.x - (AURORA_COCKPIT.steeringWheel.center[0] + ox)) < 1e-9);
  assert.ok(Math.abs(pivot.position.z - (AURORA_COCKPIT.steeringWheel.center[2] + oz)) < 1e-9);
});

test('the dark cabin shell closes the roof — for the cockpit camera only', () => {
  const rig = makeRig('aurora-v12', { bounds: AURORA_BOUNDS });
  const cockpit = attachCockpit(rig, { cockpit: AURORA_COCKPIT });
  assert.ok(cockpit.interior, 'a canopy car with no interior gets a shell');
  assert.equal(cockpit.interior.visible, false, 'hidden by default: it must not change the car from outside');
  cockpit.setInteriorVisible(true);
  assert.equal(cockpit.interior.visible, true);
  cockpit.setInteriorVisible(false);
  assert.equal(cockpit.interior.visible, false);

  const material = cockpit.interior.material;
  assert.equal(material.side, THREE.BackSide, 'rendered from the inside');
  assert.ok(material.color.getHex() < 0x202020, `near black: #${material.color.getHexString()}`);
  assert.ok(material.envMapIntensity < 0.4, 'the environment map must not turn the headliner into a bright panel');

  // The driver's head must be inside the shell, or it closes nothing.
  const box = new THREE.Box3().setFromObject(cockpit.interior);
  assert.ok(box.containsPoint(cockpit.head), `head ${cockpit.head.toArray()} inside shell ${box.min.toArray()} .. ${box.max.toArray()}`);
  assert.ok(box.max.y >= AURORA_BOUNDS.max[1], 'the shell reaches the roof line');
});

test('the SUV keeps its real wheel node and its real cabin', () => {
  const rig = makeRig('sikandar-suv', { bounds: SUV_BOUNDS, withWheelNode: true });
  const cockpit = attachCockpit(rig, { cockpit: SUV_COCKPIT });
  assert.equal(cockpit.source, 'node', 'the named steering node was found and re-parented');
  assert.equal(cockpit.interior, null, 'a modelled cabin needs no shell');
  assert.equal(getCar('sikandar-suv').cockpit.darkInterior, false);
  cockpit.setInteriorVisible(true); // must not throw with no shell
  assert.ok(cockpit.wheelScale > 0.5 && cockpit.wheelScale < 1.7, `the node was rescaled to the declared rim: ${cockpit.wheelScale}`);
  assert.equal(cockpit.wheelRadius, 0.19, 'a real SUV rim diameter');
  // The node was re-parented onto the pivot, so it turns with the rack (it is
  // still inside the rig — attachCockpit never moves anything out of the car).
  assert.equal(rig.steeringNode.parent, cockpit.steering, 'the wheel now hangs off the steering pivot');
  assert.ok(cockpit.steering.children.length > 0);
  assert.ok(rig.root.getObjectByName('steering_dummy'), 'and is still part of the rig');
});

test('the rim turns with the front wheels, at the configured ratio', () => {
  const rig = makeRig('aurora-v12', { bounds: AURORA_BOUNDS });
  const cockpit = attachCockpit(rig, { cockpit: AURORA_COCKPIT });
  const angleOf = () => {
    const euler = new THREE.Euler().setFromQuaternion(cockpit.steering.quaternion);
    return euler.z;
  };
  const rest = angleOf();
  cockpit.update(0.2);
  const turned = angleOf();
  assert.ok(Math.abs(Math.abs(turned - rest) - 0.2 * STEERING_RATIO) < 0.05, `0.2 rad of wheel angle turns the rim ${(turned - rest).toFixed(3)} rad`);
  cockpit.update(0);
  assert.ok(Math.abs(angleOf() - rest) < 1e-6, 'and returns to rest');
  cockpit.update(-0.3);
  assert.ok(Math.sign(angleOf() - rest) !== Math.sign(turned - rest), 'the other way round for the other lock');
});

test('with no per-car corrections the baked estimate is used untouched', () => {
  const rig = makeRig('aurora-v12', { bounds: AURORA_BOUNDS });
  rig.preset = null;
  const cockpit = attachCockpit(rig, { cockpit: AURORA_COCKPIT });
  assert.deepEqual(cockpit.head.toArray(), AURORA_COCKPIT.head);
  assert.equal(cockpit.wheelRadius, AURORA_COCKPIT.steeringWheel.radius);
  assert.equal(cockpit.interior, null);
});

test('a manifest with no cockpit block falls back to the estimate', () => {
  const rig = makeRig('aurora-v12', { bounds: AURORA_BOUNDS });
  const cockpit = attachCockpit(rig, {});
  assert.ok(cockpit.head instanceof THREE.Vector3);
  assert.ok(Number.isFinite(cockpit.head.x) && Number.isFinite(cockpit.head.y));
  assert.ok(['estimate', 'procedural', 'node', 'material'].includes(cockpit.source ?? 'estimate') || cockpit.steering === null);
});

test('the procedural wheel is a rim with spokes and a hub, and owns its materials', () => {
  const wheel = createProceduralSteeringWheel(0.142);
  assert.ok(wheel.children.length >= 5, `rim, three spokes and a hub: ${wheel.children.length} parts`);
  const size = new THREE.Box3().setFromObject(wheel).getSize(new THREE.Vector3());
  assert.ok(Math.abs(Math.max(size.x, size.y) / 2 - 0.142) < 0.03, `built to the requested radius: ${Math.max(size.x, size.y) / 2}`);
  for (const child of wheel.children) {
    assert.ok(child.material.name.startsWith('procedural-steering'), 'CC0 materials of its own, never the car\u2019s');
    assert.equal(child.castShadow, false, 'inside the cabin, so no shadow cost');
  }
});
