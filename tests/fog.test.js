import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FOREST_FOG_DENSITY,
  MAX_FOG_LUMINANCE,
  MAX_FOG_LUMINANCE_OUTPUT,
  SUN_REJECT_RATIO,
  acesFilmic,
  capFogBrightness,
  fogColorForPath,
  horizonRadiance,
  luminance,
} from '../src/game/fog.js';
import { TRACK_TINT } from '../src/game/config.js';

function floatToHalf(value) {
  const buffer = new DataView(new ArrayBuffer(4));
  buffer.setFloat32(0, value);
  const bits = buffer.getUint32(0);
  const exponent = ((bits >> 23) & 0xff) - 127 + 15;
  return ((bits >> 16) & 0x8000) | (Math.max(0, Math.min(31, exponent)) << 10) | ((bits >> 13) & 0x3ff);
}

/** Builds a half-float equirect image from a per-row RGB function. */
function halfImage(width, height, rowColor) {
  const data = new Uint16Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const value = rowColor(row);
    for (let column = 0; column < width; column += 1) {
      const color = Array.isArray(value) ? value : value(column);
      const offset = (row * width + column) * 4;
      data.set([...color.map(floatToHalf), floatToHalf(1)], offset);
    }
  }
  return { data, width, height };
}

test('horizon radiance reads the band around the middle row (half-float HDRI)', () => {
  const image = halfImage(8, 100, (row) => (row < 49 ? [3, 3, 4] : row > 50 ? [0.1, 0.1, 0.1] : [0.5, 0.75, 1]));
  // `cap: null` isolates the estimator from the brightness cap.
  const [r, g, b] = horizonRadiance(image, { band: 0.01, cap: null });
  assert.ok(Math.abs(r - 0.5) < 0.01 && Math.abs(g - 0.75) < 0.01 && Math.abs(b - 1) < 0.01, `${r} ${g} ${b}`);
});

test('a sun on the horizon does not drag the estimate towards white (M2.6)', () => {
  // 8 sun pixels at 20000 nits against ~160 sky pixels: the plain mean goes
  // near-white and above the bloom threshold, which is what hazed out the whole
  // distance and made it glow.
  const width = 8;
  const height = 100;
  const image = halfImage(width, height, (row) => (row < 49 ? [3, 3, 4] : row > 50 ? [0.1, 0.1, 0.1] : [0.5, 0.75, 1]));
  const horizonRow = Math.floor(height / 2) - 1;
  for (let column = 0; column < width; column += 1) {
    image.data.set([20000, 19500, 18000, 1].map(floatToHalf), (horizonRow * width + column) * 4);
  }

  const mean = horizonRadiance(image, { band: 0.01, estimator: 'mean', cap: null });
  assert.ok(luminance(mean) > 20, `the plain mean should be blown out, got ${luminance(mean)}`);

  const trimmed = horizonRadiance(image, { band: 0.01, cap: null });
  assert.ok(luminance(trimmed) < 1.2, `the trimmed estimate should reject the sun, got ${luminance(trimmed)}`);
  // ...and still report the sky's own hue, not a neutral grey.
  assert.ok(trimmed[2] > trimmed[0], 'the horizon stays blue-warm, not white');
  assert.ok(trimmed[1] > trimmed[0], 'green channel stays above red, as the sky is');

  const median = horizonRadiance(image, { band: 0.01, estimator: 'median', cap: null });
  assert.ok(luminance(median) < 1.2, `the median estimator also rejects the sun, got ${luminance(median)}`);
  assert.ok(SUN_REJECT_RATIO > 1, 'the rejection threshold must sit above the band median');
});

test('fog brightness is capped by scaling, so the sky keeps its hue', () => {
  const bright = capFogBrightness([4, 4.4, 5]);
  assert.ok(luminance(bright) <= MAX_FOG_LUMINANCE + 1e-9);
  // Scaling, not per-channel clamping: the ratios between channels survive.
  assert.ok(Math.abs(bright[0] / bright[1] - 4 / 4.4) < 1e-6, 'hue ratio preserved');
  assert.deepEqual(capFogBrightness([0.1, 0.1, 0.1]), [0.1, 0.1, 0.1], 'a dim colour is untouched');
  assert.deepEqual(capFogBrightness([4, 4, 4], null), [4, 4, 4], 'cap: null disables it');
  // A colour already under the cap is never scaled *up*.
  const dim = capFogBrightness([0.02, 0.02, 0.02]);
  assert.deepEqual(dim, [0.02, 0.02, 0.02]);
});

test('8-bit fallback skies are read as sRGB', () => {
  const data = new Uint8ClampedArray(4 * 4 * 4).fill(255);
  for (let index = 0; index < data.length; index += 4) data.set([128, 128, 128, 255], index);
  const [r] = horizonRadiance({ data, width: 4, height: 4 }, { cap: null });
  assert.ok(Math.abs(r - 0.2158) < 0.002, `sRGB 128 -> linear ${r}`);
});

test('fog colour: capped radiance for post-processing, capped ACES for direct rendering', () => {
  assert.deepEqual(acesFilmic([0, 0, 0]), [0, 0, 0]);
  const bright = acesFilmic([4, 4, 4], 1.02);
  assert.ok(bright.every((value) => value > 0.85 && value <= 1));
  const mid = acesFilmic([0.4, 0.5, 0.6], 1.02);
  assert.ok(mid[0] < mid[1] && mid[1] < mid[2], 'hue order survives tone mapping');

  // The HDR path passes radiance straight through, capped at MAX_FOG_LUMINANCE.
  assert.deepEqual(fogColorForPath([0.2, 0.25, 0.3], { postprocessing: true }), [0.2, 0.25, 0.3]);
  const capped = fogColorForPath([1.2, 1.4, 1.7], { postprocessing: true });
  assert.ok(luminance(capped) <= MAX_FOG_LUMINANCE + 1e-9, `HDR fog must stay under the bloom threshold, got ${luminance(capped)}`);
  // ...and an explicit cap: null still gives the raw radiance (the estimate the
  // environment measures; the track's own fogCap is applied later by the game).
  assert.deepEqual(fogColorForPath([1.2, 1.4, 1.7], { postprocessing: true, cap: null }), [1.2, 1.4, 1.7]);

  // The direct path tone maps first, then caps in output space. A horizon that
  // maps under the cap passes through as pure ACES.
  const direct = fogColorForPath([0.5, 0.6, 0.75], { postprocessing: false, exposure: 1.02 });
  assert.deepEqual(direct, acesFilmic([0.5, 0.6, 0.75], 1.02));
  const directCapped = fogColorForPath([40, 40, 40], { postprocessing: false, exposure: 1.02 });
  assert.ok(luminance(directCapped) <= MAX_FOG_LUMINANCE_OUTPUT + 1e-9, `output-space fog capped, got ${luminance(directCapped)}`);
  assert.ok(MAX_FOG_LUMINANCE_OUTPUT > MAX_FOG_LUMINANCE, 'output space tops out at 1.0, so its cap is looser');
});

test('the forest uses exponential fog that keeps the car crisp and dissolves the far trees', () => {
  assert.equal(TRACK_TINT['forest-dirt-trail'].fogDensity, FOREST_FOG_DENSITY);
  const amount = (distance) => 1 - Math.exp(-((FOREST_FOG_DENSITY * distance) ** 2));
  assert.ok(amount(15) < 0.01, 'the car and the road just ahead stay clear');
  assert.ok(amount(100) > 0.2 && amount(100) < 0.45, 'mid-distance trees are hazed');
  assert.ok(amount(250) > 0.85, 'the far tree line dissolves into the sky');
});

test('every track declares a fog cap, and the circuit haze stays lighter than the forest', () => {
  for (const [id, tint] of Object.entries(TRACK_TINT)) {
    assert.ok(Number.isFinite(tint.fogCap) && tint.fogCap > 0 && tint.fogCap <= 1, `${id} needs a sane fogCap`);
    // The binding constraint is UnrealBloomPass' threshold (0.82, see
    // graphics.js): fog above it makes the whole distance glow, which is the
    // M2.5 bug. A track may therefore cap slightly above the module default.
    assert.ok(tint.fogCap < 0.82, `${id}'s cap must sit under the bloom threshold`);
    assert.ok(tint.fogCap <= MAX_FOG_LUMINANCE_OUTPUT, `${id}'s cap must also be legal on the direct path`);
  }
  // The open circuit should read as bright sky, the closed forest as dimmer and
  // greener haze — and neither may reach the M2.5 near-white values.
  assert.ok(TRACK_TINT['test-circuit-01'].fogCap > TRACK_TINT['forest-dirt-trail'].fogCap);
  assert.ok(TRACK_TINT['forest-free-roam'].fogDensity < FOREST_FOG_DENSITY, 'Free Roam sees further than the walled trail');
});
