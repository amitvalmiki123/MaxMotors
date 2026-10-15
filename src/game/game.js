import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { createCarVisual, syncCarVisual } from './car-visual.js';
import { createVehiclePhysics, FIXED_TIME_STEP, getVehicleTelemetry, resetVehicle, stepVehicle } from './physics.js';
import { createTrack } from './track.js';

const SPAWN = Object.freeze({ position: { x: 0, y: 1.02, z: -30 }, yaw: -Math.PI / 2 });
const HDRI_URL = import.meta.env.VITE_HDRI_URL
  || 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/lot_01_1k.hdr';

function createFallbackEnvironment(scene) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  const sky = context.createLinearGradient(0, 0, 0, canvas.height);
  sky.addColorStop(0, '#637f8b');
  sky.addColorStop(0.48, '#c4c0a8');
  sky.addColorStop(0.52, '#d0b996');
  sky.addColorStop(1, '#56654f');
  context.fillStyle = sky;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(255, 235, 190, 0.9)';
  context.beginPath();
  context.arc(720, 180, 52, 0, Math.PI * 2);
  context.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = texture;
  scene.environment = texture;
  scene.backgroundBlurriness = 0.1;
  return texture;
}

function loadEnvironment(scene, renderer, onError) {
  const loader = new RGBELoader().setDataType(THREE.HalfFloatType);
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();
  let environmentTarget = null;
  let hdriTexture = null;
  let isDisposed = false;

  loader.load(HDRI_URL, (texture) => {
    if (isDisposed) {
      texture.dispose();
      pmremGenerator.dispose();
      return;
    }
    texture.mapping = THREE.EquirectangularReflectionMapping;
    environmentTarget = pmremGenerator.fromEquirectangular(texture);
    hdriTexture = texture;
    scene.environment = environmentTarget.texture;
    scene.background = texture;
    scene.backgroundBlurriness = 0.08;
    scene.environmentIntensity = 0.72;
    pmremGenerator.dispose();
  }, undefined, (error) => {
    pmremGenerator.dispose();
    if (isDisposed) return;
    console.info('Poly Haven HDRI unavailable; using the generated environment fallback.', error);
    onError();
  });

  return {
    dispose() {
      isDisposed = true;
      environmentTarget?.dispose();
      hdriTexture?.dispose();
    },
  };
}

function addGround(scene) {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(500, 500),
    new THREE.MeshStandardMaterial({ color: 0x66735f, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.055;
  ground.receiveShadow = true;
  scene.add(ground);
  return ground;
}

export function createGame({ container, onTelemetry = () => {}, getInput = () => ({}) }) {
  const isMobile = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 760;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xaebbb4);
  scene.fog = new THREE.Fog(0x9daaa2, 145, 420);

  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 700);
  const renderer = new THREE.WebGLRenderer({
    antialias: !isMobile,
    powerPreference: 'high-performance',
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.appendChild(renderer.domElement);

  const hemisphere = new THREE.HemisphereLight(0xd7e7ec, 0x394137, 1.35);
  scene.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xffe5c2, 2.65);
  sun.position.set(-58, 82, 28);
  sun.castShadow = true;
  sun.shadow.mapSize.set(isMobile ? 1024 : 2048, isMobile ? 1024 : 2048);
  sun.shadow.camera.left = -92;
  sun.shadow.camera.right = 92;
  sun.shadow.camera.top = 92;
  sun.shadow.camera.bottom = -92;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 220;
  sun.shadow.bias = -0.00012;
  sun.shadow.normalBias = 0.022;
  sun.shadow.radius = isMobile ? 2 : 3;
  scene.add(sun);

  addGround(scene);
  createTrack(scene);
  const physics = createVehiclePhysics(SPAWN);
  const carVisual = createCarVisual(scene);
  syncCarVisual(carVisual, physics);

  const fallbackEnvironment = createFallbackEnvironment(scene);
  const environment = loadEnvironment(scene, renderer, () => {
    scene.background = fallbackEnvironment;
    scene.environment = fallbackEnvironment;
  });

  const resize = () => {
    const width = Math.max(container.clientWidth, window.innerWidth, 1);
    const height = Math.max(container.clientHeight, window.innerHeight, 1);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };
  resize();
  window.addEventListener('resize', resize, { passive: true });

  const targetPosition = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const cameraOffset = new THREE.Vector3();
  const localLookTarget = new THREE.Vector3(0, 0.62, -3.1);
  const bodyPosition = new THREE.Vector3();
  const bodyQuaternion = new THREE.Quaternion();
  function updateCamera(deltaTime, speedKmh) {
    const body = physics.chassisBody;
    const speedRatio = Math.min(speedKmh / 180, 1);
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
  }

  updateCamera(1, 0);
  camera.position.copy(targetPosition);

  let animationFrame = 0;
  let lastFrameTime = 0;
  let lastRenderTime = 0;
  let accumulator = 0;
  let telemetryTime = 0;
  let destroyed = false;

  const animate = (timestamp) => {
    if (destroyed) return;
    animationFrame = window.requestAnimationFrame(animate);
    if (lastRenderTime && timestamp - lastRenderTime < 1000 / 60 - 0.5) return;

    const deltaTime = lastFrameTime ? Math.min((timestamp - lastFrameTime) / 1000, 0.1) : FIXED_TIME_STEP;
    lastFrameTime = timestamp;
    lastRenderTime = timestamp;
    if (document.hidden) {
      accumulator = 0;
      return;
    }

    accumulator += deltaTime;
    const input = getInput();
    let steps = 0;
    while (accumulator >= FIXED_TIME_STEP && steps < 6) {
      stepVehicle(physics, input, FIXED_TIME_STEP);
      accumulator -= FIXED_TIME_STEP;
      steps += 1;
    }
    if (steps === 6) accumulator = 0;

    const telemetry = getVehicleTelemetry(physics);
    syncCarVisual(carVisual, physics);
    updateCamera(deltaTime, telemetry.speedKmh);
    renderer.render(scene, camera);

    telemetryTime += deltaTime;
    if (telemetryTime >= 0.1) {
      onTelemetry(telemetry, input);
      telemetryTime = 0;
    }
  };

  animationFrame = window.requestAnimationFrame(animate);

  return {
    reset() {
      resetVehicle(physics, SPAWN);
      accumulator = 0;
      syncCarVisual(carVisual, physics);
    },
    destroy() {
      destroyed = true;
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', resize);
      environment.dispose();
      fallbackEnvironment.dispose();
      scene.traverse((object) => {
        if (!object.isMesh && !object.isInstancedMesh) return;
        object.geometry?.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => {
          if (!material) return;
          Object.values(material).forEach((value) => {
            if (value?.isTexture && value !== fallbackEnvironment) value.dispose();
          });
          material.dispose();
        });
      });
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
