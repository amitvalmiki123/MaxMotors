/**
 * Distance fog matched to the sky (M2.5 step 4, corrected in M2.6).
 *
 * The fog colour is measured from the environment itself — the radiance of a
 * thin band around the horizon of the equirectangular HDRI (or of the generated
 * fallback sky) — so distant terrain dissolves into exactly the colour of the
 * sky behind it. That aerial perspective is what makes the forest read in depth.
 *
 * M2.6: the first version averaged the whole horizon band. A clear-sky HDRI has
 * the sun sitting right on that band (kloppenheim_06_puresky puts it a few
 * degrees up), and a handful of sun pixels at 10⁴–10⁶ nits outvote ~10⁵ sky
 * pixels by orders of magnitude. The mean came back near-white and *above* the
 * bloom threshold, so the whole distance hazed out white and then glowed. The
 * estimator is therefore a **trimmed, sun-rejecting** one:
 *
 *   1. take the median luminance of the band (robust: the sun is a tiny
 *      fraction of the samples, so the median is pure sky);
 *   2. drop every sample brighter than `SUN_REJECT_RATIO × median` — the sun
 *      disc and its immediate bloom halo;
 *   3. also trim a fixed fraction off both ends of the luminance distribution,
 *      so a cloud edge or a bright ground bounce cannot pull the colour up;
 *   4. average what is left.
 *
 * The result is then **brightness capped** (`capFogBrightness`): fog is a
 * distance cue, not a light source, and on the post-processing path it is
 * applied in linear HDR *before* OutputPass, so any fog above the bloom
 * threshold makes the horizon glow. Both are unit-tested in tests/fog.test.js.
 *
 * three.js mixes fog at different points depending on the render path:
 *   - post-processing (desktop): in linear HDR, *before* OutputPass tone maps
 *     the frame, so the fog colour is the raw horizon radiance;
 *   - direct rendering (mobile): *after* tone mapping, in output space, so the
 *     fog colour must be the horizon radiance already tone-mapped (ACES).
 * Pure functions, no WebGL — unit-tested in tests/fog.test.js.
 */

/** Exponential-squared density for the forest: ~8% at 50 m, ~30% at 100 m, ~76% at 200 m. */
export const FOREST_FOG_DENSITY = 0.0058;
/** Fraction of the image height (above and below the horizon row) that is sampled. */
export const HORIZON_BAND = 0.012;
/** Samples brighter than this multiple of the band median are the sun (disc + halo). */
export const SUN_REJECT_RATIO = 1.6;
/**
 * Fraction trimmed from each end of the band's luminance distribution. 12% off
 * the top also catches a bright cloud base sitting on the horizon; 12% off the
 * bottom stops a dark tree line dragging the haze towards grey-green.
 */
export const HORIZON_TRIM = 0.12;
/**
 * Maximum luminance (linear, relative) the fog colour may reach.
 *
 * The desktop chain blooms above `UnrealBloomPass` threshold 0.82, and a fog
 * colour near white turns the whole distance into a glowing sheet. 0.55 keeps
 * haze well under that on the HDR path while still reading as bright sky.
 */
export const MAX_FOG_LUMINANCE = 0.55;
/** Maximum luminance for the tone-mapped (mobile/direct) path, in output space. */
export const MAX_FOG_LUMINANCE_OUTPUT = 0.78;

function halfToFloat(value) {
  const exponent = (value & 0x7c00) >> 10;
  const fraction = value & 0x03ff;
  const sign = value & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

const srgbToLinear = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

/** Rec.709 relative luminance of a linear RGB triple. */
export function luminance([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** In-place median of a Float64Array view (quickselect-free: the bands are small). */
function medianOf(values) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Linear radiance of the horizon band of an equirectangular image.
 *
 * @param {{data: ArrayLike<number>, width: number, height: number}} image
 *        Float32Array / Uint16Array (half floats) hold linear radiance;
 *        Uint8 data is treated as sRGB (the canvas fallback sky).
 * @param {object} [options]
 * @param {number} [options.band] fraction of the image height sampled around the middle row
 * @param {'trimmed'|'median'|'mean'} [options.estimator]
 * @param {number} [options.sunRejectRatio] drop samples brighter than this × median
 * @param {number} [options.trim] fraction trimmed from each end of the luminance range
 * @param {number|null} [options.cap] maximum luminance of the result (null = no cap)
 * @returns {[number, number, number]} linear RGB
 */
export function horizonRadiance(image, {
  band = HORIZON_BAND,
  encoding = null,
  estimator = 'trimmed',
  sunRejectRatio = SUN_REJECT_RATIO,
  trim = HORIZON_TRIM,
  cap = MAX_FOG_LUMINANCE,
} = {}) {
  const { data, width, height } = image;
  const channels = Math.max(1, Math.round(data.length / (width * height)));
  const kind = encoding ?? (data instanceof Uint16Array ? 'half' : data instanceof Float32Array ? 'float' : 'srgb8');
  const half = Math.max(1, Math.round(height * band));
  const middle = Math.floor(height / 2);

  const samples = [];
  for (let row = middle - half; row < middle + half; row += 1) {
    if (row < 0 || row >= height) continue;
    for (let column = 0; column < width; column += 1) {
      const offset = (row * width + column) * channels;
      const pixel = [0, 0, 0];
      let valid = true;
      for (let channel = 0; channel < 3; channel += 1) {
        const raw = data[offset + channel];
        const value = kind === 'half' ? halfToFloat(raw) : kind === 'float' ? raw : srgbToLinear((raw ?? 0) / 255);
        if (!Number.isFinite(value) || value < 0) {
          valid = false;
          break;
        }
        pixel[channel] = value;
      }
      if (valid) samples.push(pixel);
    }
  }
  if (!samples.length) return [0, 0, 0];

  if (estimator === 'mean') {
    const sum = [0, 0, 0];
    for (const pixel of samples) for (let channel = 0; channel < 3; channel += 1) sum[channel] += pixel[channel];
    return capFogBrightness(sum.map((value) => value / samples.length), cap);
  }

  const luma = Float64Array.from(samples, luminance);
  const median = medianOf(luma);
  if (estimator === 'median') {
    // The single sample closest to the median luminance keeps its own hue.
    let best = samples[0];
    let bestError = Infinity;
    for (const [index, pixel] of samples.entries()) {
      const error = Math.abs(luma[index] - median);
      if (error < bestError) {
        bestError = error;
        best = pixel;
      }
    }
    return capFogBrightness(best.slice(0, 3), cap);
  }

  // --- trimmed, sun-rejecting mean (default) -------------------------------
  const threshold = median > 1e-9 ? median * sunRejectRatio : Infinity;
  const order = [...samples.keys()].sort((a, b) => luma[a] - luma[b]);
  const trimCount = Math.floor(order.length * trim);
  const kept = order.slice(trimCount, order.length - trimCount).filter((index) => luma[index] <= threshold);
  const pool = kept.length ? kept : order.filter((index) => luma[index] <= threshold);
  const used = pool.length ? pool : order;

  const sum = [0, 0, 0];
  for (const index of used) for (let channel = 0; channel < 3; channel += 1) sum[channel] += samples[index][channel];
  return capFogBrightness(sum.map((value) => value / used.length), cap);
}

/**
 * Scales a colour down (never up) so its luminance stays under `cap`.
 *
 * Capping by scaling rather than by clamping each channel keeps the sky's hue:
 * clamping a bright warm horizon would push it towards white, which is exactly
 * the haze this module is trying to avoid.
 *
 * @param {[number, number, number]} rgb linear (or output-space) colour
 * @param {number|null} cap maximum luminance; `null` disables the cap
 * @returns {[number, number, number]}
 */
export function capFogBrightness(rgb, cap = MAX_FOG_LUMINANCE) {
  const color = [rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0].map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0));
  if (cap === null || cap === undefined || !(cap > 0)) return color;
  const luma = luminance(color);
  if (!(luma > cap)) return color;
  const scale = cap / luma;
  return color.map((value) => value * scale);
}

/** three.js' ACESFilmicToneMapping, ported (same matrices, same exposure scale). */
export function acesFilmic([r, g, b], exposure = 1) {
  const scale = exposure / 0.6;
  const x = [r * scale, g * scale, b * scale];
  const input = [
    0.59719 * x[0] + 0.35458 * x[1] + 0.04823 * x[2],
    0.076 * x[0] + 0.90834 * x[1] + 0.01566 * x[2],
    0.0284 * x[0] + 0.13383 * x[1] + 0.83777 * x[2],
  ];
  const fit = input.map((v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081));
  const output = [
    1.60475 * fit[0] - 0.53108 * fit[1] - 0.07367 * fit[2],
    -0.10208 * fit[0] + 1.10813 * fit[1] - 0.00605 * fit[2],
    -0.00327 * fit[0] - 0.07276 * fit[1] + 1.07602 * fit[2],
  ];
  return output.map((value) => Math.min(1, Math.max(0, value)));
}

/**
 * Linear fog colour that lands on the horizon's on-screen colour for the
 * given render path, brightness-capped so the haze can never bloom.
 *
 * @param {[number, number, number]} radiance horizon radiance (already estimated)
 * @param {{postprocessing?: boolean, exposure?: number, cap?: number|null}} [options]
 */
export function fogColorForPath(radiance, { postprocessing, exposure = 1, cap } = {}) {
  // `cap: null` disables it (that is what the environment measures with, so the
  // track's own cap is the only one applied); omitting it takes the path default.
  if (postprocessing) {
    return capFogBrightness(radiance.slice(0, 3), cap === undefined ? MAX_FOG_LUMINANCE : cap);
  }
  // Direct path: three.js applies the fog in output space, after tone mapping.
  // The cap moves with it — output space tops out at 1.0, so a HDR cap of 0.55
  // would leave mobile haze darker than the sky it is supposed to match.
  return capFogBrightness(acesFilmic(radiance, exposure), cap === undefined ? MAX_FOG_LUMINANCE_OUTPUT : cap);
}
