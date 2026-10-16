#!/usr/bin/env node
/**
 * Generates the CC0 engine loop beds used by the WebAudio engine synth.
 *
 * The loops are synthesized from scratch by this script, so the project owns
 * them outright and dedicates them to the public domain (CC0 1.0). No third
 * party recording ships with the game.
 *
 * M2.6 rebuild — the beds are now built from a **per-cylinder firing model**
 * rather than from a single additive stack at the firing frequency:
 *
 *   - every cylinder gets its own pressure pulse (sharp rise, exponential
 *     blow-down) placed at its position in the engine's firing order, and the
 *     pulses are summed over one 720° cycle. An even-firing V12 comes out
 *     smooth and turbine-like; a four-cylinder diesel comes out lumpy, with the
 *     180° gap between power strokes audible as the diesel "chug";
 *   - that pulse train drives a bank of second-order resonators tuned to the
 *     exhaust system's own frequencies (primary pipe, secondary, Helmholtz),
 *     which is what turns a buzz into an exhaust note;
 *   - induction and valve-train noise, plus a turbocharger whine + wastegate
 *     hiss on the diesel;
 *   - three beds per engine (low / mid / high) so the runtime can crossfade by
 *     RPM instead of by load, which is what a real engine's timbre follows.
 *
 * Each loop still spans a whole number of firing cycles at its reference RPM,
 * so it is seamless when looped and correct when pitched by
 * playbackRate = rpm / referenceRpm. The engine spec (cylinders, firing order,
 * resonances, redline) is written into engine.index.json because the runtime
 * synthesizes the live per-cylinder pulse train from the same numbers — the
 * beds and the synth must describe the same engine.
 *
 * Usage: node scripts/assets/build-audio.mjs [--out public/audio]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const OUTPUT_DIR = outIndex === -1 ? 'public/audio' : args[outIndex + 1];
const SAMPLE_RATE = 44100;

/**
 * Engine definitions. These must agree with `gameboxFor()` in src/game/game.js
 * and with the cars in src/game/cars/catalog.js: the Aurora V12 is a short-
 * stroke V12 petrol that screams to 8600 rpm, the Sikandar is a 2.2 L
 * four-cylinder turbo-diesel that runs out of breath at 5200.
 */
export const PROFILES = {
  'aurora-v12': {
    label: 'Aurora V12 — 6.5 L naturally aspirated V12 petrol',
    character: 'petrol-v12',
    cylinders: 12,
    /** Even-firing V12 order (60° apart), the classic Lamborghini/Lamberti pattern. */
    firingOrder: [1, 7, 5, 11, 3, 9, 6, 12, 2, 8, 4, 10],
    idleRpm: 950,
    redlineRpm: 8600,
    /** Exhaust resonances: primary tube, secondary, and the Helmholtz box. */
    resonanceHz: [118, 268, 690],
    resonanceQ: [5.5, 4.0, 2.6],
    resonanceGain: [1.0, 0.62, 0.34],
    turbo: null,
    layers: [
      { id: 'low', referenceRpm: 1400, cycles: 112, brightness: 0.3, noise: 0.05, growl: 0.42, pulseDecay: 5.5 },
      { id: 'mid', referenceRpm: 4200, cycles: 294, brightness: 0.62, noise: 0.07, growl: 0.24, pulseDecay: 8.0 },
      { id: 'high', referenceRpm: 8200, cycles: 574, brightness: 0.92, noise: 0.1, growl: 0.12, pulseDecay: 12.0 },
    ],
  },
  'sikandar-diesel': {
    label: 'Sikandar SUV — 2.2 L turbo-diesel, four cylinders',
    character: 'turbo-diesel',
    cylinders: 4,
    firingOrder: [1, 3, 4, 2],
    idleRpm: 750,
    redlineRpm: 5200,
    // A long, large-bore diesel exhaust: everything sits an octave or two below
    // the petrol V12, and the Helmholtz resonance is the "tractor" boom.
    resonanceHz: [58, 132, 286],
    resonanceQ: [7.0, 5.0, 3.0],
    resonanceGain: [1.0, 0.72, 0.3],
    turbo: { whineHz: 920, whineRatio: 2.6, gain: 0.16, wastegate: 0.1 },
    layers: [
      { id: 'low', referenceRpm: 900, cycles: 30, brightness: 0.18, noise: 0.17, growl: 0.9, pulseDecay: 3.2 },
      { id: 'mid', referenceRpm: 2100, cycles: 70, brightness: 0.4, noise: 0.19, growl: 0.62, pulseDecay: 4.6 },
      { id: 'high', referenceRpm: 4400, cycles: 147, brightness: 0.66, noise: 0.22, growl: 0.3, pulseDecay: 6.4 },
    ],
  },
};

function writeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + index * 2);
  }
  return buffer;
}

/** Deterministic value noise (no Math.random) so rebuilds are byte-stable. */
function createNoise(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state / 4294967296) * 2 - 1;
  };
}

/** Firing frequency (power pulses per second) for an engine at `rpm`. */
export function firingFrequency(rpm, cylinders) {
  return (rpm / 60) * (cylinders / 2);
}

/**
 * Per-cylinder phase offsets within one 720° cycle, derived from the firing
 * order. Cylinder labels in `firingOrder` are 1-based; the returned array is
 * indexed by firing *event* and holds that event's offset as a fraction of the
 * cycle, so `offsets[i] = i / N` for an evenly spaced order.
 */
export function firingOffsets(firingOrder, cylinders) {
  const count = firingOrder?.length ?? cylinders;
  const offsets = new Array(count);
  for (let event = 0; event < count; event += 1) {
    const label = firingOrder?.[event] ?? event + 1;
    // An even-firing four-stroke spaces events 720°/N apart regardless of the
    // order; the order decides *which* cylinder fires, and the small per-event
    // jitter below is what makes a cross-plane V8 or a 1-3-4-2 diesel sound
    // different from a metronome.
    offsets[event] = (event / count) + ((label % 3) - 1) * 0.0035;
  }
  return offsets;
}

/** Second-order resonator (RBJ bandpass), the exhaust-pipe model. */
function createResonator(frequency, q, gain, sampleRate = SAMPLE_RATE) {
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Math.max(0.1, q));
  const a0 = 1 + alpha;
  const b0 = (alpha / a0) * gain;
  const b2 = (-alpha / a0) * gain;
  const a1 = (-2 * Math.cos(w0)) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (input) => {
    const output = b0 * input + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = input;
    y2 = y1;
    y1 = output;
    return output;
  };
}

/** One-pole low/high pass pair for the induction and valve-train noise. */
function createShaper({ lowpass = 0.86, highpass = 0.6 } = {}) {
  let low = 0;
  let high = 0;
  return (input) => {
    low = low * lowpass + input * (1 - lowpass);
    high = high * highpass + (input - low) * (1 - highpass);
    return low + high * 0.4;
  };
}

function synthesize({ referenceRpm, cylinders, firingOrder, resonanceHz, resonanceQ, resonanceGain, turbo, cycles, brightness, noise, growl, pulseDecay, character }) {
  const firing = firingFrequency(referenceRpm, cylinders);
  const duration = cycles / firing;
  const total = Math.round(duration * SAMPLE_RATE);
  const samples = new Float32Array(total);
  const rand = createNoise(Math.round(referenceRpm) + cylinders * 977 + (character === 'turbo-diesel' ? 31 : 7));
  const offsets = firingOffsets(firingOrder, cylinders);

  // Cycle period of one cylinder (720° of crank), in samples.
  const cycleSamples = (SAMPLE_RATE * 2) / (referenceRpm / 60);

  const resonators = (resonanceHz ?? []).map((frequency, index) => createResonator(
    frequency,
    resonanceQ?.[index] ?? 4,
    resonanceGain?.[index] ?? 0.5,
  ));
  const induction = createShaper({ lowpass: 0.9 - brightness * 0.2, highpass: 0.55 + brightness * 0.2 });

  let lowNoise = 0;
  let bandNoise = 0;
  let turboPhase = 0;
  let turboSpeed = 0;
  const diesel = character === 'turbo-diesel';

  for (let index = 0; index < total; index += 1) {
    const time = index / SAMPLE_RATE;

    // --- per-cylinder firing pulses ---------------------------------------
    // Each event is a sharp rise (combustion) into an exponential blow-down
    // (exhaust valve opening), placed at its offset in the 720° cycle.
    let pulse = 0;
    const cyclePhase = (index % cycleSamples) / cycleSamples;
    for (let event = 0; event < offsets.length; event += 1) {
      let delta = cyclePhase - offsets[event];
      // Wrap into [0, 1): a pulse started late in the cycle continues into the
      // next one, which is what keeps the loop seamless.
      if (delta < 0) delta += 1;
      const attack = Math.min(1, delta * 90);
      pulse += attack * Math.exp(-delta * pulseDecay * offsets.length);
    }
    pulse /= offsets.length;
    // Diesel combustion is a hammer blow, petrol a smoother burn.
    const shaped = diesel ? Math.tanh(pulse * 2.6) : Math.tanh(pulse * 1.5);

    // --- exhaust resonance -------------------------------------------------
    let value = 0;
    for (const resonator of resonators) value += resonator(shaped);
    value += shaped * (0.55 - growl * 0.25);

    // --- induction / valve train ------------------------------------------
    const white = rand();
    lowNoise = lowNoise * 0.86 + white * 0.14;
    bandNoise = bandNoise * 0.6 + white * 0.4;
    value += induction(bandNoise) * (noise + growl * 0.45) * (0.6 + pulse * 0.8);
    value += lowNoise * noise * 0.7;

    // --- turbocharger (diesel) --------------------------------------------
    if (turbo) {
      // The compressor spins up with a lag, then whines at shaft speed.
      const target = (referenceRpm / 60) * turbo.whineRatio;
      turboSpeed += (target - turboSpeed) * 0.002;
      turboPhase += (2 * Math.PI * turboSpeed * turbo.whineHz) / (SAMPLE_RATE * 60);
      const boost = Math.min(1, Math.max(0, (referenceRpm - 1400) / 2200));
      value += Math.sin(turboPhase) * turbo.gain * boost;
      value += bandNoise * turbo.wastegate * boost * 0.5;
    }

    // Lumpy idle / firing-order flutter: slower than the firing frequency, so
    // it reads as the engine's own roughness rather than as a tremolo.
    const flutter = 0.86 + 0.14 * Math.sin(2 * Math.PI * (firing / cylinders) * time + 1.1);
    samples[index] = Math.tanh(value * (0.9 + brightness * 0.5) * flutter);
  }

  // Normalize to -3 dBFS so all three layers sit at a comparable level and the
  // runtime's crossfade is a timbre change, not a volume change.
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const gain = peak > 0 ? 0.707 / peak : 1;
  for (let index = 0; index < samples.length; index += 1) samples[index] *= gain;

  return { samples, firingFrequency: firing, duration };
}

/**
 * Car horn: the classic dual-tone disc horn pair, a major third apart
 * (420 Hz + 525 Hz, 4:5). Each tone is a harmonic-rich buzz with a resonance
 * near 2.4 kHz (the trumpet "blare"), then soft-clipped for the brassy edge.
 * Both tones complete whole cycles in 0.4 s, so the loop is seamless; the game
 * shapes attack/release with a gain envelope while H is held.
 */
export const HORN = Object.freeze({ frequencies: [420, 525], seconds: 0.4, formantHz: 2400 });

export function synthesizeHorn({ frequencies = HORN.frequencies, seconds = HORN.seconds, formantHz = HORN.formantHz } = {}) {
  const total = Math.round(seconds * SAMPLE_RATE);
  const samples = new Float32Array(total);
  const partials = [];
  for (const [tone, frequency] of frequencies.entries()) {
    for (let harmonic = 1; harmonic * frequency < 6500; harmonic += 1) {
      const resonance = 1 / (1 + ((harmonic * frequency - formantHz) / 1300) ** 2);
      partials.push({ frequency: frequency * harmonic, amplitude: (1 / harmonic) * (0.3 + 0.7 * resonance), phase: harmonic * 0.7 + tone * 1.3 });
    }
  }
  for (let index = 0; index < total; index += 1) {
    const time = index / SAMPLE_RATE;
    let value = 0;
    for (const partial of partials) value += partial.amplitude * Math.sin(2 * Math.PI * partial.frequency * time + partial.phase);
    samples[index] = Math.tanh(value * 0.85);
  }
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const gain = peak > 0 ? 0.707 / peak : 1;
  for (let index = 0; index < samples.length; index += 1) samples[index] *= gain;
  return { samples, seconds: total / SAMPLE_RATE };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const index = { generatedAt: new Date().toISOString(), license: 'CC0 1.0', sampleRate: SAMPLE_RATE, engines: [] };

  for (const [id, profile] of Object.entries(PROFILES)) {
    const layers = [];
    for (const layer of profile.layers) {
      const { samples, firingFrequency: firing, duration } = synthesize({ ...layer, ...profile });
      const relative = path.relative('public', path.join(OUTPUT_DIR, `${id}-${layer.id}.wav`)).replaceAll('\\', '/');
      await writeFile(path.join(OUTPUT_DIR, `${id}-${layer.id}.wav`), writeWav(samples, SAMPLE_RATE));
      layers.push({
        id: layer.id,
        file: `/${relative}`,
        referenceRpm: layer.referenceRpm,
        loopSeconds: Number(duration.toFixed(4)),
        firingFrequencyHz: Number(firing.toFixed(2)),
        bytes: samples.length * 2 + 44,
      });
      console.log(`[audio] ${id}/${layer.id}: ${duration.toFixed(3)}s @ ${layer.referenceRpm} rpm (${firing.toFixed(1)} Hz firing, ${profile.cylinders} cyl)`);
    }
    index.engines.push({
      id,
      label: profile.label,
      character: profile.character,
      cylinders: profile.cylinders,
      firingOrder: profile.firingOrder,
      idleRpm: profile.idleRpm,
      redlineRpm: profile.redlineRpm,
      resonanceHz: profile.resonanceHz,
      resonanceQ: profile.resonanceQ,
      resonanceGain: profile.resonanceGain,
      turbo: profile.turbo ?? null,
      layers,
    });
  }

  const horn = synthesizeHorn();
  await writeFile(path.join(OUTPUT_DIR, 'horn.wav'), writeWav(horn.samples, SAMPLE_RATE));
  index.effects = [{
    id: 'horn',
    file: `/${path.relative('public', path.join(OUTPUT_DIR, 'horn.wav')).replaceAll('\\', '/')}`,
    loopSeconds: horn.seconds,
    frequenciesHz: HORN.frequencies,
    bytes: horn.samples.length * 2 + 44,
  }];
  console.log(`[audio] horn: ${horn.seconds}s dual-tone ${HORN.frequencies.join(' + ')} Hz`);

  await writeFile(path.join(OUTPUT_DIR, 'engine.index.json'), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`[audio] wrote ${path.join(OUTPUT_DIR, 'engine.index.json')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('[audio] FATAL:', error.message);
    process.exitCode = 1;
  });
}
