import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANTI_FLIP,
  BRAKE_RESPONSE,
  DRIFT_MODE,
  FIXED_TIME_STEP,
  STEERING_RESPONSE,
  THROTTLE_RESPONSE,
  chassisTilt,
  createVehiclePhysics,
  getVehicleTelemetry,
  resetControlState,
  resetVehicle,
  setDriftMode,
  setSelector,
  stepVehicle,
} from '../src/game/physics.js';
import { getCar } from '../src/game/cars/catalog.js';

const step = FIXED_TIME_STEP;

/** Steps the sim until `predicate` holds or the budget runs out. */
function driveUntil(physics, input, predicate, { maxSteps = 1200 } = {}) {
  for (let index = 0; index < maxSteps; index += 1) {
    stepVehicle(physics, input, step);
    if (predicate(getVehicleTelemetry(physics), physics, index)) return index;
  }
  return -1;
}

function fresh(carId = null, { selector = 'D' } = {}) {
  const physics = createVehiclePhysics(carId ? { preset: getCar(carId).physics } : {});
  resetVehicle(physics, { position: { x: 0, y: 1.02, z: 0 }, yaw: 0, selector });
  return physics;
}

test('steering is rate-limited: one step of full lock does not reach full lock', () => {
  const physics = fresh();
  stepVehicle(physics, { steer: 1 }, step);
  const rack = Math.abs(physics.control.steer);
  const limit = physics.config.steering?.maxSteer ?? 0.48;
  assert.ok(rack > 0 && rack < limit * 0.25, `a single step moves the rack a little: ${rack} of ${limit}`);
  // The rack converges on the limit while the key is held.
  for (let index = 0; index < 120; index += 1) stepVehicle(physics, { steer: 1 }, step);
  assert.ok(Math.abs(physics.control.steer) > limit * 0.75, 'held lock reaches most of the available angle');
  // Releasing self-centres faster than turning in.
  assert.ok(STEERING_RESPONSE.selfCentreRate > STEERING_RESPONSE.turnInRate);
  for (let index = 0; index < 90; index += 1) stepVehicle(physics, {}, step);
  assert.ok(Math.abs(physics.control.steer) < 0.02, 'the rack returns to centre');
});

test('the steering limit still falls off with speed', () => {
  const physics = fresh('aurora-v12');
  const angleAt = (speedKmh) => {
    resetVehicle(physics, { position: { x: 0, y: 1.02, z: 0 }, yaw: 0 });
    // Give the rack the same amount of time at each speed and read where it got.
    physics.chassisBody.velocity.set(0, 0, -speedKmh / 3.6);
    for (let index = 0; index < 200; index += 1) stepVehicle(physics, { steer: 1 }, step);
    return Math.abs(physics.control.steer);
  };
  const slow = angleAt(10);
  const fast = angleAt(150);
  assert.ok(fast < slow, `less lock is available at speed: ${fast.toFixed(3)} < ${slow.toFixed(3)}`);
});

test('throttle ramps instead of stepping', () => {
  const physics = fresh();
  stepVehicle(physics, { throttle: 1 }, step);
  const afterOne = physics.control.throttle;
  assert.ok(afterOne > 0 && afterOne < 0.15, `one step of pedal travel: ${afterOne}`);
  assert.ok(Math.abs(afterOne - THROTTLE_RESPONSE.rise * step) < 1e-9, 'the rise rate is the configured one');
  const steps = driveUntil(physics, { throttle: 1 }, () => physics.control.throttle >= 1);
  assert.ok(steps > 8, `wide open throttle takes time: ${steps} steps`);
  // Lifting closes faster than it opened.
  assert.ok(THROTTLE_RESPONSE.fall > THROTTLE_RESPONSE.rise);
  const liftSteps = driveUntil(physics, {}, () => physics.control.throttle <= 0);
  assert.ok(liftSteps > 0 && liftSteps < steps, `the plate closes quicker (${liftSteps}) than it opened (${steps})`);
});

test('the brake pedal builds pressure progressively and splits 60/40 front/rear', () => {
  const physics = fresh();
  stepVehicle(physics, { brake: 1 }, step);
  assert.ok(physics.control.brake > 0 && physics.control.brake < 0.2, `pressure builds: ${physics.control.brake}`);
  for (let index = 0; index < 60; index += 1) stepVehicle(physics, { brake: 1 }, step);
  assert.ok(Math.abs(physics.control.brake - 1) < 1e-6, 'full pedal reaches full pressure');

  const brakes = physics.vehicle.wheelInfos.map((wheel) => wheel.brake);
  const [fl, fr, rl, rr] = brakes;
  assert.ok(fl > rl && fr > rr, 'the front axle carries more brake than the rear');
  const frontShare = (fl + fr) / brakes.reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(frontShare - BRAKE_RESPONSE.frontBias) < 0.02, `front share ${frontShare.toFixed(3)} ≈ 0.6`);
  assert.ok(Math.abs(rl / rr - 1) < 1e-9, 'left and right of an axle match');
});

test('the brake is an impulse cap, not raw newtons (the M2 60× bug)', () => {
  const physics = fresh();
  for (let index = 0; index < 60; index += 1) stepVehicle(physics, { brake: 1 }, step);
  const brake = physics.vehicle.wheelInfos[0].brake;
  const expected = (physics.config.serviceBrakeForce * physics.config.brakeGain * BRAKE_RESPONSE.frontBias * step) / 2;
  assert.ok(Math.abs(brake - expected) < expected * 0.02, `per-wheel impulse ${brake} ≈ ${expected}`);
  // It must be roughly the force times one step: a raw newton value here would
  // be 60× larger and stop the car inside a single frame.
  assert.ok(brake < physics.config.serviceBrakeForce / 10, 'nowhere near the raw force figure');
});

test('braking a moving car decelerates hard but never stops it in one frame', () => {
  const physics = fresh('aurora-v12');
  driveUntil(physics, { throttle: 1 }, (telemetry) => telemetry.speedKmh > 90);
  const before = getVehicleTelemetry(physics).speedKmh;
  stepVehicle(physics, { brake: 1 }, step);
  const after = getVehicleTelemetry(physics).speedKmh;
  assert.ok(after < before, 'the first step of braking slows the car');
  assert.ok(before - after < before * 0.15, `...gradually, not instantly (${before.toFixed(1)} → ${after.toFixed(1)} km/h)`);

  // ~1.1 g on the concept car: strong, and it takes a real distance.
  const stops = driveUntil(physics, { brake: 1 }, (telemetry) => telemetry.speedKmh < 1);
  assert.ok(stops > 30, `stopping from ${before.toFixed(0)} km/h takes ${stops} steps, not one`);
  const deceleration = (before / 3.6) / (stops * step);
  assert.ok(deceleration > 6 && deceleration < 14, `deceleration ${deceleration.toFixed(1)} m/s² is a real disc brake`);
});

test('ABS modulates a locking wheel instead of letting it skid', () => {
  const physics = fresh('sikandar-suv');
  driveUntil(physics, { throttle: 1 }, (telemetry) => telemetry.speedKmh > 80);
  let modulated = false;
  let released = 0;
  for (let index = 0; index < 240; index += 1) {
    stepVehicle(physics, { brake: 1 }, step);
    const { wheelBrake, absActive } = physics.control;
    if (wheelBrake.some((value) => value < 0.999)) modulated = true;
    if (absActive) released += 1;
  }
  assert.ok(modulated || physics.control.absEvents > 0, 'the ABS loop modulated at least one wheel');
  if (released) {
    assert.ok(physics.control.absEvents > 0, 'a dump was recorded');
    // Pressure must come back once the wheel is turning again.
    assert.ok(physics.control.wheelBrake.every((value) => value >= BRAKE_RESPONSE.absRelease * 0.9));
  }
  assert.ok(BRAKE_RESPONSE.absRelease < 1 && BRAKE_RESPONSE.absRelease > 0.1, 'the dump leaves some brake on');
  assert.ok(BRAKE_RESPONSE.absDropRate > BRAKE_RESPONSE.absRecoverRate, 'pressure drops faster than it returns');
});

test('P holds the car and delivers no drive torque', () => {
  const physics = fresh('aurora-v12', { selector: 'P' });
  for (let index = 0; index < 240; index += 1) stepVehicle(physics, { throttle: 1, brake: 0 }, step);
  const telemetry = getVehicleTelemetry(physics);
  assert.ok(telemetry.speedKmh < 1.5, `full throttle in P does not move the car: ${telemetry.speedKmh}`);
  assert.ok(physics.control.brake > 0.99, 'P applies the park brakes');
  const brakes = physics.vehicle.wheelInfos.map((wheel) => wheel.brake);
  const rearShare = (brakes[2] + brakes[3]) / brakes.reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(rearShare - BRAKE_RESPONSE.parkRearBias) < 0.02, `park holds mainly on the rear axle: ${rearShare.toFixed(2)}`);
  // On a slope a parked car must not creep: give it a shove and re-hold.
  physics.chassisBody.velocity.set(0.6, 0, 0);
  for (let index = 0; index < 60; index += 1) stepVehicle(physics, {}, step);
  assert.ok(getVehicleTelemetry(physics).speedKmh < 2.5, 'the park brake holds against a shove');
});

test('N coasts: no drive, no park brake', () => {
  const physics = fresh('aurora-v12', { selector: 'N' });
  for (let index = 0; index < 120; index += 1) stepVehicle(physics, { throttle: 1 }, step);
  assert.ok(getVehicleTelemetry(physics).speedKmh < 1, 'N delivers no torque');
  assert.equal(physics.control.brake, 0, 'N does not apply the park brake');
  // Rolling in N slows only by drag.
  physics.chassisBody.velocity.set(0, 0, -14);
  const before = getVehicleTelemetry(physics).speedKmh;
  for (let index = 0; index < 60; index += 1) stepVehicle(physics, {}, step);
  const after = getVehicleTelemetry(physics).speedKmh;
  assert.ok(after < before && after > before * 0.8, 'N coasts down slowly, it does not brake');
});

test('R drives backwards and the S key in D only ever brakes', () => {
  const reverse = fresh('aurora-v12', { selector: 'R' });
  for (let index = 0; index < 180; index += 1) stepVehicle(reverse, { throttle: 1 }, index % 3 === 0 ? step : step);
  assert.ok(getVehicleTelemetry(reverse).signedSpeedKmh < -4, 'throttle in R moves the car backwards');

  const drive = fresh('aurora-v12', { selector: 'D' });
  for (let index = 0; index < 120; index += 1) stepVehicle(drive, { throttle: 1 }, step);
  // Rolling backwards in D (pushed, or on a slope) must not select reverse.
  drive.chassisBody.velocity.set(0, 0, 6);
  for (let index = 0; index < 60; index += 1) stepVehicle(drive, { brake: 1 }, step);
  assert.ok(getVehicleTelemetry(drive).speedKmh < 12, 'S in D brakes');
  assert.equal(drive.control.selector, 'D');
});

test('the selector latches and rejects stray values', () => {
  const physics = fresh();
  assert.equal(setSelector(physics, 'R'), 'R');
  assert.equal(physics.control.selector, 'R');
  assert.equal(setSelector(physics, 'n'), 'N', 'case insensitive');
  assert.equal(setSelector(physics, 'Q'), 'N', 'an invalid position is ignored');
  assert.equal(setSelector(physics, ''), 'N');
  // stepVehicle latches it too, so a touch widget can drive it.
  stepVehicle(physics, { selector: 'D' }, step);
  assert.equal(physics.control.selector, 'D');
  stepVehicle(physics, { selector: 'X' }, step);
  assert.equal(physics.control.selector, 'D', 'stepVehicle ignores invalid positions');
});

test('a reset keeps the driver\'s gate but clears the actuators', () => {
  const physics = fresh('aurora-v12', { selector: 'R' });
  for (let index = 0; index < 120; index += 1) stepVehicle(physics, { throttle: 1, steer: 1 }, step);
  resetVehicle(physics, { position: { x: 2, y: 1.1, z: 3 }, yaw: 0 });
  assert.equal(physics.control.selector, 'R', 'the gear position survives a reset');
  assert.equal(physics.control.steer, 0);
  assert.equal(physics.control.throttle, 0);
  assert.equal(physics.control.brake, 0);
  assert.deepEqual(physics.control.wheelBrake, [1, 1, 1, 1]);
  assert.equal(physics.control.flipped, false);
  // ...and an explicit selector in the reset wins.
  resetVehicle(physics, { position: { x: 0, y: 1.02, z: 0 }, yaw: 0, selector: 'D' });
  assert.equal(physics.control.selector, 'D');
});

test('a car swap rebuilds the actuators but keeps the driver\'s choices', () => {
  const physics = fresh('aurora-v12', { selector: 'N' });
  setDriftMode(physics, true);
  physics.control.steer = 0.3;
  physics.control.brake = 0.7;
  resetControlState(physics, { selector: 'N', driftMode: true });
  assert.equal(physics.control.selector, 'N');
  assert.equal(physics.control.driftMode, true);
  assert.equal(physics.control.steer, 0, 'actuator travel starts from rest');
  assert.equal(physics.control.brake, 0);
  assert.deepEqual(physics.control.wheelBrake, [1, 1, 1, 1]);
});

test('drift mode loosens the rear axle and holds the slide', () => {
  const physics = fresh('aurora-v12');
  driveUntil(physics, { throttle: 1 }, (telemetry) => telemetry.speedKmh > 70);
  setDriftMode(physics, true);
  stepVehicle(physics, { throttle: 1, steer: -1 }, step);
  const rear = physics.vehicle.wheelInfos[2].frictionSlip;
  const front = physics.vehicle.wheelInfos[0].frictionSlip;
  assert.ok(Math.abs(rear - physics.config.frictionSlip * DRIFT_MODE.rearGrip) < 1e-9, 'the rear axle loses grip');
  assert.equal(front, physics.config.frictionSlip, 'the front keeps its grip so it can still steer');
  assert.equal(physics.chassisBody.angularDamping, DRIFT_MODE.angularDamping, 'less yaw damping keeps the rotation');

  // The car must actually rotate, and must not roll over doing it.
  const yawOf = (q) => Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
  const start = yawOf(physics.chassisBody.quaternion);
  let peakTilt = 0;
  for (let index = 0; index < 120; index += 1) {
    // Half lock: full lock at 70 km/h on a loose rear axle is a spin, not a drift.
    stepVehicle(physics, { throttle: 1, steer: -0.5 }, step);
    peakTilt = Math.max(peakTilt, chassisTilt(physics.chassisBody));
  }
  const rotated = Math.abs(yawOf(physics.chassisBody.quaternion) - start);
  assert.ok(rotated > 0.15, `drift mode rotates the car: ${rotated.toFixed(2)} rad`);
  assert.ok(peakTilt < 0.6, `a drift stays on its wheels: peak tilt ${peakTilt.toFixed(2)} rad`);
  assert.ok(getVehicleTelemetry(physics).speedKmh > 20, 'and keeps its momentum');

  setDriftMode(physics, false);
  stepVehicle(physics, { throttle: 1 }, step);
  assert.equal(physics.vehicle.wheelInfos[2].frictionSlip, physics.config.frictionSlip, 'grip restored');
  assert.equal(physics.chassisBody.angularDamping, 0.42);
});

test('the handbrake reaches at least as far as drift mode on the rear axle', () => {
  const physics = fresh('aurora-v12');
  setDriftMode(physics, true);
  stepVehicle(physics, { throttle: 1, handbrake: true }, step);
  const rear = physics.vehicle.wheelInfos[2].frictionSlip;
  assert.ok(
    Math.abs(rear - physics.config.frictionSlip * Math.min(0.6, DRIFT_MODE.rearGrip)) < 1e-9,
    `handbrake + drift takes the looser of the two: ${rear}`,
  );
});

test('the rollover guard keeps a hard stop and a kerb slide off the roof', () => {
  for (const carId of ['aurora-v12', 'sikandar-suv']) {
    // Locked-front-axle stop from speed, steering hard into it: the classic
    // "car plants its nose and cartwheels" scenario.
    const physics = fresh(carId);
    driveUntil(physics, { throttle: 1 }, (telemetry) => telemetry.speedKmh > 110);
    let peakTilt = 0;
    let flips = 0;
    for (let index = 0; index < 300; index += 1) {
      stepVehicle(physics, { brake: 1, steer: index % 60 < 30 ? 1 : -1 }, step);
      peakTilt = Math.max(peakTilt, chassisTilt(physics.chassisBody));
      if (physics.control.flipped) flips += 1;
    }
    assert.equal(flips, 0, `${carId}: the car never latched as rolled over`);
    assert.ok(peakTilt < 1.2, `${carId}: peak tilt ${peakTilt.toFixed(2)} rad stays well short of a flip`);
    assert.ok(peakTilt > 0.001, `${carId}: the manoeuvre really did load the car`);
  }
});

test('the rollover guard brings an artificially tilted car back onto its wheels', () => {
  const physics = fresh('aurora-v12');
  for (let index = 0; index < 60; index += 1) stepVehicle(physics, {}, step);
  // Tip it well past the guard's engagement angle and let the sim run.
  physics.chassisBody.quaternion.setFromAxisAngle({ x: 0, y: 0, z: 1 }, 0.95);
  physics.chassisBody.angularVelocity.set(0, 0, 0);
  physics.chassisBody.position.y += 0.5;
  let tilt = chassisTilt(physics.chassisBody);
  assert.ok(tilt > ANTI_FLIP.uprightFrom, 'starts tilted');
  for (let index = 0; index < 240; index += 1) {
    stepVehicle(physics, {}, step);
    tilt = chassisTilt(physics.chassisBody);
  }
  assert.ok(tilt < 0.5, `the righting torque levels it: ${tilt.toFixed(3)} rad`);
  // It really was on its roof: the latch fired and then cleared on recovery, and
  // the excursion is counted rather than silently forgotten.
  assert.equal(physics.control.flipped, false, 'back on its wheels, so no longer flipped');
  assert.equal(physics.control.rollovers, 1, 'the rollover was recorded');
  // ...and it is driveable again.
  const steps = driveUntil(physics, { throttle: 1 }, (t) => t.speedKmh > 5);
  assert.ok(steps >= 0, 'the recovered car drives away');
});

test('a heavy tumble is rate-limited, but yaw is left alone', () => {
  const physics = fresh('aurora-v12');
  for (let index = 0; index < 30; index += 1) stepVehicle(physics, {}, step);
  physics.chassisBody.angularVelocity.set(14, 6, -14);
  stepVehicle(physics, {}, step);
  const local = { x: 0, y: 0, z: 0 };
  physics.chassisBody.vectorToLocalFrame(physics.chassisBody.angularVelocity, local);
  const limit = ANTI_FLIP.maxTiltRate * ANTI_FLIP.airborneTiltRateScale;
  assert.ok(Math.abs(local.x) <= limit + 1e-6, `roll rate clamped to ${limit}: ${local.x}`);
  assert.ok(Math.abs(local.z) <= limit + 1e-6, `pitch rate clamped to ${limit}: ${local.z}`);
  assert.ok(Math.abs(local.y) > limit, `yaw is untouched, so a drift still spins: ${local.y}`);
});

test('engine braking slows an off-throttle car in gear but not in N', () => {
  const inGear = fresh('aurora-v12', { selector: 'D' });
  driveUntil(inGear, { throttle: 1 }, (telemetry) => telemetry.speedKmh > 100);
  const gearBefore = getVehicleTelemetry(inGear).speedKmh;
  for (let index = 0; index < 240; index += 1) stepVehicle(inGear, {}, step);
  const gearAfter = getVehicleTelemetry(inGear).speedKmh;

  const neutral = fresh('aurora-v12', { selector: 'N' });
  driveUntil(neutral, { throttle: 1 }, (telemetry) => telemetry.speedKmh > 100);
  const neutralBefore = getVehicleTelemetry(neutral).speedKmh;
  for (let index = 0; index < 240; index += 1) stepVehicle(neutral, {}, step);
  const neutralAfter = getVehicleTelemetry(neutral).speedKmh;

  const gearLoss = gearBefore - gearAfter;
  const neutralLoss = neutralBefore - neutralAfter;
  assert.ok(gearLoss > 2, `D slows off throttle: ${gearLoss.toFixed(1)} km/h`);
  assert.ok(gearLoss > neutralLoss + 1.5, `and more than N does (${neutralLoss.toFixed(1)} km/h): that is engine braking`);
});

test('both cars stop within a realistic distance, and neither needs a different pedal', () => {
  const results = {};
  for (const carId of ['aurora-v12', 'sikandar-suv']) {
    const physics = fresh(carId);
    driveUntil(physics, { throttle: 1 }, (telemetry) => telemetry.speedKmh > 95);
    const startZ = physics.chassisBody.position.z;
    const before = getVehicleTelemetry(physics).speedKmh;
    const steps = driveUntil(physics, { brake: 1 }, (telemetry) => telemetry.speedKmh < 1, { maxSteps: 900 });
    const distance = Math.abs(physics.chassisBody.position.z - startZ);
    const deceleration = (before / 3.6) ** 2 / (2 * Math.max(0.1, distance));
    results[carId] = { distance, deceleration, g: deceleration / 9.82 };
  }
  for (const [carId, entry] of Object.entries(results)) {
    assert.ok(entry.g > 0.75 && entry.g < 1.35, `${carId}: ${entry.g.toFixed(2)} g from ~100 km/h over ${entry.distance.toFixed(1)} m`);
  }
  // The heavier SUV must not need twice the pedal travel to stop.
  const ratio = results['sikandar-suv'].distance / results['aurora-v12'].distance;
  assert.ok(ratio < 1.5, `both cars stop in a comparable distance (ratio ${ratio.toFixed(2)})`);
});
