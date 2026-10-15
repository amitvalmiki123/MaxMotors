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

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function toVector3(value, fallback) {
  if (Array.isArray(value)) {
    return new CANNON.Vec3(value[0] ?? fallback.x, value[1] ?? fallback.y, value[2] ?? fallback.z);
  }
  return new CANNON.Vec3(value?.x ?? fallback.x, value?.y ?? fallback.y, value?.z ?? fallback.z);
}

export function createVehiclePhysics({
  position = { x: 0, y: 1.02, z: -30 },
  yaw = -Math.PI / 2,
} = {}) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = false;
  world.solver.iterations = 10;
  world.solver.tolerance = 0.001;
  world.defaultContactMaterial.friction = 0.75;
  world.defaultContactMaterial.restitution = 0;

  const roadMaterial = new CANNON.Material('road');
  const vehicleMaterial = new CANNON.Material('vehicle');
  world.addContactMaterial(new CANNON.ContactMaterial(roadMaterial, vehicleMaterial, {
    friction: 0.72,
    restitution: 0,
    contactEquationStiffness: 1e7,
    contactEquationRelaxation: 3,
  }));

  const groundBody = new CANNON.Body({ mass: 0, material: roadMaterial });
  groundBody.addShape(new CANNON.Plane());
  groundBody.position.set(0, -0.04, 0);
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(groundBody);

  const chassisBody = new CANNON.Body({
    mass: VEHICLE_CONFIG.mass,
    material: vehicleMaterial,
    position: toVector3(position, { x: 0, y: 1.02, z: -30 }),
    linearDamping: 0.035,
    angularDamping: 0.42,
    allowSleep: false,
  });
  chassisBody.addShape(new CANNON.Box(new CANNON.Vec3(0.91, 0.36, 1.72)));
  chassisBody.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
  world.addBody(chassisBody);

  const vehicle = new CANNON.RaycastVehicle({
    chassisBody,
    indexRightAxis: 0,
    indexUpAxis: 1,
    indexForwardAxis: 2,
  });

  const wheelOptions = {
    radius: VEHICLE_CONFIG.wheelRadius,
    directionLocal: new CANNON.Vec3(0, -1, 0),
    axleLocal: new CANNON.Vec3(-1, 0, 0),
    suspensionStiffness: 34,
    suspensionRestLength: 0.32,
    frictionSlip: 5.2,
    dampingRelaxation: 2.4,
    dampingCompression: 4.6,
    maxSuspensionForce: 100000,
    rollInfluence: 0.035,
    maxSuspensionTravel: 0.28,
    customSlidingRotationalSpeed: -30,
    useCustomSlidingRotationalSpeed: true,
  };

  const wheelPositions = [
    { x: -0.9, y: -0.18, z: -1.14, front: true },
    { x: 0.9, y: -0.18, z: -1.14, front: true },
    { x: -0.9, y: -0.18, z: 1.14, front: false },
    { x: 0.9, y: -0.18, z: 1.14, front: false },
  ];

  for (const point of wheelPositions) {
    vehicle.addWheel({
      ...wheelOptions,
      chassisConnectionPointLocal: new CANNON.Vec3(point.x, point.y, point.z),
      isFrontWheel: point.front,
    });
  }

  vehicle.addToWorld(world);

  return { world, groundBody, chassisBody, vehicle };
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
  const speedRatio = clamp(telemetry.speedKmh / 180, 0, 1);
  const steeringLimit = 0.48 - speedRatio * 0.23;
  const steerValue = -input.steer * steeringLimit;

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
    const engineFade = clamp(1 - Math.max(forwardSpeed, 0) / 165, 0.12, 1);
    engineForce = VEHICLE_CONFIG.maxForwardForce * input.throttle * engineFade;
  } else if (input.brake > 0) {
    if (Math.abs(forwardSpeed) > 1.4) {
      frontBrake = VEHICLE_CONFIG.serviceBrakeForce * input.brake;
      rearBrake = VEHICLE_CONFIG.serviceBrakeForce * input.brake;
    } else {
      engineForce = -VEHICLE_CONFIG.maxReverseForce * input.brake;
    }
  }

  if (input.handbrake) {
    rearBrake = Math.max(rearBrake, VEHICLE_CONFIG.handbrakeForce);
    frontBrake = Math.max(frontBrake, 900);
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
