import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js';

/**
 * Post-processing chain: SSAO → bloom → vignette → output.
 *
 * Desktop only by design (see `src/game/config.js`): SSAO is the single most
 * expensive effect in the chain and mobile stays on the direct render path, so a
 * phone never pays for it. ACES tone mapping is preserved by `OutputPass`, which
 * applies the renderer's tone mapping and colour space after the chain.
 */
export function createPostProcessing({ renderer, scene, camera, tier }) {
  if (!tier?.postprocessing) {
    return {
      enabled: false,
      render() {
        renderer.render(scene, camera);
      },
      setSize() {},
      dispose() {},
    };
  }

  const size = renderer.getSize(new THREE.Vector2());
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());

  let ssaoPass = null;
  if (tier.ssao) {
    ssaoPass = new SSAOPass(scene, camera, size.x, size.y);
    ssaoPass.kernelRadius = 0.9;
    ssaoPass.minDistance = 0.0015;
    ssaoPass.maxDistance = 0.08;
    ssaoPass.output = SSAOPass.OUTPUT.Default;
    composer.addPass(ssaoPass);
  } else {
    composer.addPass(new RenderPass(scene, camera));
  }

  let bloomPass = null;
  if (tier.bloom) {
    bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.34, 0.55, 0.82);
    composer.addPass(bloomPass);
  }

  let vignettePass = null;
  if (tier.vignette) {
    // The lens vignette is deliberately gentler than the CSS overlay so bloom
    // highlights near the edges are not crushed twice.
    vignettePass = new ShaderPass(VignetteShader);
    vignettePass.uniforms.offset.value = 1.05;
    vignettePass.uniforms.darkness.value = 1.15;
    composer.addPass(vignettePass);
  }

  composer.addPass(new OutputPass());

  return {
    enabled: true,
    composer,
    render(deltaTime) {
      void deltaTime;
      composer.render();
    },
    setSize(width, height) {
      composer.setSize(width, height);
      ssaoPass?.setSize?.(width, height);
      bloomPass?.setSize?.(width, height);
    },
    setTrack() {
      /* bloom/vignette are track independent */
    },
    dispose() {
      composer.dispose?.();
      ssaoPass?.dispose?.();
      bloomPass?.dispose?.();
      vignettePass?.dispose?.();
    },
  };
}
