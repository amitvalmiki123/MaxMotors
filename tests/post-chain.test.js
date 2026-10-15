import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createPostProcessing } from '../src/game/graphics.js';

/**
 * The post chain is assembled from dynamically imported three.js passes, so this
 * test drives it with a renderer stub: the composer only asks the renderer for a
 * pixel ratio and a size while it is being built. What matters here is the ORDER
 * — SSAOPass multiplies its occlusion over the read buffer and does not swap, so
 * a chain that starts with it renders the blurred occlusion buffer instead of
 * the scene (a washed-out frame on desktop, the bug this guards).
 */

/** Minimal renderer stub — enough for EffectComposer construction. */
function rendererStub(onRender = () => {}) {
  const size = new THREE.Vector2(1280, 720);
  return {
    getPixelRatio: () => 1,
    getSize: (target = size) => target.set(size.x, size.y),
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    render: onRender,
  };
}

async function buildChain(tier, renderer = rendererStub()) {
  const api = createPostProcessing({
    renderer,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    tier,
  });
  for (let attempt = 0; attempt < 200 && !api.ready && api.enabled; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return api;
}

const DESKTOP = { postprocessing: true, ssao: true, bloom: true, vignette: true };

test('the beauty pass renders first and SSAO multiplies over it', async () => {
  const api = await buildChain(DESKTOP);
  assert.equal(api.ready, true);
  assert.deepEqual(api.chain, ['RenderPass', 'SSAOPass', 'UnrealBloomPass', 'ShaderPass', 'OutputPass']);
  assert.equal(api.chain[0], 'RenderPass', 'SSAOPass must never be the first pass');
});

test('the chain drops SSAO, bloom and vignette when the tier disables them', async () => {
  const api = await buildChain({ postprocessing: true, ssao: false, bloom: false, vignette: false });
  assert.deepEqual(api.chain, ['RenderPass', 'OutputPass']);
});

test('a tier without post-processing renders directly and reports no chain', async () => {
  let direct = 0;
  const renderer = rendererStub(() => { direct += 1; });
  const api = await buildChain({ postprocessing: false }, renderer);
  assert.equal(api.enabled, false);
  assert.deepEqual(api.chain, []);
  api.render(1 / 60);
  assert.equal(direct, 1);
});
