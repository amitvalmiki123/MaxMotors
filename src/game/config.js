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

/** Blend two colour values through the scene fog (used for track switching). */
export const TRACK_TINT = Object.freeze({
  'test-circuit-01': { fog: 0x9daaa2, sky: 0xaebbb4, fogNear: 145, fogFar: 420 },
  // Forest: exponential-squared fog (FOREST_FOG_DENSITY in fog.js) whose colour
  // is measured from the sky's horizon at runtime; `fog` is the offline fallback.
  'forest-dirt-trail': { fog: 0x9fb0b4, sky: 0x8ea184, fogNear: 60, fogFar: 300, fogDensity: 0.0058 },
});
