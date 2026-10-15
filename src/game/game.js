import * as THREE from 'three';
import { createEngineAudio } from './audio.js';
import { CAR_PRESETS, getCar, getPaint } from './cars/catalog.js';
import { createFallbackCarVisual } from './cars/fallback.js';
import { applyPaint, buildCarRig, disposeCarRig, loadCarAssets, updateWheels } from './cars/loader.js';
import { detectTier, TRACK_TINT } from './config.js';
import { createTyreEffects } from './effects.js';
import { createEnvironment } from './environment.js';
import { engineLoad, shift } from './drivetrain.js';
import { createVehiclePhysics, FIXED_TIME_STEP, getVehicleTelemetry, resetVehicle, resolveVehicleConfig, stepVehicle } from './physics.js';
import { createSceneGraphics } from './scene-graphics.js';
import { createTestCircuitTrack } from './tracks/test-circuit.js';

const HDRI_URLS = {
  desktop: import.meta.env.VITE_HDRI_URL_4K
    || 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/kloppenheim_06_puresky_4k.hdr',
  mobile: import.meta.env.VITE_HDRI_URL_1K
    || 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/kloppenheim_06_puresky_1k.hdr',
  fallback: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/lot_01_2k.hdr',
};

const ASPHALT_INDEX = '/textures/asphalt.index.json';
const TONE_MAPPING = THREE.ACESFilmicToneMapping;

async function fetchJsonOrNull(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function resolveAsphaltTextures(index) {
  if (!index?.files?.length) return null;
  const bySlot = Object.fromEntries(index.files.map((entry) => [entry.slot, entry.file]));
  if (!bySlot.diffuse) return null;
  return {
    diffuse: bySlot.diffuse,
    normal: bySlot.normal ?? null,
    arm: bySlot.arm ?? null,
    credits: index,
  };
}

function createGroundPlane(scene) {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1400, 1400),
    new THREE.MeshStandardMaterial({ color: 0x66735f, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.055;
  ground.receiveShadow = true;
  ground.name = 'world-ground';
  scene.add(ground);
  return ground;
}

/** Per-car drivetrain numbers for the HUD + engine audio. */
export function gearboxFor(carId) {
  const diesel = carId === 'sikandar-suv';
  return {
    idleRpm: diesel ? 750 : 950,
    redlineRpm: diesel ? 5200 : 8600,
    shiftUpRpm: diesel ? 4400 : 7800,
    shiftDownRpm: diesel ? 1800 : 3400,
    finalDrive: diesel ? 3.9 : 3.6,
    ratios: diesel ? [0, 4.1, 2.4, 1.55, 1.15, 0.85, 0.7] : [0, 3.55, 2.31, 1.71, 1.34, 1.09, 0.91, 0.78],
    wheelRadius: 0.38,
  };
}

export function createGame({
  container,
  getInput = () => ({}),
  onTelemetry = () => {},
  onStatus = () => {},
  initialCarId = 'aurora-v12',
  initialTrackId = 'test-circuit-01',
  onReady = () => {},
  onError = () => {},
}) {
  const quality = detectTier();
  const scene = new THREE.Scene();
  const tint = TRACK_TINT[initialTrackId] ?? TRACK_TINT['test-circuit-01'];
  scene.background = new THREE.Color(tint.sky);
  scene.fog = new THREE.Fog(tint.fog, tint.fogNear, tint.fogFar);

  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 900);
  const renderer = new THREE.WebGLRenderer({
    antialias: quality.antialias,
    powerPreference: 'high-performance',
    alpha: false,
  });
  renderer.setPixelRatio(quality.pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = TONE_MAPPING;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.appendChild(renderer.domElement);

  const hemisphere = new THREE.HemisphereLight(0xd7e7ec, 0x394137, quality.mobile ? 1.15 : 1.35);
  scene.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xffe5c2, quality.mobile ? 2.35 : 2.65);
  sun.position.set(-58, 82, 28);
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality.shadows, quality.shadows);
  const shadowExtent = quality.shadowDistance;
  sun.shadow.camera.left = -shadowExtent;
  sun.shadow.camera.right = shadowExtent;
  sun.shadow.camera.top = shadowExtent;
  sun.shadow.camera.bottom = -shadowExtent;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = shadowExtent * 3;
  sun.shadow.bias = -0.00012;
  sun.shadow.normalBias = 0.022;
  sun.shadow.radius = quality.shadowRadius;
  scene.add(sun);
  scene.add(sun.target);

  const ground = createGroundPlane(scene);
  const graphics = createSceneGraphics({ renderer, scene, camera, tier: quality, container });
  const environment = createEnvironment({
    scene,
    renderer,
    tier: quality,
    trackId: initialTrackId,
    hdriUrls: HDRI_URLS,
    onStatus: (status) => onStatus({ environment: status }),
  });

  // --- tracks ---------------------------------------------------------------
  const tracks = new Map();
  let activeTrackId = null;
  let activeTrack = null;

  const physics = createVehiclePhysics({ preset: getCar(initialCarId).physics });
  let carPreset = getCar(initialCarId);
  let paintId = carPreset.paint[0].id;
  // Petrol V12-style vs. turbo-diesel: the HUD needle, gear number and engine
  // note all come from this one definition per car.
  let gearbox = gearboxFor(carPreset.id);
  let rig = null;
  let rigIsFallback = true;
  let rigRequest = 0;

  const audio = createEngineAudio({ carId: carPreset.audioProfile, tier: quality });
  const effects = createTyreEffects(scene, quality);

  // Box-car fallback goes up immediately so the scene is drivable at t=0.
  function mountRig(nextRig) {
    if (rig) {
      rig.group.removeFromParent();
      if (rig !== nextRig) disposeCarRig(rig);
    }
    rig = nextRig;
    rigIsFallback = Boolean(nextRig.fallback);
    scene.add(rig.group);
  }

  mountRig(createFallbackCarVisual({ preset: carPreset, paint: getPaint(carPreset.id, paintId), quality }));

  async function loadRigFor(preset) {
    const request = ++rigRequest;
    try {
      const { gltf, manifest } = await loadCarAssets(preset, {
        onProgress: (event) => onStatus({ loading: { car: preset.id, loaded: event?.loaded, total: event?.total } }),
      });
      if (request !== rigRequest) return null;
      const nextRig = buildCarRig({
        gltf,
        manifest,
        preset,
        paint: getPaint(preset.id, paintId),
        tier: quality,
      });
      if (!nextRig.complete) {
        onStatus({ car: preset.id, warning: `wheel detection incomplete: ${nextRig.problems.join('; ')}` });
      }
      // Align the visual wheel contact to the physics wheel radius so the tyres
      // sit on the road instead of sinking in or floating.
      const physicsRadius = physics.config.wheelRadius;
      if (nextRig.wheels.length === 4) {
        const measured = nextRig.wheels.reduce((sum, wheel) => sum + wheel.radius, 0) / nextRig.wheels.length;
        const raw = measured > 0.05 ? physicsRadius / measured : 1;
        // Clamped: the point is to seat the tyres on the road, not to let a bad
        // measurement stretch the whole car.
        const correction = Math.min(1.25, Math.max(0.8, raw));
        if (Math.abs(correction - 1) > 0.02) {
          nextRig.group.scale.setScalar(correction);
          onStatus({
            car: preset.id,
            scaleCorrection: Number(correction.toFixed(3)),
            ...(Math.abs(raw - correction) > 0.01 ? { scaleCorrectionClamped: Number(raw.toFixed(3)) } : {}),
          });
        }
      }
      mountRig(nextRig);
      onStatus({ car: preset.id, model: 'loaded', wheels: nextRig.wheels.length, triangles: Math.round(nextRig.stats.triangles) });
      return nextRig;
    } catch (error) {
      onStatus({ car: preset.id, model: 'fallback', reason: error?.message ?? String(error) });
      return null;
    }
  }

  function applyTrackVisuals(trackId) {
    const nextTint = TRACK_TINT[trackId] ?? TRACK_TINT['test-circuit-01'];
    scene.background = new THREE.Color(nextTint.sky);
    scene.fog = new THREE.Fog(nextTint.fog, nextTint.fogNear, nextTint.fogFar);
    environment.setTrack(trackId);
    graphics.setTrack(trackId);
  }

  async function selectTrack(trackId) {
    onStatus({ track: trackId, state: 'loading' });
    if (trackId === 'forest-dirt-trail' && !tracks.has('forest-dirt-trail')) {
      try {
        const { createForestDirtTrail } = await import('./tracks/forest-trail.js');
        const forest = await createForestDirtTrail({
          scene,
          physics,
          quality,
          onStatus: (status) => onStatus({ track: trackId, ...status }),
        });
        tracks.set('forest-dirt-trail', forest);
        onStatus({ track: trackId, state: 'ready', stats: forest.stats });
      } catch (error) {
        onStatus({ track: trackId, state: 'error', reason: error?.message ?? String(error) });
        return false;
      }
    }
    if (trackId === 'test-circuit-01' && !tracks.has('test-circuit-01')) {
      const asphalt = await fetchJsonOrNull(ASPHALT_INDEX);
      const circuit = createTestCircuitTrack({
        scene,
        quality,
        roadTextures: resolveAsphaltTextures(asphalt),
      });
      tracks.set('test-circuit-01', circuit);
      onStatus({ track: 'test-circuit-01', state: 'ready', asphalt: Boolean(asphalt?.files?.length) });
    }

    const next = tracks.get(trackId);
    if (!next) return false;
    // Deactivate everything else first: tracks can share a scene group and a
    // collider (Free Roam reuses the forest), so the selected one goes last.
    for (const track of tracks.values()) {
      if (track === next) continue;
      track.setVisible(false);
      track.deactivate?.();
    }
    next.setVisible(true);
    next.activate?.();
    ground.visible = !next.hidesWorldGround;
    activeTrack = next;
    activeTrackId = trackId;
    applyTrackVisuals(trackId);
    reset();
    return true;
  }

  // --- driving state --------------------------------------------------------
  const input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  const cameraOffset = new THREE.Vector3();
  const targetPosition = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const bodyPosition = new THREE.Vector3();
  const bodyQuaternion = new THREE.Quaternion();
  const localLookTarget = new THREE.Vector3(0, 0.62, -3.1);
  let gear = 1;
  let rpm = 900;
  let load = 0;
  let telemetryTime = 0;
  let destroyed = false;
  let lastTime = 0;
  let accumulator = 0;
  let animationFrame = 0;
  let audioUnlocked = false;
  let muted = false;
  let slipEstimate = 0;
  let onTrack = true;

  function spawnFor(track) {
    return track?.spawn ?? { position: { x: 0, y: 1.02, z: -30 }, yaw: -Math.PI / 2 };
  }

  function reset() {
    const spawn = spawnFor(activeTrack);
    resetVehicle(physics, spawn);
    accumulator = 0;
    slipEstimate = 0;
    gear = 1;
    rpm = physics.config ? 900 : 900;
    effects.reset();
    syncVisuals(0);
  }

  function syncVisuals(deltaTime) {
    const body = physics.chassisBody;
    if (!rig) return;
    rig.group.position.set(body.position.x, body.position.y, body.position.z);
    rig.group.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    const steerAngle = physics.vehicle.wheelInfos[0]?.steering ?? 0;
    updateWheels(rig, { wheelInfos: physics.vehicle.wheelInfos, steerAngle });
    graphics.updateContactShadow(physics, {
      length: rig.bounds?.size?.z ?? 4.5,
      width: rig.bounds?.size?.x ?? 1.9,
    });
    void deltaTime;
  }

  function updateCamera(deltaTime, speedKmh) {
    const body = physics.chassisBody;
    const speedRatio = Math.min(speedKmh / (physics.config.topSpeedKmh * 1.1), 1);
    bodyPosition.set(body.position.x, body.position.y, body.position.z);
    bodyQuaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    cameraOffset.set(0, 4.8 + speedRatio * 1.1, 9.1 + speedRatio * 2.1);
    cameraOffset.applyQuaternion(bodyQuaternion);
    targetPosition.copy(bodyPosition).add(cameraOffset);
    const smoothing = 1 - Math.exp(-5.2 * Math.max(deltaTime, FIXED_TIME_STEP));
    camera.position.lerp(targetPosition, smoothing);

    lookTarget.copy(localLookTarget).applyQuaternion(bodyQuaternion).add(bodyPosition);
    camera.lookAt(lookTarget);

    const targetFov = 58 + speedRatio * 9;
    if (Math.abs(camera.fov - targetFov) > 0.1) {
      camera.fov += (targetFov - camera.fov) * smoothing;
      camera.updateProjectionMatrix();
    }

    // Keep the shadow frustum centred on the car so a 2048 map stays dense.
    sun.position.set(body.position.x - 58, body.position.y + 82, body.position.z + 28);
    sun.target.position.set(body.position.x, body.position.y, body.position.z);
    sun.target.updateMatrixWorld();
  }

  function estimateSlip() {
    const body = physics.chassisBody;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w),
    );
    const velocity = new THREE.Vector3(body.velocity.x, body.velocity.y, body.velocity.z);
    const speed = velocity.length();
    if (speed < 1) return 0;
    const lateral = Math.abs(velocity.clone().projectOnPlane(new THREE.Vector3(0, 1, 0)).cross(forward).y);
    const sliding = physics.vehicle.wheelInfos.filter((wheel) => wheel.sliding).length;
    const slip = Math.min(1, lateral / Math.max(2, speed) + sliding * 0.22);
    slipEstimate += (slip - slipEstimate) * 0.2;
    return slipEstimate;
  }

  function updateSurface() {
    if (!activeTrack) return;
    const body = physics.chassisBody;
    onTrack = activeTrack.bounds ? activeTrack.bounds.isOnTrack(body.position.x, body.position.z) : true;
    const surface = activeTrack.surface ?? null;
    if (surface) {
      // Grip is scaled once, from the surface preset, then again when the car
      // leaves the marked track — on asphalt off-track grip is barely lower,
      // on dirt leaving the road costs a lot of traction.
      const offTrackScale = onTrack ? 1 : (surface.offTrackGrip ?? 0.75);
      physics.surface.frictionScale = (surface.frictionScale ?? 1) * offTrackScale;
      physics.surface.suspensionScale = surface.suspensionScale ?? 1;
      physics.surface.grip = onTrack ? (surface.grip ?? 1) : (surface.grip ?? 1) * offTrackScale;
    }
    physics.groundHeight = activeTrack.groundHeightAt
      ? activeTrack.groundHeightAt(body.position.x, body.position.z)
      : 0;
  }

  function frame(timestamp) {
    if (destroyed) return;
    animationFrame = window.requestAnimationFrame(frame);
    const deltaTime = lastTime ? Math.min((timestamp - lastTime) / 1000, 0.1) : FIXED_TIME_STEP;
    lastTime = timestamp;
    if (document.hidden) {
      accumulator = 0;
      return;
    }

    const rawInput = getInput();
    input.throttle = Number(rawInput.throttle) || 0;
    input.brake = Number(rawInput.brake) || 0;
    input.steer = Number(rawInput.steer) || 0;
    input.handbrake = Boolean(rawInput.handbrake);

    accumulator += deltaTime;
    let steps = 0;
    while (accumulator >= FIXED_TIME_STEP && steps < 6) {
      updateSurface();
      stepVehicle(physics, input, FIXED_TIME_STEP);
      activeTrack?.update?.(FIXED_TIME_STEP, physics);
      accumulator -= FIXED_TIME_STEP;
      steps += 1;
    }
    if (steps === 6) accumulator = 0;

    const telemetry = getVehicleTelemetry(physics);
    gearbox.wheelRadius = physics.config.wheelRadius;
    const shiftState = shift({ speedKmh: telemetry.signedSpeedKmh, gear, throttle: input.throttle, gearbox });
    gear = shiftState.gear;
    rpm = shiftState.rpm;
    load = engineLoad({ rpm, throttle: input.throttle, gearbox });

    const slip = estimateSlip();
    effects.update({
      physics,
      surface: activeTrack?.surface ?? {},
      onTrack,
      input,
      speedKmh: telemetry.speedKmh,
      deltaTime,
      slipAmount: slip,
    });

    syncVisuals(deltaTime);
    updateCamera(deltaTime, telemetry.speedKmh);
    audio.update({ rpm, load, speedKmh: telemetry.speedKmh, slip, muted });
    graphics.render(deltaTime);

    telemetryTime += deltaTime;
    if (telemetryTime >= 0.1) {
      onTelemetry({
        ...telemetry,
        gear,
        rpm,
        load,
        onTrack,
        surface: activeTrack?.surface?.id ?? 'asphalt',
        carId: carPreset.id,
        trackId: activeTrackId,
      }, input);
      telemetryTime = 0;
    }
  }

  const resize = () => {
    const width = Math.max(container.clientWidth, window.innerWidth, 1);
    const height = Math.max(container.clientHeight, window.innerHeight, 1);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    graphics.resize(width, height);
  };
  resize();
  window.addEventListener('resize', resize, { passive: true });

  const api = {
    quality,
    get carId() {
      return carPreset.id;
    },
    get trackId() {
      return activeTrackId;
    },
    get paintId() {
      return paintId;
    },
    get isFallbackCar() {
      return rigIsFallback;
    },
    get telemetry() {
      return { ...getVehicleTelemetry(physics), gear, rpm, load, onTrack, slip: slipEstimate };
    },
    cars: CAR_PRESETS,
    async init() {
      try {
        await selectTrack(initialTrackId);
      } catch (error) {
        onStatus({ track: initialTrackId, state: 'error', reason: error?.message ?? String(error) });
      }
      loadRigFor(carPreset);
      onReady({ quality, car: carPreset.id, track: activeTrackId });
      animationFrame = window.requestAnimationFrame(frame);
      return api;
    },
    selectCar(carId, { paint = null } = {}) {
      const next = getCar(carId);
      if (next.id === carPreset.id && !paint) return;
      carPreset = next;
      if (paint) paintId = paint;
      else paintId = next.paint[0].id;

      rigRequest += 1;
      mountRig(createFallbackCarVisual({ preset: next, paint: getPaint(next.id, paintId), quality }));
      reset();

      // Swap the car by re-resolving the same preset object the physics module
      // builds its world from, so a car change and a fresh spawn are identical.
      const resolved = resolveVehicleConfig(next.physics);
      physics.config = resolved;
      physics.preset = next.physics;
      gearbox = gearboxFor(next.id);
      physics.chassisBody.mass = resolved.mass;
      physics.chassisBody.updateMassProperties();
      for (const wheel of physics.vehicle.wheelInfos) {
        wheel.radius = resolved.wheelRadius;
        wheel.frictionSlip = resolved.frictionSlip;
        const suspension = resolved.suspension ?? {};
        wheel.suspensionStiffness = suspension.suspensionStiffness ?? wheel.suspensionStiffness;
        wheel.suspensionRestLength = suspension.suspensionRestLength ?? wheel.suspensionRestLength;
        wheel.dampingRelaxation = suspension.dampingRelaxation ?? wheel.dampingRelaxation;
        wheel.dampingCompression = suspension.dampingCompression ?? wheel.dampingCompression;
        wheel.maxSuspensionTravel = suspension.maxSuspensionTravel ?? wheel.maxSuspensionTravel;
        wheel.rollInfluence = suspension.rollInfluence ?? wheel.rollInfluence;
      }
      audio.setCar(next.audioProfile);
      loadRigFor(next);
      onStatus({ car: next.id, state: 'selected' });
    },
    selectPaint(nextPaintId) {
      paintId = nextPaintId;
      if (rig && !rigIsFallback) applyPaint(rig, getPaint(carPreset.id, paintId));
      else if (rig) {
        mountRig(createFallbackCarVisual({ preset: carPreset, paint: getPaint(carPreset.id, paintId), quality }));
      }
    },
    selectTrack,
    reset,
    async unlockAudio() {
      if (audioUnlocked) return true;
      audioUnlocked = await audio.unlock();
      return audioUnlocked;
    },
    toggleMute() {
      muted = !muted;
      return muted;
    },
    get muted() {
      return muted;
    },
    destroy() {
      destroyed = true;
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', resize);
      effects.dispose();
      audio.dispose();
      for (const track of tracks.values()) track.dispose();
      graphics.dispose();
      environment.dispose();
      disposeCarRig(rig);
      scene.traverse((object) => {
        if (!object.isMesh && !object.isInstancedMesh) return;
        object.geometry?.dispose();
      });
      ground.geometry.dispose();
      ground.material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };

  return api;
}
