import * as THREE from 'three';

/**
 * Camera suite: chase, orbit free-look and cockpit, cycled with C (desktop) or
 * the CAM button (touch).
 *
 *   chase    low and close behind the car, speed-sensitive FOV, a lateral
 *            offset that opens up the inside of a corner, and terrain-aware
 *            framing (camera stays above the ground, the look point follows
 *            the slope ahead, so crests and dips read on the horizon).
 *   orbit    free-look around the parked car (only below 5 km/h): drag to
 *            rotate 360°, scroll / pinch to zoom. Dragging the view while the
 *            car is parked enters it; driving off hands back to the previous
 *            camera.
 *   cockpit  the driver-head anchor from the car manifest (see cars/cockpit.js).
 *
 * The director never touches physics: it reads the chassis pose it is given.
 */

export const CAMERA_MODES = Object.freeze(['chase', 'orbit', 'cockpit']);
/** Orbit free-look is a parked-car camera. */
export const ORBIT_MAX_KMH = 5;

const MIN_ORBIT_DISTANCE = 3.2;
const MAX_ORBIT_DISTANCE = 16;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const ease = (t) => t * t * (3 - 2 * t);

/** Pure chase framing (exported for tests): offsets in the car's heading frame. */
export function chaseFraming({ speedKmh = 0, topSpeedKmh = 165, yawRate = 0, carLength = 4.5, carHeight = 1.2 }) {
  const speedRatio = clamp(speedKmh / (topSpeedKmh * 1.05), 0, 1);
  return {
    distance: carLength * 1.18 + 1 + speedRatio * 1.3,
    height: carHeight * 0.95 + 0.9 + speedRatio * 0.3,
    // Turning left (positive yaw rate) moves the camera to the outside (+X).
    lateral: clamp(-yawRate * 0.55, -0.85, 0.85),
    fov: 60 + 14 * ease(speedRatio),
    lookAhead: 4.2 + speedRatio * 2,
  };
}

export function createCameraDirector({ camera, element }) {
  let mode = 'chase';
  let drivingMode = 'chase';
  let speedKmh = 0;
  let primed = false;
  const listeners = new Set();

  const chasePosition = new THREE.Vector3();
  const lookPoint = new THREE.Vector3();
  const targetPosition = new THREE.Vector3();
  const heading = new THREE.Quaternion();
  const forward = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const carPosition = new THREE.Vector3();
  const carQuaternion = new THREE.Quaternion();
  const orbitTarget = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  let lateral = 0;
  let lookSlope = 0;
  const orbit = { yaw: 0, pitch: 0.3, distance: 8, targetDistance: 8 };

  const pointers = new Map();
  let pinch = null;

  function emit() {
    for (const listener of listeners) listener(mode);
  }

  function setNear(near) {
    if (camera.near !== near) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }
  }

  function enterOrbitFromCamera() {
    tmp.copy(camera.position).sub(orbitTarget);
    const distance = clamp(tmp.length(), MIN_ORBIT_DISTANCE, MAX_ORBIT_DISTANCE);
    orbit.yaw = Math.atan2(tmp.x, tmp.z);
    orbit.pitch = clamp(Math.asin(clamp(tmp.y / (tmp.length() || 1), -1, 1)), -0.05, 1.3);
    orbit.distance = distance;
    orbit.targetDistance = distance;
  }

  function setMode(next) {
    if (!CAMERA_MODES.includes(next) || next === mode) return mode;
    if (next === 'orbit') {
      if (speedKmh >= ORBIT_MAX_KMH) return mode;
      drivingMode = mode;
      enterOrbitFromCamera();
    } else {
      drivingMode = next;
    }
    if (mode === 'cockpit' || next === 'chase') primed = false;
    mode = next;
    emit();
    return mode;
  }

  const pointerDistance = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (speedKmh >= ORBIT_MAX_KMH) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    element.setPointerCapture?.(event.pointerId);
    if (mode !== 'orbit') setMode('orbit');
    if (pointers.size === 2) pinch = { distance: pointerDistance(), start: orbit.targetDistance };
  };
  const onPointerMove = (event) => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer || mode !== 'orbit') return;
    if (pointers.size === 1) {
      orbit.yaw -= (event.clientX - pointer.x) * 0.0085;
      orbit.pitch = clamp(orbit.pitch + (event.clientY - pointer.y) * 0.006, -0.05, 1.3);
    }
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (pointers.size === 2 && pinch?.distance) {
      orbit.targetDistance = clamp(pinch.start * (pinch.distance / Math.max(1, pointerDistance())), MIN_ORBIT_DISTANCE, MAX_ORBIT_DISTANCE);
    }
  };
  const onPointerEnd = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
  };
  const onWheel = (event) => {
    if (speedKmh >= ORBIT_MAX_KMH) return;
    event.preventDefault();
    if (mode !== 'orbit') setMode('orbit');
    orbit.targetDistance = clamp(orbit.targetDistance * Math.exp(event.deltaY * 0.0012), MIN_ORBIT_DISTANCE, MAX_ORBIT_DISTANCE);
  };

  element?.addEventListener('pointerdown', onPointerDown);
  element?.addEventListener('pointermove', onPointerMove);
  element?.addEventListener('pointerup', onPointerEnd);
  element?.addEventListener('pointercancel', onPointerEnd);
  element?.addEventListener('wheel', onWheel, { passive: false });

  return {
    get mode() {
      return mode;
    },
    get orbitAvailable() {
      return speedKmh < ORBIT_MAX_KMH;
    },
    /** C key / CAM button: chase → orbit (parked only) → cockpit → chase. */
    cycle() {
      const order = speedKmh < ORBIT_MAX_KMH ? ['chase', 'orbit', 'cockpit'] : ['chase', 'cockpit'];
      const index = order.indexOf(mode === 'orbit' && !order.includes('orbit') ? drivingMode : mode);
      return setMode(order[(index + 1) % order.length]);
    },
    setMode,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Next chase frame jumps straight behind the car (resets, track swaps). */
    snap() {
      primed = false;
    },
    /**
     * @param {object} params
     * @param {number} params.deltaTime
     * @param {{x:number,y:number,z:number}} params.position chassis position
     * @param {{x:number,y:number,z:number,w:number}} params.quaternion chassis orientation
     * @param {{x:number,y:number,z:number}} params.velocity chassis velocity (m/s)
     * @param {number} params.speedKmh
     * @param {number} params.topSpeedKmh
     * @param {number} params.yawRate chassis angular velocity about world Y (rad/s)
     * @param {number} params.steerAngle front wheel steer angle (rad, + = left)
     * @param {{x:number,y:number,z:number}} params.carSize width/height/length (m)
     * @param {THREE.Object3D|null} params.carGroup rig group (cockpit anchor space)
     * @param {THREE.Vector3|null} params.cockpitHead driver head, rig-group space
     * @param {(x:number, z:number) => number} [params.groundHeightAt]
     */
    update({
      deltaTime,
      position,
      quaternion,
      velocity,
      speedKmh: currentSpeed = 0,
      topSpeedKmh = 165,
      yawRate = 0,
      steerAngle = 0,
      carSize = { x: 1.9, y: 1.2, z: 4.5 },
      carGroup = null,
      cockpitHead = null,
      groundHeightAt = null,
    }) {
      speedKmh = currentSpeed;
      const dt = Math.max(deltaTime, 1 / 120);
      carPosition.set(position.x, position.y, position.z);
      carQuaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
      orbitTarget.copy(carPosition).addScaledVector(UP, carSize.y * 0.42);

      // Orbit is a parked camera: driving off hands back (with a little hysteresis).
      if (mode === 'orbit' && speedKmh > ORBIT_MAX_KMH + 1) {
        mode = drivingMode === 'orbit' ? 'chase' : drivingMode;
        primed = false;
        pointers.clear();
        emit();
      }

      // Heading: chassis yaw only (no suspension pitch / roll), leaning towards
      // the velocity direction in a slide so a drift reads from behind.
      forward.set(0, 0, -1).applyQuaternion(carQuaternion).setY(0);
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      forward.normalize();
      let headingYaw = Math.atan2(-forward.x, -forward.z);
      const planarSpeed = Math.hypot(velocity?.x ?? 0, velocity?.z ?? 0);
      if (planarSpeed > 5) {
        const travelYaw = Math.atan2(-(velocity.x), -(velocity.z));
        let delta = travelYaw - headingYaw;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        // Only blend while moving forwards (reversing keeps the camera behind).
        if (Math.abs(delta) < Math.PI / 2) headingYaw += delta * clamp((planarSpeed - 5) / 20, 0, 0.35);
      }
      heading.setFromAxisAngle(UP, headingYaw);

      if (mode === 'cockpit' && carGroup && cockpitHead) {
        setNear(0.03);
        carGroup.updateMatrixWorld();
        camera.position.copy(cockpitHead).applyMatrix4(carGroup.matrixWorld);
        // Look down the road with a slight dip, and a touch into the turn.
        tmp.set(Math.sin(steerAngle * 0.3) * -1, -0.06, -1).normalize().applyQuaternion(carQuaternion);
        lookPoint.copy(camera.position).addScaledVector(tmp, 10);
        camera.up.copy(UP).applyQuaternion(carQuaternion);
        camera.lookAt(lookPoint);
        const fov = 70 + 6 * clamp(speedKmh / topSpeedKmh, 0, 1);
        if (Math.abs(camera.fov - fov) > 0.05) {
          camera.fov += (fov - camera.fov) * (1 - Math.exp(-6 * dt));
          camera.updateProjectionMatrix();
        }
        return;
      }

      camera.up.copy(UP);
      setNear(0.1);

      if (mode === 'orbit') {
        orbit.distance += (orbit.targetDistance - orbit.distance) * (1 - Math.exp(-10 * dt));
        offset.set(
          Math.sin(orbit.yaw) * Math.cos(orbit.pitch),
          Math.sin(orbit.pitch),
          Math.cos(orbit.yaw) * Math.cos(orbit.pitch),
        ).multiplyScalar(orbit.distance);
        camera.position.copy(orbitTarget).add(offset);
        if (groundHeightAt) {
          camera.position.y = Math.max(camera.position.y, groundHeightAt(camera.position.x, camera.position.z) + 0.35);
        }
        camera.lookAt(orbitTarget);
        if (Math.abs(camera.fov - 55) > 0.05) {
          camera.fov += (55 - camera.fov) * (1 - Math.exp(-6 * dt));
          camera.updateProjectionMatrix();
        }
        return;
      }

      // --- chase -------------------------------------------------------------
      const framing = chaseFraming({ speedKmh, topSpeedKmh, yawRate, carLength: carSize.z, carHeight: carSize.y });
      lateral += (framing.lateral - lateral) * (1 - Math.exp(-3 * dt));
      offset.set(lateral, framing.height, framing.distance).applyQuaternion(heading);
      targetPosition.copy(carPosition).add(offset);

      let slopeTarget = 0;
      if (groundHeightAt) {
        // Never dip into a rise behind the car, and aim at the ground ahead so
        // the horizon follows the trail's undulation.
        const clearance = groundHeightAt(targetPosition.x, targetPosition.z) + 0.9;
        if (targetPosition.y < clearance) targetPosition.y = clearance;
        const ahead = 18;
        const groundHere = groundHeightAt(carPosition.x, carPosition.z);
        const groundAhead = groundHeightAt(carPosition.x + forward.x * ahead, carPosition.z + forward.z * ahead);
        if (Number.isFinite(groundHere) && Number.isFinite(groundAhead)) slopeTarget = clamp(groundAhead - groundHere, -6, 6);
      }
      lookSlope += (slopeTarget - lookSlope) * (1 - Math.exp(-2.5 * dt));

      if (!primed) {
        chasePosition.copy(targetPosition);
        primed = true;
      } else {
        chasePosition.lerp(targetPosition, 1 - Math.exp(-7 * dt));
      }
      camera.position.copy(chasePosition);
      lookPoint.set(-lateral * 0.6, carSize.y * 0.55, -framing.lookAhead).applyQuaternion(heading).add(carPosition);
      lookPoint.y += lookSlope * 0.35;
      camera.lookAt(lookPoint);
      if (Math.abs(camera.fov - framing.fov) > 0.05) {
        camera.fov += (framing.fov - camera.fov) * (1 - Math.exp(-4 * dt));
        camera.updateProjectionMatrix();
      }
    },
    dispose() {
      element?.removeEventListener('pointerdown', onPointerDown);
      element?.removeEventListener('pointermove', onPointerMove);
      element?.removeEventListener('pointerup', onPointerEnd);
      element?.removeEventListener('pointercancel', onPointerEnd);
      element?.removeEventListener('wheel', onWheel);
      listeners.clear();
      pointers.clear();
    },
  };
}
