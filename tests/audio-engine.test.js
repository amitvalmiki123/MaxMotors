import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cylinderFiringOffsets,
  cylinderOscillatorHz,
  exhaustResonance,
  firingFrequency,
  layerWeights,
  overrunLevel,
  pulseWaveCoefficients,
  shiftDipEnvelope,
  throttleTone,
} from '../src/game/audio.js';
import { getCar, CAR_PRESETS } from '../src/game/cars/catalog.js';

const V12 = { cylinders: 12, firingOrder: [1, 7, 5, 11, 3, 9, 6, 12, 2, 8, 4, 10], idleRpm: 950, redlineRpm: 8600, resonanceHz: [118, 268, 690] };
const DIESEL = { cylinders: 4, firingOrder: [1, 3, 4, 2], idleRpm: 750, redlineRpm: 5200, resonanceHz: [58, 132, 286] };

test('firing frequency: one power stroke per cylinder per two revolutions', () => {
  assert.equal(firingFrequency(900, 12), 90, 'a V12 at 900 rpm fires 90 times a second');
  assert.equal(firingFrequency(900, 4), 30, 'a four at 900 rpm fires 30 times a second');
  assert.equal(firingFrequency(0, 8), 0);
  // Each cylinder runs at the four-stroke cycle rate; the bank sums to the above.
  assert.equal(cylinderOscillatorHz(900), 7.5);
  assert.equal(cylinderOscillatorHz(900) * V12.cylinders, firingFrequency(900, 12));
  assert.equal(cylinderOscillatorHz(900) * DIESEL.cylinders, firingFrequency(900, 4));
});

test('firing offsets spread one event per cylinder across the 720° cycle', () => {
  const v12 = cylinderFiringOffsets(12, V12.firingOrder);
  assert.equal(v12.length, 12);
  assert.ok(v12.every((offset, index) => Math.abs(offset - index / 12) < 0.01), 'evenly spaced, with a little order-derived jitter');
  assert.ok(new Set(v12.map((offset) => offset.toFixed(4))).size === 12, 'no two cylinders share a firing event');

  const diesel = cylinderFiringOffsets(4, DIESEL.firingOrder);
  assert.equal(diesel.length, 4);
  // 1-3-4-2 is evenly spaced in *time*; the order decides which cylinder fires.
  assert.ok(diesel.every((offset, index) => Math.abs(offset - index / 4) < 0.01));
});

test('the per-cylinder pulse wave is a decaying blow-down, phase-rotated exactly', () => {
  const { real, imag } = pulseWaveCoefficients({ decay: 6, harmonics: 64, tau: 0 });
  assert.equal(real.length, 65);
  assert.equal(real[0], 0, 'no DC offset: WebAudio ignores index 0 anyway');
  // Harmonic amplitudes must fall away — a pressure pulse, not a square wave.
  const amplitude = (k) => Math.hypot(real[k], imag[k]);
  assert.ok(amplitude(1) > amplitude(4), 'the fundamental dominates');
  assert.ok(amplitude(4) > amplitude(16), 'energy falls off with harmonic order');
  assert.ok(amplitude(16) > amplitude(64), 'and keeps falling');
  assert.ok(real.every(Number.isFinite) && imag.every(Number.isFinite), 'no NaN coefficients');

  // Phase rotation preserves the waveform's shape exactly: rotating by tau and
  // reconstructing must equal reconstructing the unrotated wave at t - tau.
  const rotated = pulseWaveCoefficients({ decay: 6, harmonics: 64, tau: 0.25 });
  const reconstruct = (coeffs, t) => {
    let value = 0;
    for (let k = 1; k <= 64; k += 1) value += coeffs.real[k] * Math.cos(2 * Math.PI * k * t) + coeffs.imag[k] * Math.sin(2 * Math.PI * k * t);
    return value;
  };
  for (const t of [0.03, 0.2, 0.55, 0.9]) {
    assert.ok(
      Math.abs(reconstruct(rotated, t) - reconstruct({ real, imag }, t - 0.25)) < 1e-9,
      `rotation is a pure phase shift at t=${t}`,
    );
  }
  // ...which is the whole point: a start() offset is a fixed number of seconds
  // and would drift out of phase as the RPM changed. This does not.
  assert.ok(Math.abs(amplitude(1) - Math.hypot(rotated.real[1], rotated.imag[1])) < 1e-12, 'rotation preserves amplitude');
});

test('the low/mid/high beds crossfade on RPM and sum to about one', () => {
  const layers = [{ referenceRpm: 1400 }, { referenceRpm: 4200 }, { referenceRpm: 8200 }];
  for (const rpm of [950, 1400, 2500, 4200, 6000, 8200, 9000]) {
    const weights = layerWeights(rpm, layers);
    const total = weights.reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(total - 1) < 0.02, `weights sum to 1 at ${rpm} rpm: ${total}`);
    assert.ok(weights.every((value) => value >= 0 && value <= 1));
  }
  // Each bed owns its own reference RPM.
  assert.ok(layerWeights(1400, layers)[0] > 0.8, 'idle/low revs are the low bed');
  assert.ok(layerWeights(4200, layers)[1] > 0.5, 'mid revs are the mid bed');
  assert.ok(layerWeights(8200, layers)[2] > 0.5, 'the top of the rev range is the high bed');
  // Below the lowest reference the low bed owns it outright; past the highest
  // the top bed dominates but the mid bed still contributes (the engine is
  // beyond every recorded reference, so the timbre keeps blending).
  assert.ok(layerWeights(200, layers)[0] > 0.95);
  assert.ok(layerWeights(12000, layers)[2] > 0.75);
  assert.ok(layerWeights(12000, layers)[2] > layerWeights(12000, layers)[1] * 3);
  // The blend is monotonic through the middle: no bed drops out and comes back.
  const mid = [];
  for (let rpm = 1400; rpm <= 8200; rpm += 200) mid.push(layerWeights(rpm, layers)[1]);
  const peak = mid.indexOf(Math.max(...mid));
  assert.ok(peak > 0 && peak < mid.length - 1, 'the mid bed peaks between its neighbours');
});

test('exhaust resonance stays near the pipes\u2019 own tuning and never tracks RPM outright', () => {
  for (const engine of [V12, DIESEL]) {
    const idle = exhaustResonance(engine, engine.idleRpm);
    const redline = exhaustResonance(engine, engine.redlineRpm);
    assert.equal(idle.length, engine.resonanceHz.length);
    engine.resonanceHz.forEach((frequency, index) => {
      // A drift of a few percent: hot, fast gas raises the tune slightly. A
      // resonator that followed the engine would be a second oscillator and the
      // exhaust would stop "singing" as harmonics swept past it.
      const ratio = redline[index] / frequency;
      assert.ok(ratio > 0.85 && ratio < 1.4, `${engine.cylinders}-cyl harmonic ${index}: ${ratio.toFixed(2)}× from idle to redline`);
      assert.ok(idle[index] > 20 && redline[index] < 7000, 'audible at both ends');
    });
    assert.ok(redline[0] > idle[0], 'the tune rises with revs, it does not fall');
  }
  // The diesel sits an octave or two below the petrol V12.
  assert.ok(exhaustResonance(DIESEL, 2000)[0] < exhaustResonance(V12, 2000)[0] * 0.7, 'a diesel exhaust is far lower');
});

test('on/off-throttle tone: overrun only when lifted, brightness only on throttle', () => {
  assert.equal(overrunLevel({ rpm: 6000, throttle: 1, ...V12 }), 0, 'wide open throttle has no overrun');
  assert.ok(overrunLevel({ rpm: 6000, throttle: 0, ...V12 }) > 0.6, 'lifting at 6000 rpm is loud overrun');
  assert.ok(overrunLevel({ rpm: 1000, throttle: 0, ...V12 }) < overrunLevel({ rpm: 6000, throttle: 0, ...V12 }), 'overrun grows with revs');
  assert.ok(overrunLevel({ rpm: 6000, throttle: 0.5, ...V12 }) < overrunLevel({ rpm: 6000, throttle: 0, ...V12 }), 'part throttle is in between');
  assert.ok(overrunLevel({ rpm: -500, throttle: 2, ...V12 }) >= 0, 'never negative on junk input');

  assert.equal(throttleTone({ throttle: 0, rpm: 4000, idleRpm: 950 }), 0, 'no throttle, no brightness');
  assert.ok(throttleTone({ throttle: 1, rpm: 6000, idleRpm: 950 }) > throttleTone({ throttle: 1, rpm: 1200, idleRpm: 950 }), 'brightness grows with revs');
  assert.ok(throttleTone({ throttle: 1, rpm: 9000, idleRpm: 950 }) <= 1, 'clamped');
});

test('the gear-shift dip drops fast and recovers smoothly', () => {
  assert.equal(shiftDipEnvelope(-1), 1, 'before the shift there is no dip');
  assert.equal(shiftDipEnvelope(0), 1);
  const trough = shiftDipEnvelope(0.06);
  assert.ok(trough < 0.4, `the clutch-out trough: ${trough}`);
  assert.ok(shiftDipEnvelope(0.03) < shiftDipEnvelope(0.01), 'it falls monotonically');
  assert.ok(shiftDipEnvelope(0.2) > trough, 'then recovers');
  assert.equal(shiftDipEnvelope(1), 1, 'and is fully back');
  // No discontinuities: consecutive samples never jump by more than a little.
  let previous = 1;
  for (let t = 0; t <= 0.5; t += 0.002) {
    const value = shiftDipEnvelope(t);
    assert.ok(Math.abs(value - previous) < 0.05, `smooth at t=${t.toFixed(3)}`);
    assert.ok(value > 0 && value <= 1);
    previous = value;
  }
});

test('every shipped car declares an engine profile the audio can build', () => {
  for (const preset of Object.values(CAR_PRESETS)) {
    const car = getCar(preset.id);
    assert.ok(typeof car.audioProfile === 'string' && car.audioProfile.length > 0, `${preset.id} needs an audioProfile`);
    assert.ok(car.physics.brakeGain > 0, `${preset.id} needs a brakeGain`);
    assert.ok(car.cockpit && Array.isArray(car.cockpit.headOffset), `${preset.id} needs cockpit corrections`);
  }
  // The Aurora's profile must be the V12, not the M2 "aurora-v10" id: the audio
  // beds are keyed by it, and a stale id is exactly what left a car silent.
  assert.equal(getCar('aurora-v12').audioProfile, 'aurora-v12');
  assert.equal(getCar('sikandar-suv').audioProfile, 'sikandar-diesel');
});
