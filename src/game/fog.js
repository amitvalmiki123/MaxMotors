/**
 * Distance fog matched to the sky (M2.5 step 4).
 *
 * The fog colour is measured from the environment itself — the average
 * radiance of a thin band around the horizon of the equirectangular HDRI (or
 * of the generated fallback sky) — so distant terrain dissolves into exactly
 * the colour of the sky behind it. That aerial perspective is what makes the
 * forest read in depth.
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
/** Fraction of the image height (above and below the horizon row) that is averaged. */
export const HORIZON_BAND = 0.012;

function halfToFloat(value) {
  const exponent = (value & 0x7c00) >> 10;
  const fraction = value & 0x03ff;
  const sign = value & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

const srgbToLinear = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

/**
 * Average linear radiance of the horizon band of an equirectangular image.
 * @param {{data: ArrayLike<number>, width: number, height: number}} image
 *        Float32Array / Uint16Array (half floats) hold linear radiance;
 *        Uint8 data is treated as sRGB (the canvas fallback sky).
 * @returns {[number, number, number]} linear RGB
 */
export function horizonRadiance(image, { band = HORIZON_BAND, encoding = null } = {}) {
  const { data, width, height } = image;
  const channels = Math.round(data.length / (width * height));
  const kind = encoding ?? (data instanceof Uint16Array ? 'half' : data instanceof Float32Array ? 'float' : 'srgb8');
  const half = Math.max(1, Math.round(height * band));
  const middle = Math.floor(height / 2);
  const sum = [0, 0, 0];
  let samples = 0;
  for (let row = middle - half; row < middle + half; row += 1) {
    if (row < 0 || row >= height) continue;
    for (let column = 0; column < width; column += 1) {
      const offset = (row * width + column) * channels;
      for (let channel = 0; channel < 3; channel += 1) {
        const raw = data[offset + channel];
        const value = kind === 'half' ? halfToFloat(raw) : kind === 'float' ? raw : srgbToLinear(raw / 255);
        sum[channel] += Number.isFinite(value) ? value : 0;
      }
      samples += 1;
    }
  }
  return sum.map((value) => value / Math.max(1, samples));
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
 * given render path.
 */
export function fogColorForPath(radiance, { postprocessing, exposure = 1 }) {
  return postprocessing ? radiance.slice(0, 3) : acesFilmic(radiance, exposure);
}
