import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * The engine audio graph, exercised against a stubbed WebAudio implementation.
 *
 * `src/game/audio.js` is browser-only code, and the M2.5 bug it fixes — a car
 * switch leaving the game permanently silent — could not be caught by the pure
 * helpers in tests/audio-engine.test.js. So the graph is built here for real:
 * every node the module creates is recorded, and the tests assert on what was
 * wired, on the parameter automation `update()` schedules, and on the reload
 * path that used to be missing.
 */

const PUBLIC = new URL('../public/', import.meta.url);
const INDEX = JSON.parse(readFileSync(new URL('audio/engine.index.json', PUBLIC)));

function createParam(value = 0) {
  const calls = [];
  return {
    value,
    calls,
    setTargetAtTime(target, when, timeConstant) {
      this.value = target;
      calls.push(['setTargetAtTime', target, when, timeConstant]);
      return this;
    },
    setValueAtTime(target, when) {
      this.value = target;
      calls.push(['setValueAtTime', target, when]);
      return this;
    },
    linearRampToValueAtTime(target, when) {
      this.value = target;
      calls.push(['linearRampToValueAtTime', target, when]);
      return this;
    },
    cancelScheduledValues(when) {
      calls.push(['cancelScheduledValues', when]);
      return this;
    },
    exponentialRampToValueAtTime(target, when) {
      this.value = target;
      calls.push(['exponentialRampToValueAtTime', target, when]);
      return this;
    },
  };
}

function createStubAudioContext() {
  const created = [];
  const track = (node) => {
    created.push(node);
    return node;
  };
  const base = () => ({
    connect(target) {
      (this._connections ??= []).push(target);
      return target;
    },
    disconnect() {
      this._disconnected = (this._disconnected ?? 0) + 1;
    },
  });

  class StubContext {
    constructor() {
      this.currentTime = 0;
      this.sampleRate = 44100;
      this.state = 'suspended';
      this.destination = track({ ...base(), kind: 'destination' });
      StubContext.instances.push(this);
    }

    createGain() {
      return track({ ...base(), kind: 'gain', gain: createParam(1) });
    }

    createBiquadFilter() {
      return track({
        ...base(),
        kind: 'biquad',
        type: 'lowpass',
        frequency: createParam(350),
        Q: createParam(1),
        gain: createParam(0),
      });
    }

    createOscillator() {
      const node = {
        ...base(),
        kind: 'oscillator',
        type: 'sine',
        frequency: createParam(440),
        started: false,
        stopped: false,
        wave: null,
        start() {
          this.started = true;
        },
        stop() {
          this.stopped = true;
        },
        setPeriodicWave(wave) {
          this.wave = wave;
        },
      };
      return track(node);
    }

    createWaveShaper() {
      return track({ ...base(), kind: 'shaper', curve: null, oversample: 'none' });
    }

    createBufferSource() {
      return track({
        ...base(),
        kind: 'bufferSource',
        buffer: null,
        loop: false,
        playbackRate: createParam(1),
        started: false,
        stopped: false,
        start() {
          this.started = true;
        },
        stop() {
          this.stopped = true;
        },
      });
    }

    createAnalyser() {
      return track({
        ...base(),
        kind: 'analyser',
        fftSize: 1024,
        getFloatTimeDomainData(target) {
          target.fill(0);
        },
      });
    }

    createBuffer(channels, frames, sampleRate) {
      const data = new Float32Array(frames);
      return track({ kind: 'buffer', numberOfChannels: channels, length: frames, sampleRate, getChannelData: () => data });
    }

    createPeriodicWave(real, imag, options) {
      return track({ kind: 'periodicWave', real: Float32Array.from(real), imag: Float32Array.from(imag), options });
    }

    async decodeAudioData() {
      return { duration: 1, length: 44100, sampleRate: 44100, numberOfChannels: 1 };
    }

    async resume() {
      this.state = 'running';
    }

    async close() {
      this.state = 'closed';
    }
  }
  StubContext.instances = [];
  StubContext.created = created;
  return StubContext;
}

/** Serves `/audio/*` from the checked-in payload, exactly as the dev server would. */
function installFetch() {
  const requests = [];
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^\//, '');
    requests.push(path);
    try {
      const body = readFileSync(new URL(path, PUBLIC));
      return { ok: true, status: 200, json: async () => JSON.parse(body.toString('utf8')), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
    } catch {
      return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }
  };
  return requests;
}

async function withAudio(carId, body) {
  const StubContext = createStubAudioContext();
  const requests = installFetch();
  globalThis.window = {
    AudioContext: StubContext,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const { createEngineAudio } = await import(`../src/game/audio.js?run=${Math.random()}`);
  const audio = createEngineAudio({ carId, tier: { mobile: false } });
  try {
    return await body({ audio, StubContext, requests, created: StubContext.created });
  } finally {
    audio.dispose();
    delete globalThis.window;
  }
}

/**
 * Only the decoded loop beds: the tyre-noise and horn sources are built with
 * createBuffer() rather than decodeAudioData(), so they have no `duration`.
 */
const loopBeds = (created) => created.filter((node) => node.kind === 'bufferSource' && node.buffer?.duration === 1);
const ofKind = (created, kind) => created.filter((node) => node.kind === kind);

test('unlock() builds the whole engine graph for the V12', async () => {
  await withAudio('aurora-v12', async ({ audio, created }) => {
    assert.equal(audio.ready, false, 'silent until a user gesture');
    assert.equal(await audio.unlock(), true);
    assert.equal(audio.ready, true);

    // One oscillator per cylinder, each with its own phase-rotated wave.
    const cylinders = ofKind(created, 'oscillator').filter((node) => node.wave);
    assert.equal(cylinders.length, 12, 'a V12 gets twelve per-cylinder oscillators');
    assert.ok(cylinders.every((node) => node.started), 'and they are all running');
    const waves = ofKind(created, 'periodicWave');
    assert.equal(waves.length, 12, 'one PeriodicWave per cylinder');
    // The stagger must be baked into the phase, not into start() offsets.
    const first = waves[0];
    const rotated = waves.slice(1).filter((wave) => Math.abs(wave.real[4] - first.real[4]) > 1e-12);
    assert.equal(rotated.length, 11, 'eleven of the twelve waves are phase-rotated');

    // Three loop beds, each source → filter → gain → engine bus.
    const beds = loopBeds(created);
    assert.equal(beds.length, 3, 'low / mid / high beds');
    assert.ok(beds.every((node) => node.loop && node.started), 'looping and started');

    // Exhaust resonance bank: one bandpass per pipe frequency.
    const bandpasses = ofKind(created, 'biquad').filter((node) => node.type === 'bandpass');
    assert.ok(bandpasses.length >= 3, `${bandpasses.length} bandpass filters (3 exhaust resonators + overrun)`);
    assert.ok(ofKind(created, 'biquad').some((node) => node.type === 'highshelf'), 'the on/off-throttle shelf');
    assert.ok(ofKind(created, 'shaper').length >= 1, 'combustion drive');

    // No turbo on the petrol V12.
    assert.equal(audio.spec.turbo, null);
    assert.equal(audio.spec.cylinders, 12);
    assert.deepEqual(audio.spec.firingOrder, [1, 7, 5, 11, 3, 9, 6, 12, 2, 8, 4, 10]);
  });
});

test('the SUV gets its own diesel engine, and switching cars is not silent (the M2.5 bug)', async () => {
  await withAudio('aurora-v12', async ({ audio, created }) => {
    await audio.unlock();
    const before = ofKind(created, 'oscillator').filter((node) => node.wave).length;
    assert.equal(before, 12);

    // setCar() used to clear the layers and set `started = false`, and nothing
    // ever called unlock() again — the game went permanently mute.
    assert.equal(audio.setCar('sikandar-diesel'), true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(audio.ready, true, 'the engine rebuilt itself without another user gesture');
    assert.equal(audio.spec.cylinders, 4, 'a four-cylinder diesel');
    assert.equal(audio.spec.character, 'turbo-diesel');
    assert.deepEqual(audio.spec.firingOrder, [1, 3, 4, 2]);

    const cylinders = ofKind(created, 'oscillator').filter((node) => node.wave && !node.stopped);
    assert.equal(cylinders.length, 4, 'exactly four live cylinder oscillators after the swap');
    const stoppedBeds = loopBeds(created).filter((node) => node.stopped);
    const liveBeds = loopBeds(created).filter((node) => !node.stopped);
    assert.equal(stoppedBeds.length, 3, 'the V12 beds were torn down');
    assert.equal(liveBeds.length, 3, 'the diesel beds are loaded and running');

    // The diesel has a turbocharger whine node; the V12 did not.
    assert.ok(audio.spec.turbo, 'turbo spec present');

    // ...and it keeps making sound: a live master gain, driven by update().
    audio.update({ rpm: 2200, load: 0.6, throttle: 0.8, speedKmh: 40, slip: 0, gear: 2 });
    const masters = ofKind(created, 'gain').filter((node) => node.gain.value > 0);
    assert.ok(masters.length > 0, 'gains are open after an update');
    const frequencies = ofKind(created, 'oscillator').filter((node) => node.wave && !node.stopped).map((node) => node.frequency.value);
    assert.ok(frequencies.every((value) => Math.abs(value - 2200 / 120) < 1), `cylinders run at rpm/120: ${frequencies.join(', ')}`);
  });
});

test('update() automates the engine: layers, resonance, throttle tone, gear dips', async () => {
  await withAudio('aurora-v12', async ({ audio, created, StubContext }) => {
    await audio.unlock();
    const beds = loopBeds(created);
    assert.equal(beds.length, 3);

    // Idle: every bed is pitched to rpm / referenceRpm.
    audio.update({ rpm: 950, load: 0.05, throttle: 0, speedKmh: 0, slip: 0, gear: 1 });
    for (const [index, bed] of beds.entries()) {
      const reference = audio.spec.layers[index].referenceRpm;
      const expected = Math.min(3.2, Math.max(0.35, 950 / reference));
      assert.ok(Math.abs(bed.playbackRate.value - expected) < 0.02, `bed ${index} idles at ${bed.playbackRate.value}`);
    }

    // Redline: the high bed is at 1.0 (its own reference) and the low bed hits
    // the pitch clamp rather than screaming five octaves up — the crossfade has
    // it at ~0 weight by then anyway.
    audio.update({ rpm: 8200, load: 1, throttle: 1, speedKmh: 160, slip: 0, gear: 6 });
    for (const [index, bed] of beds.entries()) {
      const reference = audio.spec.layers[index].referenceRpm;
      const expected = Math.min(3.2, Math.max(0.35, 8200 / reference));
      assert.ok(Math.abs(bed.playbackRate.value - expected) < 0.02, `bed ${index} pitched to ${bed.playbackRate.value}, expected ${expected}`);
    }
    assert.ok(Math.abs(beds.at(-1).playbackRate.value - 1) < 0.02, 'the high bed is at its reference RPM');
    assert.ok(beds[0].playbackRate.value === 3.2, 'the low bed is clamped, not pitched into a chipmunk');

    // On throttle: the shelf opens and the drive curve hardens.
    const shelf = ofKind(created, 'biquad').find((node) => node.type === 'highshelf');
    assert.ok(shelf.gain.value > 5, `high shelf open under load: ${shelf.gain.value}`);
    const shaper = ofKind(created, 'shaper')[0];
    assert.ok(shaper.curve && shaper.curve.length === 1024, 'a drive curve is installed');
    const wotCurve = shaper.curve;
    audio.update({ rpm: 8200, load: 0.1, throttle: 0, speedKmh: 160, slip: 0, gear: 6 });
    assert.ok(shelf.gain.value < 0, `the shelf closes when the driver lifts: ${shelf.gain.value}`);
    assert.notEqual(shaper.curve, wotCurve, 'and the drive softens');

    // A gear change triggers the dip envelope on both the bus and the pulses.
    // The envelope is driven from `context.currentTime`, so the stub clock has
    // to advance or every frame would read as the instant of the shift.
    const context = StubContext.instances.at(-1);
    const tick = (params) => {
      context.currentTime += 1 / 60;
      audio.update(params);
    };
    const frame = (gear) => ({ rpm: 6000, load: 0.8, throttle: 1, speedKmh: 120, slip: 0, gear });
    // Gains that sit open (≈1) before the shift: the bus and the pulse dip are
    // the only ones, since the level gains legitimately sit well below unity.
    tick(frame(4));
    const openGains = ofKind(created, 'gain').filter((node) => node.gain.value > 0.99);
    assert.ok(openGains.length >= 2, `${openGains.length} unity gains in the chain`);

    tick(frame(5)); // the shift itself
    tick(frame(5));
    tick(frame(5));
    const dipped = openGains.filter((node) => node.gain.value < 0.95);
    assert.ok(dipped.length >= 2, `the shift pulled ${dipped.length} gains down`);
    // The pulse dip is squared, so it goes deeper than the bus.
    assert.ok(Math.min(...dipped.map((node) => node.gain.value)) < 0.7, `deep enough to hear: ${dipped.map((node) => node.gain.value.toFixed(2)).join(', ')}`);

    // ...and it recovers, so the dip is an envelope and not a mute.
    for (let index = 0; index < 40; index += 1) tick(frame(5));
    for (const node of openGains) {
      assert.ok(node.gain.value > 0.99, `recovered to ${node.gain.value}`);
    }
  });
});

test('a missing engine index still leaves a working engine (no silent car)', async () => {
  const StubContext = createStubAudioContext();
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => { throw new Error('404'); }, arrayBuffer: async () => new ArrayBuffer(0) });
  globalThis.window = { AudioContext: StubContext, setTimeout, clearTimeout };
  const { createEngineAudio } = await import(`../src/game/audio.js?offline=${Math.random()}`);
  const audio = createEngineAudio({ carId: 'sikandar-diesel' });
  try {
    assert.equal(await audio.unlock(), true, 'unlock still succeeds');
    assert.equal(audio.spec.cylinders, 4, 'the offline spec describes the right engine');
    assert.deepEqual(audio.spec.layers, [], 'with no beds to load');
    const cylinders = ofKind(StubContext.created, 'oscillator').filter((node) => node.wave);
    assert.equal(cylinders.length, 4, 'the pulse train runs without any WAV');
    audio.update({ rpm: 2000, load: 0.5, throttle: 0.7, speedKmh: 30, slip: 0, gear: 2 });
    assert.ok(cylinders.every((node) => node.frequency.value > 15), 'and is pitched by RPM');
  } finally {
    audio.dispose();
    delete globalThis.window;
  }
});

test('the horn has its own path to the output and reports its level', async () => {
  await withAudio('aurora-v12', async ({ audio, created }) => {
    await audio.unlock();
    const analysers = ofKind(created, 'analyser');
    assert.equal(analysers.length, 1, 'an analyser proves the horn is audible');
    audio.setHorn(true);
    assert.equal(audio.hornHeld, true);
    assert.ok(ofKind(created, 'bufferSource').some((node) => node.loop && node.started), 'the horn loop is running');
    assert.ok(Number.isFinite(audio.hornLevel()));
    audio.setHorn(false);
    assert.equal(audio.hornHeld, false);
  });
});

test('dispose() stops the oscillators and closes the context', async () => {
  const StubContext = createStubAudioContext();
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^\//, '');
    const body = readFileSync(new URL(path, PUBLIC));
    return { ok: true, status: 200, json: async () => JSON.parse(body.toString('utf8')), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  globalThis.window = { AudioContext: StubContext, setTimeout, clearTimeout };
  const { createEngineAudio } = await import(`../src/game/audio.js?dispose=${Math.random()}`);
  const audio = createEngineAudio({ carId: 'aurora-v12' });
  await audio.unlock();
  const cylinders = ofKind(StubContext.created, 'oscillator').filter((node) => node.wave);
  assert.ok(cylinders.every((node) => node.started));
  audio.dispose();
  assert.ok(cylinders.every((node) => node.stopped), 'every cylinder oscillator was stopped');
  assert.equal(StubContext.instances[0].state, 'closed');
  assert.equal(audio.enabled, false);
  // A disposed engine must not throw when the game keeps ticking.
  audio.update({ rpm: 3000, load: 0.5, throttle: 0.5, speedKmh: 60, slip: 0, gear: 3 });
  delete globalThis.window;
});

test('the shipped index describes both engines and every bed file exists', () => {
  assert.equal(INDEX.license, 'CC0 1.0');
  assert.equal(INDEX.engines.length, 2);
  for (const engine of INDEX.engines) {
    assert.equal(engine.layers.length, 3, `${engine.id} ships low / mid / high beds`);
    assert.ok(engine.cylinders >= 4 && engine.firingOrder.length === engine.cylinders);
    assert.equal(engine.resonanceHz.length, 3, 'primary, secondary and Helmholtz resonances');
    for (const layer of engine.layers) {
      // Each loop is a whole number of firing cycles, so it is seamless when
      // pitched by playbackRate = rpm / referenceRpm.
      const cycles = layer.loopSeconds * (layer.referenceRpm / 60) * (engine.cylinders / 2);
      assert.ok(Math.abs(cycles - Math.round(cycles)) < 0.25, `${engine.id}/${layer.id}: ${cycles.toFixed(3)} cycles`);
      const bytes = readFileSync(new URL(layer.file.replace(/^\//, ''), PUBLIC));
      assert.ok(bytes.length > 1000, `${layer.file} exists (${bytes.length} bytes)`);
      assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
    }
  }
  const v12 = INDEX.engines.find((engine) => engine.id === 'aurora-v12');
  const diesel = INDEX.engines.find((engine) => engine.id === 'sikandar-diesel');
  assert.ok(v12.redlineRpm > diesel.redlineRpm * 1.5, 'a V12 petrol and a turbo-diesel are not the same engine');
  assert.ok(v12.resonanceHz[0] > diesel.resonanceHz[0] * 1.5, 'and their exhausts are tuned differently');
});
