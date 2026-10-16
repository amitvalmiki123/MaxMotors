import * as THREE from 'three';

/**
 * Camera suite: chase, orbit free-look and cockpit, cycled with C (desktop) or
 * the CAM button (touch).
 *
 *   chase    low and close behind the car, speed-sensitive FOV, a lateral
 *            offset that opens up the inside of a corner, and terrain-aware
 *            framing (camera stays above the ground, the look point follows
 *            the slope ahead, so crests and dips read on the horizon).
 *   orbit    free-look around the car: drag to rotate 360°, scroll / pinch to
 *            zoom. Dragging the view enters it from wherever the camera was.
 *   cockpit  the driver-head anchor from the car manifest (see cars/cockpit.js).
 *
 * M2.6: orbit is no longer a parked-car camera. It used to refuse to engage
 * above 5 km/h and to hand control back the moment the car rolled, so a driver
 * could never walk around the car they were actually driving. It now works at
 * any speed, and — the important half — the chosen angle is **locked to the
 * car**: the drag sets an angle *relative to the car's heading*, so a three-
 * quarter front view stays a three-quarter front view through a corner instead
 * of the car driving out of frame and the camera ending up behind a hedge.
 *
 * The director never touches physics: it reads the chassis pose it is given.
 */

export const CAMERA_MODES = Object.freeze(['chase', 'orbit', 'cockpit']);
/**
 * Orbit is available at any speed now (M2.6). The constant survives as the
 * speed below which orbit engages *without* smoothing its first frame, so a
 * parked walk-around still starts exactly where the camera was.
 */
export const ORBIT_MAX_KMH = Infinity;
/** Below this speed the orbit target snaps; above it, it is smoothed. */
const ORBIT_SNAP_KMH = 5;

const MIN_ORBIT_DISTANCE = 3.2;
const MAX_ORBIT_DISTANCE = 16;
const ORBIT_MIN_PITCH = -0.12;
const ORBIT_MAX_PITCH = 1.35;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const ease = (t) => t * t * (3 - 2 * t);

/** Wrap an angle into (-π, π] so a heading difference never accumulates. */
export function wrapAngle(angle) {
  const twoPi = Math.PI * 2;
  let wrapped = angle % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  if (wrapped <= -Math.PI) wrapped += twoPi;
  return wrapped;
}

/** Pure chase framing (exported for tests): offsets in the car's heading frame. */
export function chaseFraming({ speedKmh = 0, topSpeedKmh = 165, yawRate = 0, carLength = 4.5, carHeight = 1.2 }) {
  const speedRatio = clamp(speedKmh / (topSpeedKmh * 1.05), 0, 1);
  return {
    distance: carLength * 1.18 + 1 + speedRatio * 1.3,
    height: carHeight * 0.95 + 0.9 + speedRatio * 0.3,
    // Turning left (positive yaw rate about +Y) puts the outside of the corner
    // on the car's right (+X in its heading frame), so the camera leans out
    // there and the inside of the corner opens up past the car. The sign was
    // inverted in M2, which leaned the camera into the corner it was meant to
    // show — i.e. straight at the barrier the driver is about to hit.
    lateral: clamp(yawRate * 0.55, -0.85, 0.85),
    fov: 60 + 14 * ease(speedRatio),
    lookAhead: 4.2 + speedRatio * 2,
  };
}

/**
 * Orbit camera position from an angle measured *relative to the car heading*.
 *
 * `relativeYaw = 0` is straight behind the car, `±π` straight in front; pitch
 * is elevation above the car's centre. Exported (pure) so the heading lock can
 * be unit-tested without a WebGL context.
 */
export function orbitOffset({ relativeYaw, pitch, distance, headingYaw }) {
  const yaw = headingYaw + relativeYaw;
  const cosPitch = Math.cos(pitch);
  return {
    x: Math.sin(yaw) * cosPitch * distance,
    y: Math.sin(pitch) * distance,
    z: Math.cos(yaw) * cosPitch * distance,
    yaw,
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
  const smoothOrbitTarget = new THREE.Vector3();
  const planarVelocity = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  let lateral = 0;
  let lookSlope = 0;
  let headingYaw = 0;
  let orbitPrimed = false;
  /**
   * The orbit angle the driver chose, stored **relative to the car's heading**.
   * Every frame it is added to the current heading, which is what keeps the
   * framing locked to the car as it turns.
   */
  const orbit = {
    relativeYaw: 0,
    pitch: 0.3,
    distance: 8,
    targetDistance: 8,
  };

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

  /** Takes the current camera→car vector and expresses it in the car's frame. */
  function enterOrbitFromCamera() {
    tmp.copy(camera.position).sub(orbitTarget);
    const length = tmp.length() || 1;
    const distance = clamp(length, MIN_ORBIT_DISTANCE, MAX_ORBIT_DISTANCE);
    const worldYaw = Math.atan2(tmp.x, tmp.z);
    orbit.relativeYaw = wrapAngle(worldYaw - headingYaw);
    orbit.pitch = clamp(Math.asin(clamp(tmp.y / length, -1, 1)), ORBIT_MIN_PITCH, ORBIT_MAX_PITCH);
    orbit.distance = distance;
    orbit.targetDistance = distance;
    smoothOrbitTarget.copy(orbitTarget);
    orbitPrimed = true;
  }

  function setMode(next) {
    if (!CAMERA_MODES.includes(next) || next === mode) return mode;
    if (next === 'orbit') {
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
    // No speed gate: orbit engages while driving too (M2.6).
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    element.setPointerCapture?.(event.pointerId);
    if (mode !== 'orbit') setMode('orbit');
    if (pointers.size === 2) pinch = { distance: pointerDistance(), start: orbit.targetDistance };
  };
  const onPointerMove = (event) => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer || mode !== 'orbit') return;
    if (pointers.size === 1) {
      // Dragging changes the *relative* angle, so the choice survives the turn.
      orbit.relativeYaw = wrapAngle(orbit.relativeYaw - (event.clientX - pointer.x) * 0.0085);
      orbit.pitch = clamp(orbit.pitch + (event.clientY - pointer.y) * 0.006, ORBIT_MIN_PITCH, ORBIT_MAX_PITCH);
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
    /** Orbit is always available now; kept for callers that still ask. */
    get orbitAvailable() {
      return true;
    },
    /** The chosen orbit angle, relative to the car's heading (radians). */
    get orbitYaw() {
      return orbit.relativeYaw;
    },
    get orbitPitch() {
      return orbit.pitch;
    },
    get orbitDistance() {
      return orbit.distance;
    },
    /** C key / CAM button: chase → orbit → cockpit → chase, at any speed. */
    cycle() {
      const order = ['chase', 'orbit', 'cockpit'];
      const index = order.indexOf(mode);
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
      orbitPrimed = false;
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

      // Heading: chassis yaw only (no suspension pitch / roll), leaning towards
      // the velocity direction in a slide so a drift reads from behind.
      forward.set(0, 0, -1).applyQuaternion(carQuaternion).setY(0);
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      forward.normalize();
      headingYaw = Math.atan2(-forward.x, -forward.z);
      planarVelocity.set(velocity?.x ?? 0, 0, velocity?.z ?? 0);
      const planarSpeed = planarVelocity.length();
      if (planarSpeed > 5) {
        const travelYaw = Math.atan2(-(velocity.x), -(velocity.z));
        const delta = wrapAngle(travelYaw - headingYaw);
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
        // The chosen angle is relative to the heading, so the camera swings with
        // the car: a corner keeps the same three-quarter view instead of the car
        // rotating out of it.
        orbit.distance += (orbit.targetDistance - orbit.distance) * (1 - Math.exp(-10 * dt));
        const placed = orbitOffset({
          relativeYaw: orbit.relativeYaw,
          pitch: orbit.pitch,
          distance: orbit.distance,
          headingYaw,
        });
        offset.set(placed.x, placed.y, placed.z);
        if (!orbitPrimed || speedKmh < ORBIT_SNAP_KMH) {
          smoothOrbitTarget.copy(orbitTarget);
          orbitPrimed = true;
        } else {
          // In the plane the target follows the car exactly. Smoothing X/Z would
          // leave the camera trailing: on a straight that is a constant lag, and
          // in a corner the lag grows with the centripetal acceleration, so the
          // framing drifts off the car precisely where the driver is looking at
          // it. What actually jitters is the *vertical* axis — the chassis
          // bounces on its suspension — so only that is filtered.
          smoothOrbitTarget.x = orbitTarget.x;
          smoothOrbitTarget.z = orbitTarget.z;
          smoothOrbitTarget.y += (orbitTarget.y - smoothOrbitTarget.y) * (1 - Math.exp(-14 * dt));
        }
        camera.position.copy(smoothOrbitTarget).add(offset);
        if (groundHeightAt) {
          camera.position.y = Math.max(camera.position.y, groundHeightAt(camera.position.x, camera.position.z) + 0.35);
        }
        camera.lookAt(smoothOrbitTarget);
        // A slightly wider FOV as the car speeds up keeps it framed at distance.
        const fov = 55 + 8 * ease(clamp(speedKmh / topSpeedKmh, 0, 1));
        if (Math.abs(camera.fov - fov) > 0.05) {
          camera.fov += (fov - camera.fov) * (1 - Math.exp(-6 * dt));
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
