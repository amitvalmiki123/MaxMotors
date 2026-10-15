#!/usr/bin/env node
/**
 * Generates the CC0 engine loop bed used by the WebAudio engine synth.
 *
 * The loops are synthesized from scratch by this script (additive harmonics at
 * the engine's firing frequency plus shaped noise), so the project owns them
 * outright and dedicates them to the public domain (CC0 1.0). Each loop spans a
 * whole number of firing cycles at its reference RPM, which makes it seamless
 * when looped and correct when pitched by playbackRate = rpm / referenceRpm.
 *
 * Usage: node scripts/assets/build-audio.mjs [--out public/audio]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const OUTPUT_DIR = outIndex === -1 ? 'public/audio' : args[outIndex + 1];
const SAMPLE_RATE = 44100;

const PROFILES = {
  'aurora-v10': {
    label: 'Aurora V12 — V10-style petrol engine bed',
    cylinders: 10,
    layers: [
      { id: 'low', referenceRpm: 1600, cycles: 133, brightness: 0.35, noise: 0.05, growl: 0.5 },
      { id: 'high', referenceRpm: 7200, cycles: 600, brightness: 0.85, noise: 0.11, growl: 0.22 },
    ],
  },
  'sikandar-diesel': {
    label: 'Sikandar SUV — turbo-diesel rumble bed',
    cylinders: 4,
    layers: [
      { id: 'low', referenceRpm: 900, cycles: 30, brightness: 0.2, noise: 0.16, growl: 0.85 },
      { id: 'high', referenceRpm: 3600, cycles: 120, brightness: 0.6, noise: 0.2, growl: 0.4 },
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

function synthesize({ referenceRpm, cylinders, cycles, brightness, noise, growl }) {
  const firingFrequency = (referenceRpm / 60) * (cylinders / 2);
  const duration = cycles / firingFrequency;
  const total = Math.round(duration * SAMPLE_RATE);
  const samples = new Float32Array(total);
  const rand = createNoise(Math.round(referenceRpm) + cylinders * 977);

  // Harmonics of the firing frequency make up the tonal part of the engine.
  const harmonics = 24;
  const weights = [];
  for (let harmonic = 1; harmonic <= harmonics; harmonic += 1) {
    const tilt = 1 / Math.pow(harmonic, 1.45 - brightness);
    const oddBoost = harmonic % 2 === 1 ? 1 : 0.55;
    weights.push(tilt * oddBoost * (1 - growl * (harmonic / harmonics) * 0.5));
  }

  let lowNoise = 0;
  let bandNoise = 0;
  for (let index = 0; index < total; index += 1) {
    const time = index / SAMPLE_RATE;
    const phase = 2 * Math.PI * firingFrequency * time;
    let value = 0;
    for (let harmonic = 1; harmonic <= harmonics; harmonic += 1) {
      value += weights[harmonic - 1] * Math.sin(phase * harmonic + harmonic * 0.35);
    }
    value *= 0.16;

    // Diesel clatter / intake noise, low-passed by simple smoothing.
    const white = rand();
    lowNoise = lowNoise * 0.86 + white * 0.14;
    bandNoise = bandNoise * 0.6 + white * 0.4;
    value += lowNoise * (noise + growl * 0.5);
    value += bandNoise * 0.08;

    // Firing-order amplitude flutter gives the lumpy idle character.
    const flutter = 0.82 + 0.18 * Math.sin(phase * 0.5 + 1.1);
    samples[index] = Math.tanh(value * 1.35) * flutter;
  }

  // Normalize to -3 dBFS so both layers sit at a comparable level.
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const gain = peak > 0 ? 0.707 / peak : 1;
  for (let index = 0; index < samples.length; index += 1) samples[index] *= gain;

  return { samples, firingFrequency, duration };
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
      const { samples, firingFrequency, duration } = synthesize({ ...layer, cylinders: profile.cylinders });
      const file = `/${path.relative('public', path.join(OUTPUT_DIR, `${id}-${layer.id}.wav`)).replaceAll('\\', '/')}`;
      await writeFile(path.join(OUTPUT_DIR, `${id}-${layer.id}.wav`), writeWav(samples, SAMPLE_RATE));
      layers.push({
        id: layer.id,
        file,
        referenceRpm: layer.referenceRpm,
        loopSeconds: Number(duration.toFixed(4)),
        firingFrequencyHz: Number(firingFrequency.toFixed(2)),
        bytes: samples.length * 2 + 44,
      });
      console.log(`[audio] ${id}/${layer.id}: ${duration.toFixed(3)}s @ ${layer.referenceRpm} rpm (${firingFrequency.toFixed(1)} Hz firing)`);
    }
    index.engines.push({ id, label: profile.label, cylinders: profile.cylinders, layers });
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
