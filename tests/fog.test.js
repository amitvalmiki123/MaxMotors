import assert from 'node:assert/strict';
import test from 'node:test';
import { FOREST_FOG_DENSITY, acesFilmic, fogColorForPath, horizonRadiance } from '../src/game/fog.js';
import { TRACK_TINT } from '../src/game/config.js';

function floatToHalf(value) {
  const buffer = new DataView(new ArrayBuffer(4));
  buffer.setFloat32(0, value);
  const bits = buffer.getUint32(0);
  const exponent = ((bits >> 23) & 0xff) - 127 + 15;
  return ((bits >> 16) & 0x8000) | (Math.max(0, Math.min(31, exponent)) << 10) | ((bits >> 13) & 0x3ff);
}

test('horizon radiance averages the band around the middle row (half-float HDRI)', () => {
  const width = 8;
  const height = 100;
  const data = new Uint16Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    // Bright sky on top, dark ground below, a known colour on the horizon rows.
    const value = row < 49 ? [3, 3, 4] : row > 50 ? [0.1, 0.1, 0.1] : [0.5, 0.75, 1];
    for (let column = 0; column < width; column += 1) {
      const offset = (row * width + column) * 4;
      data.set([...value.map(floatToHalf), floatToHalf(1)], offset);
    }
  }
  const [r, g, b] = horizonRadiance({ data, width, height }, { band: 0.01 });
  assert.ok(Math.abs(r - 0.5) < 0.01 && Math.abs(g - 0.75) < 0.01 && Math.abs(b - 1) < 0.01, `${r} ${g} ${b}`);
});

test('8-bit fallback skies are read as sRGB', () => {
  const data = new Uint8ClampedArray(4 * 4 * 4).fill(255);
  for (let index = 0; index < data.length; index += 4) data.set([128, 128, 128, 255], index);
  const [r] = horizonRadiance({ data, width: 4, height: 4 });
  assert.ok(Math.abs(r - 0.2158) < 0.002, `sRGB 128 -> linear ${r}`);
});

test('fog colour: raw radiance for post-processing, ACES-mapped for direct rendering', () => {
  assert.deepEqual(acesFilmic([0, 0, 0]), [0, 0, 0]);
  const bright = acesFilmic([4, 4, 4], 1.02);
  assert.ok(bright.every((value) => value > 0.85 && value <= 1));
  const mid = acesFilmic([0.4, 0.5, 0.6], 1.02);
  assert.ok(mid[0] < mid[1] && mid[1] < mid[2], 'hue order survives tone mapping');
  assert.deepEqual(fogColorForPath([1.2, 1.4, 1.7], { postprocessing: true }), [1.2, 1.4, 1.7]);
  assert.deepEqual(fogColorForPath([1.2, 1.4, 1.7], { postprocessing: false, exposure: 1.02 }), acesFilmic([1.2, 1.4, 1.7], 1.02));
});

test('the forest uses exponential fog that keeps the car crisp and dissolves the far trees', () => {
  assert.equal(TRACK_TINT['forest-dirt-trail'].fogDensity, FOREST_FOG_DENSITY);
  const amount = (distance) => 1 - Math.exp(-((FOREST_FOG_DENSITY * distance) ** 2));
  assert.ok(amount(15) < 0.01, 'the car and the road just ahead stay clear');
  assert.ok(amount(100) > 0.2 && amount(100) < 0.45, 'mid-distance trees are hazed');
  assert.ok(amount(250) > 0.85, 'the far tree line dissolves into the sky');
});
