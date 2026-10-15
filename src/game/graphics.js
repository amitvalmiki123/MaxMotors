import * as THREE from 'three';

/**
 * Post-processing chain: beauty → SSAO → bloom → vignette → output.
 *
 * Desktop only by design (see `src/game/config.js`): SSAO is the single most
 * expensive effect in the chain and mobile stays on the direct render path, so a
 * phone never pays for it. ACES tone mapping is preserved by `OutputPass`, which
 * applies the renderer's tone mapping and colour space after the chain. The
 * renderer itself stays on the direct path until the chain is ready, so the
 * passes are imported on demand.
 */
export function createPostProcessing({ renderer, scene, camera, tier }) {
  if (!tier?.postprocessing) {
    return {
      enabled: false,
      chain: [],
      render() {
        renderer.render(scene, camera);
      },
      setSize() {},
      dispose() {},
    };
  }

  const size = renderer.getSize(new THREE.Vector2());
  let composer = null;
  let ssaoPass = null;
  let bloomPass = null;
  let vignettePass = null;
  let width = size.x;
  let height = size.y;

  // The composer and the effect passes are a sizeable slice of the bundle, so
  // they are imported on demand: the first frames render directly and the chain
  // takes over once it is ready (desktop only, see config.js). Every module is
  // loaded through `Promise.all` — module namespaces are not iterable, so they
  // must never be destructured out of a single `import()`.
  Promise.all([
    import('three/examples/jsm/postprocessing/EffectComposer.js'),
    import('three/examples/jsm/postprocessing/RenderPass.js'),
    import('three/examples/jsm/postprocessing/UnrealBloomPass.js'),
    import('three/examples/jsm/shaders/VignetteShader.js'),
    import('three/examples/jsm/postprocessing/ShaderPass.js'),
    import('three/examples/jsm/postprocessing/OutputPass.js'),
    import('three/examples/jsm/postprocessing/SSAOPass.js'),
  ])
    .then(([composerModule, renderPassModule, bloomModule, vignetteModule, shaderPassModule, outputModule, ssaoModule]) => {
      const nextComposer = new composerModule.EffectComposer(renderer);
      nextComposer.setPixelRatio(renderer.getPixelRatio());

      // The beauty pass comes first and always runs.
      nextComposer.addPass(new renderPassModule.RenderPass(scene, camera));

      if (tier.ssao) {
        // SSAOPass multiplies its occlusion over the frame that is already in the
        // read buffer (`needsSwap = false`, DstColor/Zero blending). It must
        // therefore be added right *after* the beauty pass — it cannot replace
        // it: without a RenderPass in front, the multiply darkens an empty
        // (black, gaussian-blurred) buffer and the whole scene washes out.
        ssaoPass = new ssaoModule.SSAOPass(scene, camera, width, height);
        ssaoPass.kernelRadius = 0.9;
        ssaoPass.minDistance = 0.0015;
        ssaoPass.maxDistance = 0.08;
        ssaoPass.output = ssaoModule.SSAOPass.OUTPUT.Default;
        nextComposer.addPass(ssaoPass);
      }

      if (tier.bloom) {
        bloomPass = new bloomModule.UnrealBloomPass(new THREE.Vector2(width, height), 0.34, 0.55, 0.82);
        nextComposer.addPass(bloomPass);
      }

      if (tier.vignette) {
        vignettePass = new shaderPassModule.ShaderPass(vignetteModule.VignetteShader);
        vignettePass.uniforms.offset.value = 1.05;
        vignettePass.uniforms.darkness.value = 1.15;
        nextComposer.addPass(vignettePass);
      }

      nextComposer.addPass(new outputModule.OutputPass());
      nextComposer.setSize(width, height);
      composer = nextComposer;
    })
    .catch((error) => {
      console.info('Post-processing unavailable; rendering directly.', error?.message ?? error);
    });

  return {
    enabled: true,
    get ready() {
      return Boolean(composer);
    },
    /** Pass class names in render order — diagnostics, and asserted in tests. */
    get chain() {
      return composer ? composer.passes.map((pass) => pass.constructor.name) : [];
    },
    render(deltaTime) {
      void deltaTime;
      if (composer) composer.render();
      else renderer.render(scene, camera);
    },
    setSize(nextWidth, nextHeight) {
      width = nextWidth;
      height = nextHeight;
      composer?.setSize(width, height);
      ssaoPass?.setSize?.(width, height);
      bloomPass?.setSize?.(width, height);
    },
    setTrack() {
      /* bloom/vignette are track independent */
    },
    dispose() {
      composer?.dispose?.();
      ssaoPass?.dispose?.();
      bloomPass?.dispose?.();
      vignettePass?.dispose?.();
      composer = null;
    },
  };
}
