/**
 * Quality tiers.
 *
 * Everything the M2 brief flags as "PC-only" is decided here and nowhere else:
 * post-processing, HDRI resolution, shadow map size, anisotropic filtering and
 * the particle/skid budgets. `?quality=low|high` overrides detection so a phone
 * can be tested against the desktop profile without a rebuild.
 */

const MOBILE_MAX_WIDTH = 820;

function readOverride(search) {
  try {
    const params = new URLSearchParams(search ?? '');
    const quality = params.get('quality');
    if (quality === 'low' || quality === 'medium' || quality === 'high') return quality;
  } catch {
    /* no URL access (tests) */
  }
  return null;
}

export function detectTier(environment = {}) {
  const win = environment.window ?? (typeof window === 'undefined' ? null : window);
  const matches = (query) => {
    try {
      return win?.matchMedia?.(query)?.matches ?? false;
    } catch {
      return false;
    }
  };
  const coarsePointer = matches('(pointer: coarse)');
  const smallViewport = (win?.innerWidth ?? 1280) < MOBILE_MAX_WIDTH;
  const lowMemory = (win?.navigator?.deviceMemory ?? win?.navigator?.deviceMemory ?? 8) <= 4;
  const override = readOverride(win?.location?.search);
  const mobile = override ? override !== 'high' : coarsePointer || smallViewport;
  const low = override === 'low' || (mobile && lowMemory);

  return {
    id: low ? 'low' : mobile ? 'mobile' : 'desktop',
    mobile,
    low,
    antialias: !mobile,
    pixelRatio: Math.min(win?.devicePixelRatio ?? 1, mobile ? 1.5 : 2),
    shadows: mobile ? 1024 : 2048,
    shadowRadius: mobile ? 2 : 3,
    shadowDistance: mobile ? 64 : 112,
    /** Post-processing (bloom + SSAO + vignette) is desktop-only by design. */
    postprocessing: !mobile,
    bloom: !mobile,
    ssao: !mobile,
    vignette: !mobile,
    contactShadow: true,
    hdriTier: mobile ? 'mobile' : 'desktop',
    environmentIntensity: mobile ? 0.55 : 0.72,
    anisotropy: mobile ? 2 : 8,
    dustParticles: !low,
    dustParticleCount: low ? 120 : 320,
    skidMarks: !low,
    skidMarkBudget: low ? 240 : 900,
    maxInstances: mobile ? 900 : 2400,
    textureBudgetMB: mobile ? 150 : 512,
  };
}

/**
 * Per-track fog presets (used for track switching).
 *
 * `fog` / `sky` are the offline fallbacks: at runtime the fog colour is measured
 * from the sky's horizon (see fog.js) and then **brightness capped** by `fogCap`.
 *
 * M2.6 circuit re-tune. The M2 numbers (near 145 / far 420) were tuned against a
 * sun-inflated near-white fog colour, so they only ever looked "right" by
 * washing the distance out. With the sun now excluded from the estimate the same
 * distances read as a hard grey band starting just past the far corner, so the
 * ramp is stretched: nothing happens inside 90 m (the car, the kerbs and the
 * corner exits stay crisp), the scenery picks up gentle aerial perspective
 * through the 100–300 m range, and the 1400 m ground plane's horizon is fully
 * dissolved by 620 m instead of standing out as an edge. `fogCap` is a little
 * higher here than in the forest — an open bright day should haze towards light
 * sky, not towards grey.
 */
export const TRACK_TINT = Object.freeze({
  'test-circuit-01': { fog: 0x8d9da6, sky: 0xaebbb4, fogNear: 90, fogFar: 620, fogCap: 0.6 },
  // Forest: exponential-squared fog (FOREST_FOG_DENSITY in fog.js) whose colour
  // is measured from the sky's horizon at runtime; `fog` is the offline fallback.
  'forest-dirt-trail': { fog: 0x8fa3a0, sky: 0x8ea184, fogNear: 60, fogFar: 300, fogDensity: 0.0058, fogCap: 0.48 },
  // Free Roam shares the forest sky and terrain, but the whole map is in play:
  // the fog is a touch thinner so the far hills read as distance, not as mist.
  'forest-free-roam': { fog: 0x8fa3a0, sky: 0x8ea184, fogNear: 60, fogFar: 340, fogDensity: 0.0048, fogCap: 0.46 },
});
