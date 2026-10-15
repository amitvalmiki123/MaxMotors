import * as CANNON from 'cannon-es';
import { normalizeInput, SELECTORS } from './input.js';

export const FIXED_TIME_STEP = 1 / 60;

/**
 * M2.6 driving-feel pass.
 *
 * Up to here the sim read the raw input directly: one frame of `A` was full
 * lock, one frame of `S` was full brake. On a 60 Hz step that is a step
 * function into a rigid body — the front axle loaded instantly (twitchy,
 * snap-oversteer on lift), the brake impulse arrived in a single step (the
 * nose dived, the rear unloaded and the car could pitch/roll over), and there
 * was no distinction between "brake" and "reverse" other than road speed.
 *
 * Everything below models the *actuator* between the driver and the wheel:
 *   - a rate-limited, speed-sensitive steering rack (STEERING_RESPONSE),
 *   - a throttle that opens and closes over ~0.3 s (THROTTLE_RESPONSE),
 *   - progressive disc brakes with a 60/40 front/rear split and a per-wheel
 *     anti-lock loop reading cannon's own slip info (BRAKE_RESPONSE),
 *   - a P/R/N/D selector (SELECTORS) so `S` in D only ever brakes,
 *   - a drift mode that loosens the rear axle on demand (DRIFT_MODE),
 *   - a rollover guard: roll/pitch rates are clamped and a righting torque
 *     brings the chassis back before a slide can become a flip (ANTI_FLIP).
 *
 * The state lives on `physics.control` and persists across steps, which is what
 * makes all of the above smooth rather than instantaneous.
 */

/** Rate at which the front wheels actually turn, in rad/s of steering angle. */
export const STEERING_RESPONSE = Object.freeze({
  /** Rack speed at a standstill (parking manoeuvres). */
  turnInRate: 3.1,
  /** Rack speed at/above `steering.limitSpeedKmh` — the steering "weights up". */
  turnInRateAtLimit: 1.35,
  /** Self-centring is faster than turn-in, as it is on a real rack. */
  selfCentreRate: 5.4,
  /** Extra rack speed while the wheels are nearly straight (small corrections). */
  fineSteerBoost: 1.5,
});

/** Throttle plate travel, in units of 0..1 per second. */
export const THROTTLE_RESPONSE = Object.freeze({
  /** ~0.31 s from lift to wide open. */
  rise: 3.2,
  /** Lifting is quicker than pressing: engine braking arrives promptly. */
  fall: 5.4,
});

/**
 * Progressive disc brakes.
 *
 * cannon-es reads `wheel.brake` as a per-step **impulse cap (N·s)**, not a force,
 * so a preset's `serviceBrakeForce` in newtons is applied as `force × dt`. The
 * M2 code passed the raw newton value through, which is 60× too large: the car
 * stopped from 60 km/h in a single step. (The handbrake already did the
 * multiplication — that is why only the service brake felt like a wall.)
 */
export const BRAKE_RESPONSE = Object.freeze({
  /** Pedal pressure rise, 0..1 per second: ~0.2 s to full brakes. */
  rise: 5.2,
  fall: 8.5,
  /** Front/rear disc split. The nose carries the load under braking. */
  frontBias: 0.6,
  rearBias: 0.4,
  /** Park (P) holds on the rear axle mainly, like a handbrake-plus-pawl. */
  parkFrontBias: 0.25,
  parkRearBias: 0.75,
  /**
   * cannon sets `wheel.slipInfo = brakeImpulse / impulseNeededToLock`; above 1
   * the tyre has run out of grip and the wheel is locking.
   */
  absLockSlip: 1.0,
  /** Pressure released to, while a wheel is locked (an ABS "dump"). */
  absRelease: 0.3,
  /** Per-second rates of the ABS pump: ~12 cycles/s, as on a real unit. */
  absDropRate: 30,
  absRecoverRate: 9,
  /** Below this speed ABS is pointless — the car is stopping anyway. */
  absMinSpeedKmh: 4,
});

/** Loose-rear setup engaged by the DRIFT toggle (see item 6). */
export const DRIFT_MODE = Object.freeze({
  /** Rear axle grip multiplier while drift mode is on. */
  rearGrip: 0.58,
  /** A little more lock, so the slide can be caught and held. */
  steerGain: 1.16,
  /** Less yaw damping: the car keeps rotating instead of straightening itself. */
  angularDamping: 0.16,
  /** Drive torque kept through the slide, so a drift is sustainable. */
  throttleHold: 0.8,
});

/**
 * Rear-axle grip multiplier while the handbrake (SPACE / DRIFT button) is held,
 * so a handbrake turn actually rotates the car into a slide. Nothing else
 * changes: off the handbrake every wheel keeps its preset grip.
 */
export const HANDBRAKE_REAR_GRIP = 0.6;

/**
 * Rollover guard. A RaycastVehicle has no anti-roll bars and its chassis is a
 * single box, so a fast slide into a kerb (or a locked-front-axle stop) can put
 * it on its roof. Roll/pitch rates are clamped in the chassis frame — yaw is
 * left completely alone, so a drift still rotates freely — and past
 * `uprightFrom` radians of tilt a righting torque levels the car.
 */
export const ANTI_FLIP = Object.freeze({
  /** rad/s of roll or pitch; a genuine jump lands around 1.5. */
  maxTiltRate: 2.3,
  /** Airborne the clamp is looser — a car should still be able to jump. */
  airborneTiltRateScale: 1.4,
  /** Per-step bleed of the tumble while airborne, so a jump lands rather than cartwheels. */
  airborneRollDamping: 0.985,
  /** Tilt (rad) before the righting torque engages — ~29°. */
  uprightFrom: 0.5,
  /** Righting torque per kilogram of chassis mass at full tilt. */
  uprightTorquePerKg: 7.2,
  /**
   * Extra authority once the car is actually on its roof. Lifting 1180 kg over
   * its own 0.91 m half-width needs ~10.5 kN·m, which is what the base figure
   * tops out at — a car balanced exactly inverted would sit there. The scaled-up
   * torque gets it over the edge; the tilt-rate clamp above is what keeps the
   * recovery a controlled roll (~1.5 s) rather than a catapult.
   */
  invertedTorqueScale: 2.6,
  /** Tilt (rad) past which the car counts as rolled over — ~109°. */
  flippedFrom: 1.9,
  /** Seconds upside down before `control.flipped` latches. */
  flippedAfter: 0.8,
});

/** Engine braking (off-throttle drag) as a fraction of peak drive force. */
export const ENGINE_BRAKE_FRACTION = 0.06;
/** Reverse is geared short: the fade reaches its floor at this speed. */
export const REVERSE_TOP_SPEED_KMH = 42;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const VEHICLE_CONFIG = Object.freeze({
  mass: 1180,
  wheelRadius: 0.38,
  maxForwardForce: 2050,
  maxReverseForce: 1150,
  /** Peak service brake force in newtons, before `brakeGain` and the 60/40 split. */
  serviceBrakeForce: 8500,
  handbrakeForce: 11500,
});

function toVector3(value, fallback) {
  if (Array.isArray(value)) {
    return new CANNON.Vec3(value[0] ?? fallback.x, value[1] ?? fallback.y, value[2] ?? fallback.z);
  }
  return new CANNON.Vec3(value?.x ?? fallback.x, value?.y ?? fallback.y, value?.z ?? fallback.z);
}

/**
 * Resolves a car preset into the flat config the simulation uses. The default
 * (no preset) is exactly the M1 VEHICLE_CONFIG, so M1 handling is unchanged.
 */
export function resolveVehicleConfig(preset = null) {
  if (!preset) {
    // M1 defaults: 165 km/h engine fade and a 0.12 force floor reproduce the
    // original VEHICLE_CONFIG exactly.
    return {
      ...VEHICLE_CONFIG,
      suspension: null,
      steering: null,
      halfExtents: null,
      wheelAnchors: null,
      engineBite: 0.12,
      topSpeedKmh: 165,
      brakeGain: 1,
      brakeBias: BRAKE_RESPONSE.frontBias,
      defaultSelector: 'D',
    };
  }
  return {
    mass: preset.mass ?? VEHICLE_CONFIG.mass,
    wheelRadius: preset.wheelRadius ?? VEHICLE_CONFIG.wheelRadius,
    maxForwardForce: preset.maxForwardForce ?? VEHICLE_CONFIG.maxForwardForce,
    maxReverseForce: preset.maxReverseForce ?? VEHICLE_CONFIG.maxReverseForce,
    serviceBrakeForce: preset.serviceBrakeForce ?? VEHICLE_CONFIG.serviceBrakeForce,
    handbrakeForce: preset.handbrakeForce ?? VEHICLE_CONFIG.handbrakeForce,
    topSpeedKmh: preset.topSpeedKmh ?? 165,
    frictionSlip: preset.frictionSlip ?? 5.2,
    engineBite: preset.engineBite ?? 0.12,
    /**
     * `serviceBrakeForce` is a per-car reference figure inherited from M1, not a
     * deceleration: 8500 N on a 1180 kg concept car is 0.73 g while 11000 N on a
     * 2200 kg SUV is only 0.51 g. `brakeGain` scales each to a realistic ~1 g
     * so the heavier car does not need twice the pedal travel to stop.
     */
    brakeGain: preset.brakeGain ?? 1,
    brakeBias: preset.brakeBias ?? BRAKE_RESPONSE.frontBias,
    defaultSelector: SELECTORS.includes(preset.defaultSelector) ? preset.defaultSelector : 'D',
    suspension: preset.suspension ?? null,
    steering: preset.steering ?? null,
    halfExtents: preset.bodyHalfExtents ?? null,
    wheelAnchors: preset.bodyHalfExtents
      ? {
        halfTrack: preset.wheelHalfTrack ?? 0.9,
        halfBase: preset.wheelHalfBase ?? 1.14,
        anchorY: preset.wheelAnchorY ?? -0.18,
      }
      : null,
  };
}

/** Per-step actuator state. Persisted on the physics object, never rebuilt. */
function createControlState(config) {
  return {
    selector: config.defaultSelector ?? 'D',
    driftMode: false,
    /** Smoothed actuator values actually fed to the vehicle. */
    steer: 0,
    throttle: 0,
    brake: 0,
    /** Per-wheel ABS modulation, 0..1 (wheel order: FL, FR, RL, RR). */
    wheelBrake: [1, 1, 1, 1],
    absActive: false,
    absEvents: 0,
    /** Rollover guard telemetry. */
    tilt: 0,
    upsideDown: 0,
    /** True while the car is on its roof and past the latch time. */
    flipped: false,
    /** Lifetime count of completed rollovers (survived ones, once recovered). */
    rollovers: 0,
    /** True for the step a shift happened (the audio dips the engine note). */
    shifting: false,
    /**
     * Latched roll axis used while the car is on its roof. "The shortest way up"
     * is ill-defined near exactly-inverted — the cross product flips sign with
     * every wobble, so the righting torque chatters and the car balances there
     * forever. Once inverted, the guard commits to one direction and rolls the
     * car the rest of the way round.
     */
    recoveryAxis: null,
  };
}

export function createVehiclePhysics({
  position = { x: 0, y: 1.02, z: -30 },
  yaw = -Math.PI / 2,
  preset = null,
} = {}) {
  const config = resolveVehicleConfig(preset);
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = false;
  world.solver.iterations = 10;
  world.solver.tolerance = 0.001;
  world.defaultContactMaterial.friction = 0.75;
  world.defaultContactMaterial.restitution = 0;

  const roadMaterial = new CANNON.Material('road');
  const vehicleMaterial = new CANNON.Material('vehicle');
  const groundContact = new CANNON.ContactMaterial(roadMaterial, vehicleMaterial, {
    friction: 0.72,
    restitution: 0,
    contactEquationStiffness: 1e7,
    contactEquationRelaxation: 3,
  });
  world.addContactMaterial(groundContact);

  const groundBody = new CANNON.Body({ mass: 0, material: roadMaterial });
  groundBody.addShape(new CANNON.Plane());
  groundBody.position.set(0, -0.04, 0);
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(groundBody);

  const chassisBody = new CANNON.Body({
    mass: config.mass,
    material: vehicleMaterial,
    position: toVector3(position, { x: 0, y: 1.02, z: -30 }),
    linearDamping: 0.035,
    angularDamping: 0.42,
    allowSleep: false,
  });
  const halfExtents = config.halfExtents
    ? new CANNON.Vec3(config.halfExtents[0], config.halfExtents[1], config.halfExtents[2])
    : new CANNON.Vec3(0.91, 0.36, 1.72);
  chassisBody.addShape(new CANNON.Box(halfExtents));
  chassisBody.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
  world.addBody(chassisBody);

  const vehicle = new CANNON.RaycastVehicle({
    chassisBody,
    indexRightAxis: 0,
    indexUpAxis: 1,
    indexForwardAxis: 2,
  });

  const suspension = config.suspension ?? {
    suspensionStiffness: 34,
    suspensionRestLength: 0.32,
    dampingRelaxation: 2.4,
    dampingCompression: 4.6,
    maxSuspensionTravel: 0.28,
    rollInfluence: 0.035,
  };
  const anchors = config.wheelAnchors ?? { halfTrack: 0.9, halfBase: 1.14, anchorY: -0.18 };

  const wheelOptions = {
    radius: config.wheelRadius,
    directionLocal: new CANNON.Vec3(0, -1, 0),
    axleLocal: new CANNON.Vec3(-1, 0, 0),
    suspensionStiffness: suspension.suspensionStiffness,
    suspensionRestLength: suspension.suspensionRestLength,
    frictionSlip: config.frictionSlip,
    dampingRelaxation: suspension.dampingRelaxation,
    dampingCompression: suspension.dampingCompression,
    maxSuspensionForce: 100000,
    rollInfluence: suspension.rollInfluence,
    maxSuspensionTravel: suspension.maxSuspensionTravel,
    customSlidingRotationalSpeed: -30,
    useCustomSlidingRotationalSpeed: true,
  };

  const wheelPositions = [
    { x: -anchors.halfTrack, y: anchors.anchorY, z: -anchors.halfBase, front: true },
    { x: anchors.halfTrack, y: anchors.anchorY, z: -anchors.halfBase, front: true },
    { x: -anchors.halfTrack, y: anchors.anchorY, z: anchors.halfBase, front: false },
    { x: anchors.halfTrack, y: anchors.anchorY, z: anchors.halfBase, front: false },
  ];

  for (const point of wheelPositions) {
    vehicle.addWheel({
      ...wheelOptions,
      chassisConnectionPointLocal: new CANNON.Vec3(point.x, point.y, point.z),
      isFrontWheel: point.front,
    });
  }

  vehicle.addToWorld(world);

  return {
    world,
    groundBody,
    chassisBody,
    vehicle,
    roadMaterial,
    groundMaterial: groundContact,
    config,
    preset,
    /** Mutated by the game when the car leaves the track surface. */
    surface: { frictionScale: 1, suspensionScale: 1, grip: 1 },
    /** Actuator state (steering rack, throttle, brake pressure, ABS, tilt). */
    control: createControlState(config),
  };
}

/** Rebuilds the actuator state after a car swap (mass/forces all change). */
export function resetControlState(physics, { selector = null, driftMode = null } = {}) {
  const previous = physics.control ?? {};
  physics.control = createControlState(physics.config);
  if (selector && SELECTORS.includes(selector)) physics.control.selector = selector;
  else if (SELECTORS.includes(previous.selector)) physics.control.selector = previous.selector;
  physics.control.driftMode = driftMode ?? previous.driftMode ?? false;
  return physics.control;
}

/** P / R / N / D. Invalid values are ignored so a stray key cannot unset it. */
export function setSelector(physics, selector) {
  const next = String(selector ?? '').toUpperCase();
  if (!SELECTORS.includes(next) || !physics.control) return physics.control?.selector ?? null;
  physics.control.selector = next;
  return next;
}

/** Drift mode: a loose rear axle until it is switched off again. */
export function setDriftMode(physics, enabled) {
  if (!physics.control) return false;
  physics.control.driftMode = Boolean(enabled);
  return physics.control.driftMode;
}

export function getVehicleTelemetry(physics) {
  const { chassisBody } = physics;
  const forward = chassisBody.quaternion.vmult(new CANNON.Vec3(0, 0, -1));
  const signedSpeed = chassisBody.velocity.dot(forward);
  const speed = chassisBody.velocity.length();

  return {
    speedKmh: speed * 3.6,
    signedSpeedKmh: signedSpeed * 3.6,
    speedMps: speed,
  };
}

const LOCAL_UP = new CANNON.Vec3(0, 1, 0);
const WORLD_UP = new CANNON.Vec3(0, 1, 0);
/** Chassis roll axis, used when the righting torque has no shortest way up. */
const ROLL_AXIS = new CANNON.Vec3(1, 0, 0);
const tiltAxis = new CANNON.Vec3();
const localOmega = new CANNON.Vec3();
const torque = new CANNON.Vec3();

/** Chassis tilt from upright (rad): 0 level, π on its roof. */
export function chassisTilt(body) {
  const up = body.quaternion.vmult(LOCAL_UP);
  return Math.acos(clamp(up.y, -1, 1));
}

/**
 * Rollover guard, run after every world step.
 *
 * Roll and pitch rates are clamped *in the chassis frame* so yaw — the drift —
 * is untouched, then a righting torque proportional to the tilt brings the car
 * back onto its wheels. Once it has been past `flippedFrom` for
 * `flippedAfter` seconds the state latches, so the HUD (and the tests) can tell
 * a near-miss from an actual rollover.
 */
function applyRolloverGuard(physics, control, deltaTime) {
  const body = physics.chassisBody;
  const tilt = chassisTilt(body);
  control.tilt = tilt;

  const anyContact = physics.vehicle.wheelInfos.some((wheel) => wheel.isInContact || wheel.suspensionForce > 0);

  body.vectorToLocalFrame(body.angularVelocity, localOmega);
  const limit = anyContact ? ANTI_FLIP.maxTiltRate : ANTI_FLIP.maxTiltRate * ANTI_FLIP.airborneTiltRateScale;
  localOmega.x = clamp(localOmega.x, -limit, limit);
  localOmega.z = clamp(localOmega.z, -limit, limit);
  // Airborne: bleed the tumble so a jump lands rather than cartwheeling.
  if (!anyContact) {
    localOmega.x *= ANTI_FLIP.airborneRollDamping;
    localOmega.z *= ANTI_FLIP.airborneRollDamping;
  }
  body.vectorToWorldFrame(localOmega, body.angularVelocity);

  if (tilt < ANTI_FLIP.uprightFrom) control.recoveryAxis = null;

  if (tilt > ANTI_FLIP.uprightFrom) {
    const up = body.quaternion.vmult(LOCAL_UP);
    WORLD_UP.cross(up, tiltAxis);
    let length = tiltAxis.length();

    // Once the car has been on its roof, keep the committed roll direction for
    // the whole recovery: dropping back to the cross product as soon as the tilt
    // dips under `flippedFrom` would let the sign flip again mid-roll and the
    // car would chatter at ~110° instead of coming round.
    if (tilt > ANTI_FLIP.flippedFrom && !control.recoveryAxis) {
      if (length > 0.08) {
        control.recoveryAxis = { x: tiltAxis.x, y: 0, z: tiltAxis.z };
      } else {
        // Exactly inverted — no lean to read: use the chassis's own roll axis.
        const rolled = body.vectorToWorldFrame(ROLL_AXIS, new CANNON.Vec3());
        rolled.y = 0;
        if (rolled.length() < 1e-3) rolled.set(1, 0, 0);
        control.recoveryAxis = { x: rolled.x, y: 0, z: rolled.z };
      }
    }
    if (control.recoveryAxis) {
      tiltAxis.set(control.recoveryAxis.x, 0, control.recoveryAxis.z);
      length = tiltAxis.length();
    }

    if (length > 1e-3) {
      tiltAxis.scale(1 / length, tiltAxis);
      const strength = clamp((tilt - ANTI_FLIP.uprightFrom) / (Math.PI - ANTI_FLIP.uprightFrom), 0, 1);
      const inverted = control.recoveryAxis ? ANTI_FLIP.invertedTorqueScale : 1;
      const magnitude = body.mass * ANTI_FLIP.uprightTorquePerKg * inverted * (0.25 + strength);
      tiltAxis.scale(magnitude, torque);
      body.torque.vadd(torque, body.torque);
    }
  }

  if (tilt > ANTI_FLIP.flippedFrom) {
    control.upsideDown += deltaTime;
    if (control.upsideDown > ANTI_FLIP.flippedAfter) control.flipped = true;
  } else {
    control.upsideDown = Math.max(0, control.upsideDown - deltaTime * 2);
    // Back on its wheels: the latch clears and the excursion is counted, so the
    // HUD can tell "currently on its roof" from "has rolled and recovered".
    if (control.flipped && tilt < ANTI_FLIP.uprightFrom) {
      control.flipped = false;
      control.rollovers += 1;
    }
  }
  return tilt;
}

/**
 * One 60 Hz step of the whole actuator chain.
 *
 * @param {object} physics the object returned by createVehiclePhysics
 * @param {object} [rawInput] steer/throttle/brake/handbrake, plus optional
 *        `selector` ('P'|'R'|'N'|'D') and `driftMode` which latch onto the
 *        persistent control state.
 * @param {number} [deltaTime]
 */
export function stepVehicle(physics, rawInput = {}, deltaTime = FIXED_TIME_STEP) {
  const input = normalizeInput(rawInput);
  const { chassisBody, vehicle, world } = physics;
  const config = physics.config;
  const surface = physics.surface;
  physics.control ??= createControlState(config);
  const control = physics.control;
  const step = FIXED_TIME_STEP;

  if (SELECTORS.includes(String(rawInput?.selector ?? '').toUpperCase())) {
    control.selector = String(rawInput.selector).toUpperCase();
  }
  if (rawInput?.driftMode !== undefined) control.driftMode = Boolean(rawInput.driftMode);

  const telemetry = getVehicleTelemetry(physics);
  const steering = config.steering;
  const limitSpeed = steering?.limitSpeedKmh ?? 180;
  const drift = control.driftMode;

  // --- steering: rate-limited and speed-sensitive --------------------------
  // The *limit* still falls off with speed (a hypercar cannot be given full
  // lock at 180 km/h), but now the rack also takes time to get there, so a
  // tapped key nudges the car instead of throwing it into the barrier.
  const speedRatio = clamp(telemetry.speedKmh / limitSpeed, 0, 1);
  const maxSteer = (steering?.maxSteer ?? 0.48) * (drift ? DRIFT_MODE.steerGain : 1);
  const steeringLimit = maxSteer - speedRatio * (steering?.steerFalloff ?? 0.23);
  const targetSteer = -input.steer * Math.max(0.02, steeringLimit);

  const rackRate = STEERING_RESPONSE.turnInRate
    + (STEERING_RESPONSE.turnInRateAtLimit - STEERING_RESPONSE.turnInRate) * speedRatio;
  // Returning to centre is driven by the steering column's self-aligning torque,
  // which is quicker than turning in; near-straight corrections get a little
  // more rate so lane changes still feel direct. "Returning" means the target is
  // closer to centre than the rack currently is — comparing signs would call a
  // turn-in from dead straight a return, because sign(0) is 0.
  const returning = Math.abs(targetSteer) < Math.abs(control.steer);
  const fine = Math.abs(control.steer) < 0.08 ? STEERING_RESPONSE.fineSteerBoost : 1;
  const rate = (returning ? Math.max(rackRate, STEERING_RESPONSE.selfCentreRate) : rackRate) * fine;
  control.steer += clamp(targetSteer - control.steer, -rate * step, rate * step);
  if (Math.abs(control.steer) < 1e-4) control.steer = 0;

  // --- throttle: a plate that opens over ~0.3 s ----------------------------
  const throttleRate = input.throttle > control.throttle ? THROTTLE_RESPONSE.rise : THROTTLE_RESPONSE.fall;
  control.throttle += clamp(input.throttle - control.throttle, -throttleRate * step, throttleRate * step);
  if (Math.abs(control.throttle - input.throttle) < 1e-3) control.throttle = input.throttle;

  // --- brake pedal: pressure builds and releases progressively -------------
  const park = control.selector === 'P';
  const pedalTarget = park ? 1 : input.brake;
  const pedalRate = pedalTarget > control.brake ? BRAKE_RESPONSE.rise : BRAKE_RESPONSE.fall;
  control.brake += clamp(pedalTarget - control.brake, -pedalRate * step, pedalRate * step);
  if (Math.abs(control.brake - pedalTarget) < 1e-3) control.brake = pedalTarget;

  // --- surface grip, per wheel --------------------------------------------
  const frictionScale = surface?.frictionScale ?? 1;
  const suspensionScale = surface?.suspensionScale ?? 1;
  const baseFriction = config.frictionSlip;
  const baseStiffness = (config.suspension?.suspensionStiffness ?? 34) * suspensionScale;
  const handbrake = Boolean(input.handbrake);
  const rearGrip = Math.min(handbrake ? HANDBRAKE_REAR_GRIP : 1, drift ? DRIFT_MODE.rearGrip : 1);
  for (let index = 0; index < vehicle.wheelInfos.length; index += 1) {
    const wheel = vehicle.wheelInfos[index];
    wheel.frictionSlip = baseFriction * frictionScale * (index >= 2 ? rearGrip : 1);
    wheel.suspensionStiffness = baseStiffness;
  }
  chassisBody.angularDamping = drift ? DRIFT_MODE.angularDamping : 0.42;

  vehicle.setSteeringValue(control.steer, 0);
  vehicle.setSteeringValue(control.steer, 1);
  for (let index = 0; index < vehicle.wheelInfos.length; index += 1) vehicle.setBrake(0, index);
  vehicle.applyEngineForce(0, 2);
  vehicle.applyEngineForce(0, 3);

  // --- drive / reverse by selector ----------------------------------------
  const forwardSpeed = telemetry.signedSpeedKmh;
  const throttle = drift && handbrake ? control.throttle * DRIFT_MODE.throttleHold : control.throttle;
  let engineForce = 0;

  if (control.selector === 'R') {
    // Reverse: throttle drives backwards, the brake pedal still slows the car.
    const reverseFade = clamp(1 - Math.max(-forwardSpeed, 0) / (REVERSE_TOP_SPEED_KMH * 0.9), 0.15, 1);
    engineForce = -config.maxReverseForce * throttle * reverseFade;
  } else if (control.selector === 'D') {
    // Drive: `S` only ever brakes — reverse needs the R position.
    const engineFade = clamp(1 - Math.max(forwardSpeed, 0) / (config.topSpeedKmh * 0.94), config.engineBite, 1);
    engineForce = config.maxForwardForce * throttle * engineFade;
  }
  // P and N: no drive torque at all.

  if (control.selector === 'D' || control.selector === 'R') {
    // Engine braking: off-throttle drag in a gear, so the car does not coast
    // forever and the audio's off-throttle tone has something to describe.
    if (throttle < 0.06 && Math.abs(forwardSpeed) > 1) {
      const direction = forwardSpeed > 0 ? -1 : 1;
      engineForce += direction * config.maxForwardForce * ENGINE_BRAKE_FRACTION * (1 - throttle / 0.06);
    }
  }

  // --- disc brakes: 60/40 split, ABS-modulated per wheel -------------------
  const brakeForce = config.serviceBrakeForce * (config.brakeGain ?? 1) * control.brake;
  const frontBias = park ? BRAKE_RESPONSE.parkFrontBias : (config.brakeBias ?? BRAKE_RESPONSE.frontBias);
  const rearBias = park ? BRAKE_RESPONSE.parkRearBias : 1 - frontBias;
  // cannon's brake is an impulse cap (N·s), so force × step.
  const frontImpulse = (brakeForce * frontBias * step) / 2;
  const rearImpulse = (brakeForce * rearBias * step) / 2;
  const braking = control.brake > 0.01;

  for (let index = 0; index < vehicle.wheelInfos.length; index += 1) {
    const modulation = park ? 1 : control.wheelBrake[index];
    const base = index < 2 ? frontImpulse : rearImpulse;
    vehicle.setBrake(base * modulation, index);
  }

  if (handbrake) {
    // Rear axle only, force × step (see BRAKE_RESPONSE): the front wheels keep
    // rolling so they can still steer, and the rear loses grip above — the tail
    // steps out into a drift instead of the whole car stopping in one frame.
    const handbrakeImpulse = config.handbrakeForce * step;
    vehicle.setBrake(Math.max(rearImpulse * control.wheelBrake[2], handbrakeImpulse), 2);
    vehicle.setBrake(Math.max(rearImpulse * control.wheelBrake[3], handbrakeImpulse), 3);
  }

  vehicle.applyEngineForce(engineForce, 2);
  vehicle.applyEngineForce(engineForce, 3);

  world.step(step, clamp(deltaTime, 0, 0.1), 3);

  // --- anti-lock loop: read what the step did, adjust for the next one -------
  let locked = 0;
  const absArmed = braking && !park && telemetry.speedKmh > BRAKE_RESPONSE.absMinSpeedKmh;
  for (let index = 0; index < vehicle.wheelInfos.length; index += 1) {
    const wheel = vehicle.wheelInfos[index];
    // slipInfo = brake impulse / impulse needed to lock the wheel; cannon leaves
    // it NaN when the wheel is already stopped, which must not disable the brake.
    const slip = Number.isFinite(wheel.slipInfo) ? wheel.slipInfo : 0;
    const wheelLocking = absArmed && wheel.isInContact && slip > BRAKE_RESPONSE.absLockSlip;
    const target = wheelLocking ? BRAKE_RESPONSE.absRelease : 1;
    const rate = (target < control.wheelBrake[index] ? BRAKE_RESPONSE.absDropRate : BRAKE_RESPONSE.absRecoverRate) * step;
    control.wheelBrake[index] = clamp(control.wheelBrake[index] + clamp(target - control.wheelBrake[index], -rate, rate), 0.15, 1);
    if (wheelLocking) {
      locked += 1;
      control.absEvents += 1;
    }
  }
  control.absActive = locked > 0;

  applyRolloverGuard(physics, control, step);

  for (let index = 0; index < vehicle.wheelInfos.length; index += 1) {
    vehicle.updateWheelTransform(index);
  }

  return getVehicleTelemetry(physics);
}

export function resetVehicle(physics, { position = { x: 0, y: 1.02, z: -30 }, yaw = -Math.PI / 2, selector = null } = {}) {
  const { chassisBody, world, vehicle } = physics;
  chassisBody.position.copy(toVector3(position, { x: 0, y: 1.02, z: -30 }));
  chassisBody.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
  chassisBody.velocity.setZero();
  chassisBody.angularVelocity.setZero();
  chassisBody.force.setZero();
  chassisBody.torque.setZero();
  chassisBody.wakeUp();
  chassisBody.aabbNeedsUpdate = true;
  world.broadphase.dirty = true;

  for (let index = 0; index < vehicle.wheelInfos.length; index += 1) {
    vehicle.wheelInfos[index].rotation = 0;
    vehicle.wheelInfos[index].deltaRotation = 0;
    vehicle.updateWheelTransform(index);
  }

  // Actuators back to rest — but the driver's P/R/N/D choice survives a reset,
  // exactly as it does in a real car.
  const control = physics.control;
  if (control) {
    control.steer = 0;
    control.throttle = 0;
    control.brake = 0;
    control.wheelBrake = [1, 1, 1, 1];
    control.absActive = false;
    control.tilt = 0;
    control.upsideDown = 0;
    control.flipped = false;
    control.rollovers = 0;
    control.recoveryAxis = null;
    if (selector && SELECTORS.includes(selector)) control.selector = selector;
  }
}
