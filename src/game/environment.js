import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { horizonRadiance } from './fog.js';

/**
 * Environment: Poly Haven CC0 outdoor HDRI (4K desktop / 1K mobile) with a
 * generated fallback so the scene still lights up offline. Sky colour and fog
 * follow the active track so the forest reads as a different place.
 */

const PRESETS = {
  'test-circuit-01': { skyTint: 0xffffff, exposure: 1.12, intensity: 0.72, backgroundBlur: 0.08 },
  'forest-dirt-trail': { skyTint: 0xd8e7c8, exposure: 1.02, intensity: 0.6, backgroundBlur: 0.05 },
};

function createFallbackTexture(trackId) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  if (trackId === 'forest-dirt-trail') {
    gradient.addColorStop(0, '#6d8a74');
    gradient.addColorStop(0.45, '#c3cfa8');
    gradient.addColorStop(0.55, '#a9b183');
    gradient.addColorStop(1, '#41512f');
  } else {
    gradient.addColorStop(0, '#637f8b');
    gradient.addColorStop(0.48, '#c4c0a8');
    gradient.addColorStop(0.52, '#d0b996');
    gradient.addColorStop(1, '#56654f');
  }
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(255, 235, 190, 0.85)';
  context.beginPath();
  context.arc(720, 172, 46, 0, Math.PI * 2);
  context.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  return texture;
}

export function createEnvironment({ scene, renderer, tier, trackId = 'test-circuit-01', hdriUrls, onStatus = () => {}, onHorizon = () => {} }) {
  const preset = PRESETS[trackId] ?? PRESETS['test-circuit-01'];
  let fallback = createFallbackTexture(trackId);
  let horizon = null;

  /** Horizon radiance of whatever sky is showing; the game matches its fog to it. */
  const measureHorizon = (texture) => {
    try {
      const image = texture?.image;
      if (image?.data && image.width) {
        horizon = horizonRadiance(image);
      } else if (image?.getContext) {
        const { data } = image.getContext('2d').getImageData(0, 0, image.width, image.height);
        horizon = horizonRadiance({ data, width: image.width, height: image.height }, { encoding: 'srgb8' });
      }
    } catch {
      horizon = null;
    }
    onHorizon(horizon);
  };
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  let currentTrack = trackId;
  let environmentTarget = null;
  let hdriTexture = null;
  let disposed = false;

  const applyFallback = (reason = 'generated') => {
    scene.background = fallback;
    scene.environment = fallback;
    scene.backgroundBlurriness = 0.08;
    scene.environmentIntensity = preset.intensity;
    measureHorizon(fallback);
    onStatus({ source: reason, hdri: false });
  };

  applyFallback('pending');

  const url = hdriUrls?.[tier?.hdriTier ?? 'desktop'] ?? hdriUrls?.desktop;
  const loader = new RGBELoader().setDataType(THREE.HalfFloatType);
  if (url) {
    loader.load(url, (texture) => {
      if (disposed) {
        texture.dispose();
        return;
      }
      texture.mapping = THREE.EquirectangularReflectionMapping;
      environmentTarget?.dispose();
      hdriTexture?.dispose();
      environmentTarget = pmremGenerator.fromEquirectangular(texture);
      hdriTexture = texture;
      scene.environment = environmentTarget.texture;
      scene.background = texture;
      scene.backgroundBlurriness = preset.backgroundBlur;
      scene.environmentIntensity = preset.intensity;
      renderer.toneMappingExposure = (PRESETS[currentTrack] ?? preset).exposure;
      scene.backgroundBlurriness = (PRESETS[currentTrack] ?? preset).backgroundBlur;
      scene.environmentIntensity = (PRESETS[currentTrack] ?? preset).intensity;
      measureHorizon(texture);
      onStatus({ source: 'polyhaven', hdri: true, resolution: `${texture.image?.width ?? '?'}x${texture.image?.height ?? '?'}` });
    }, undefined, (error) => {
      if (disposed) return;
      console.info('Poly Haven HDRI unavailable; using the generated environment fallback.', error?.message ?? error);
      applyFallback('fallback');
    });
  }

  return {
    get source() {
      return hdriTexture ? 'hdri' : 'fallback';
    },
    /** Linear horizon radiance of the current sky (null until measured). */
    get horizon() {
      return horizon;
    },
    setTrack(nextTrackId) {
      currentTrack = nextTrackId;
      const next = PRESETS[nextTrackId] ?? PRESETS['test-circuit-01'];
      scene.environmentIntensity = next.intensity;
      renderer.toneMappingExposure = next.exposure;
      scene.backgroundBlurriness = next.backgroundBlur;
      if (hdriTexture) {
        // Keep the HDRI sky: track switches used to leave a flat colour here.
        scene.background = hdriTexture;
        scene.environment = environmentTarget.texture;
        measureHorizon(hdriTexture);
      } else {
        fallback.dispose();
        fallback = createFallbackTexture(nextTrackId);
        scene.background = fallback;
        scene.environment = fallback;
        measureHorizon(fallback);
      }
    },
    dispose() {
      disposed = true;
      pmremGenerator.dispose();
      environmentTarget?.dispose();
      hdriTexture?.dispose();
      fallback.dispose();
    },
  };
}
