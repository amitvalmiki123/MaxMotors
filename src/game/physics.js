import * as CANNON from 'cannon-es';
import { normalizeInput } from './input.js';

export const FIXED_TIME_STEP = 1 / 60;
export const VEHICLE_CONFIG = Object.freeze({
  mass: 1180,
  wheelRadius: 0.38,
  maxForwardForce: 2050,
  maxReverseForce: 1150,
  serviceBrakeForce: 8500,
  handbrakeForce: 11500,
});

/**
 * Rear-axle grip multiplier while the handbrake (SPACE) is held, so a handbrake
 * turn actually rotates the car into a slide. Nothing else changes: off the
 * handbrake every wheel keeps the M1/M2 grip.
 */
export const HANDBRAKE_REAR_GRIP = 0.6;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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
    return { ...VEHICLE_CONFIG, suspension: null, steering: null, halfExtents: null, wheelAnchors: null, engineBite: 0.12, topSpeedKmh: 165 };
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
  };
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

export function stepVehicle(physics, rawInput = {}, deltaTime = FIXED_TIME_STEP) {
  const input = normalizeInput(rawInput);
  const { chassisBody, vehicle, world } = physics;
  const telemetry = getVehicleTelemetry(physics);
  const config = physics.config;
  const surface = physics.surface;
  const steering = config.steering;
  const limitSpeed = steering?.limitSpeedKmh ?? 180;
  const speedRatio = clamp(telemetry.speedKmh / limitSpeed, 0, 1);
  const steeringLimit = (steering?.maxSteer ?? 0.48) - speedRatio * (steering?.steerFalloff ?? 0.23);
  const steerValue = -input.steer * steeringLimit;

  // Surface grip is applied per wheel each step; on asphalt this is a no-op.
  const frictionScale = surface?.frictionScale ?? 1;
  const suspensionScale = surface?.suspensionScale ?? 1;
  const baseFriction = config.frictionSlip;
  const baseStiffness = (config.suspension?.suspensionStiffness ?? 34) * suspensionScale;
  const rearGrip = input.handbrake ? HANDBRAKE_REAR_GRIP : 1;
  for (let index = 0; index < vehicle.wheelInfos.length; index += 1) {
    const wheel = vehicle.wheelInfos[index];
    wheel.frictionSlip = baseFriction * frictionScale * (index >= 2 ? rearGrip : 1);
    wheel.suspensionStiffness = baseStiffness;
  }

  vehicle.setSteeringValue(steerValue, 0);
  vehicle.setSteeringValue(steerValue, 1);
  vehicle.applyEngineForce(0, 2);
  vehicle.applyEngineForce(0, 3);
  for (let index = 0; index < vehicle.wheelInfos.length; index += 1) {
    vehicle.setBrake(0, index);
  }

  const forwardSpeed = telemetry.signedSpeedKmh;
  let engineForce = 0;
  let frontBrake = 0;
  let rearBrake = 0;

  if (input.throttle > input.brake) {
    const engineFade = clamp(1 - Math.max(forwardSpeed, 0) / (config.topSpeedKmh * 0.94), config.engineBite, 1);
    engineForce = config.maxForwardForce * input.throttle * engineFade;
  } else if (input.brake > 0) {
    if (Math.abs(forwardSpeed) > 1.4) {
      frontBrake = config.serviceBrakeForce * input.brake;
      rearBrake = config.serviceBrakeForce * input.brake;
    } else {
      engineForce = -config.maxReverseForce * input.brake;
    }
  }

  if (input.handbrake) {
    // cannon-es reads `brake` as a per-step impulse cap (N·s), not a force: the
    // raw handbrake value stopped the car from 60 km/h in ONE step and pitched
    // the rear wheels off the ground, so no grip setting could ever slide it.
    // While SPACE is held the handbrake is applied as force × step on the rear
    // axle only (front wheels keep rolling so they can steer), and the rear
    // loses some grip (HANDBRAKE_REAR_GRIP): the tail steps out into a drift.
    rearBrake = Math.max(rearBrake, config.handbrakeForce * FIXED_TIME_STEP);
  }

  vehicle.applyEngineForce(engineForce, 2);
  vehicle.applyEngineForce(engineForce, 3);
  vehicle.setBrake(frontBrake, 0);
  vehicle.setBrake(frontBrake, 1);
  vehicle.setBrake(rearBrake, 2);
  vehicle.setBrake(rearBrake, 3);

  world.step(FIXED_TIME_STEP, clamp(deltaTime, 0, 0.1), 3);
  for (let index = 0; index < vehicle.wheelInfos.length; index += 1) {
    vehicle.updateWheelTransform(index);
  }

  return getVehicleTelemetry(physics);
}

export function resetVehicle(physics, { position = { x: 0, y: 1.02, z: -30 }, yaw = -Math.PI / 2 } = {}) {
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
}
