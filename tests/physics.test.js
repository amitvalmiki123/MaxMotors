import assert from 'node:assert/strict';
import test from 'node:test';
import { createVehiclePhysics, getVehicleTelemetry, resetVehicle, stepVehicle } from '../src/game/physics.js';

function runSteps(physics, count, input) {
  for (let index = 0; index < count; index += 1) stepVehicle(physics, input);
}

test('RaycastVehicle physics steps and settles on the ground plane', () => {
  const physics = createVehiclePhysics({ position: { x: 0, y: 1.02, z: 0 }, yaw: 0 });
  runSteps(physics, 180, {});

  assert.ok(Number.isFinite(physics.chassisBody.position.y));
  assert.ok(physics.chassisBody.position.y > 0.45 && physics.chassisBody.position.y < 1.5);
  assert.ok(getVehicleTelemetry(physics).speedKmh < 2);
});

test('throttle accelerates the RaycastVehicle forward', () => {
  const physics = createVehiclePhysics({ position: { x: 0, y: 1.02, z: 0 }, yaw: 0 });
  runSteps(physics, 240, { throttle: 1 });
  const telemetry = getVehicleTelemetry(physics);

  assert.ok(telemetry.speedKmh > 12, `expected acceleration, got ${telemetry.speedKmh.toFixed(1)} km/h`);
  assert.ok(telemetry.signedSpeedKmh > 0, 'forward input should produce positive forward speed');
});

test('right steering turns toward the vehicle right while accelerating', () => {
  const physics = createVehiclePhysics({ position: { x: 0, y: 1.02, z: 0 }, yaw: 0 });
  runSteps(physics, 150, { throttle: 1, steer: 1 });

  assert.ok(physics.chassisBody.position.x > 1, 'right input should turn toward positive X when facing negative Z');
  assert.ok(physics.chassisBody.position.z < -1, 'the car should continue moving forward through the turn');
});

test('service brake slows a moving vehicle and reset restores its spawn state', () => {
  const physics = createVehiclePhysics({ position: { x: 0, y: 1.02, z: 0 }, yaw: 0 });
  runSteps(physics, 150, { throttle: 1 });
  const speedBeforeBrake = getVehicleTelemetry(physics).speedKmh;
  runSteps(physics, 70, { brake: 1 });
  const speedAfterBrake = getVehicleTelemetry(physics).speedKmh;

  assert.ok(speedAfterBrake < speedBeforeBrake, 'braking should reduce vehicle speed');
  resetVehicle(physics, { position: { x: 4, y: 1.1, z: 7 }, yaw: 0.25 });
  assert.deepEqual(
    [physics.chassisBody.position.x, physics.chassisBody.position.y, physics.chassisBody.position.z],
    [4, 1.1, 7],
  );
  assert.ok(getVehicleTelemetry(physics).speedKmh < 0.01);
});
