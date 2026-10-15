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

test('handbrake drift: SPACE-held rear grip cut rotates the car into a slide, never lifts it', async () => {
  const { getCar } = await import('../src/game/cars/catalog.js');
  const { HANDBRAKE_REAR_GRIP } = await import('../src/game/physics.js');
  const yawOf = (q) => Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
  for (const carId of ['aurora-v12', 'sikandar-suv']) {
    const physics = createVehiclePhysics({ preset: getCar(carId).physics });
    resetVehicle(physics, { position: { x: 0, y: 1.02, z: 0 }, yaw: 0 });
    while (getVehicleTelemetry(physics).speedKmh < 65) stepVehicle(physics, { throttle: 1 }, 1 / 60);
    // Off the handbrake every wheel keeps the preset grip.
    assert.ok(physics.vehicle.wheelInfos.every((wheel) => wheel.frictionSlip === physics.config.frictionSlip));
    let peakSlip = 0;
    let airborne = 0;
    const script = [
      ...Array(15).fill({ throttle: 1, steer: -1 }),
      ...Array(24).fill({ throttle: 1, steer: -1, handbrake: true }),
      ...Array(60).fill({ throttle: 1, steer: 0.4 }),
    ];
    for (const input of script) {
      stepVehicle(physics, input, 1 / 60);
      if (input.handbrake) assert.equal(physics.vehicle.wheelInfos[2].frictionSlip, physics.config.frictionSlip * HANDBRAKE_REAR_GRIP);
      const velocity = physics.chassisBody.velocity;
      const speed = Math.hypot(velocity.x, velocity.z);
      const yaw = yawOf(physics.chassisBody.quaternion);
      if (speed > 2) peakSlip = Math.max(peakSlip, Math.acos(Math.min(1, (-Math.sin(yaw) * velocity.x - Math.cos(yaw) * velocity.z) / speed)) * 180 / Math.PI);
      if (physics.vehicle.wheelInfos.every((wheel) => wheel.suspensionForce === 0)) airborne += 1;
    }
    assert.ok(peakSlip > 20 && peakSlip < 60, `${carId}: peak slip ${peakSlip.toFixed(1)}° should be a drift, not grip or a spin`);
    assert.equal(airborne, 0, `${carId}: the handbrake must not pitch the car off the ground`);
    assert.ok(getVehicleTelemetry(physics).speedKmh > 25, `${carId}: a drift keeps its momentum`);
    assert.ok(physics.vehicle.wheelInfos.every((wheel) => wheel.frictionSlip === physics.config.frictionSlip), 'grip restored on release');
  }
});
