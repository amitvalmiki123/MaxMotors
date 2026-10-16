/**
 * Engine audio: a physical-ish engine model in WebAudio, per car.
 *
 * M2.6 replaces the M2 "two loop beds pitched by load" approach with a proper
 * per-engine model. Everything below is driven by the engine spec shipped in
 * `public/audio/engine.index.json` (written by scripts/assets/build-audio.mjs):
 *
 *   1. **Per-cylinder firing pulses.** One OscillatorNode per cylinder, each
 *      running a `PeriodicWave` that is a single cylinder's pressure curve —
 *      a sharp combustion rise into an exponential blow-down — at the
 *      four-stroke rate (one power stroke per two revolutions, so `rpm / 120`).
 *      The cylinders are staggered by their position in the engine's *firing
 *      order*, which is baked into each wave's Fourier phase rather than into
 *      the oscillator's start offset: a start offset is a fixed number of
 *      seconds, so it would drift out of phase every time the RPM changed,
 *      whereas a phase-rotated wave stays exactly staggered at any RPM.
 *      A V12 (12 evenly spaced events) comes out smooth and turbine-like; the
 *      SUV's four-cylinder 1-3-4-2 order comes out lumpy, as a diesel should.
 *   2. **Exhaust resonance.** The summed pulse train runs through a bank of
 *      bandpass filters tuned to the engine's own exhaust frequencies (primary
 *      tube, secondary, Helmholtz), which follow RPM. This is what turns a buzz
 *      into an exhaust note, and it is why the V12 and the diesel — which share
 *      no code — do not sound alike.
 *   3. **RPM-blended low/mid/high layers.** Three CC0 loop beds per engine
 *      (recorded at 1400/4200/8200 rpm for the V12, 900/2100/4400 for the
 *      diesel), pitched by `playbackRate = rpm / referenceRpm` and crossfaded
 *      against *RPM*, not load: an engine's timbre follows its speed.
 *   4. **On/off-throttle tone.** On throttle a high-shelf opens up and the
 *      pulse drive hardens (combustion under load); off throttle the shelf
 *      closes, an overrun tone rises with RPM, and a burble LFO modulates the
 *      pulse amplitude so lifting at 7000 rpm sounds like fuel cut, not silence.
 *   5. **Gear-shift dips.** A change of gear triggers a short amplitude dip on
 *      both the engine bus and (deeper) the pulse train — the clutch
 *      disengaging — then a recovery, so shifts are audible.
 *
 * Also fixed here: `setCar()` used to tear the layers down and set
 * `started = false`, and nothing ever called `unlock()` again — so switching to
 * the SUV left the game permanently silent. It now reloads and restarts the new
 * engine itself, and the synthesised pulse train runs even when the loop beds
 * cannot be fetched, so a car can never be silent because a WAV 404'd.
 *
 * Audio only starts after a user gesture (browser policy) and every entry point
 * is defensive: if the AudioContext is missing, the game simply stays silent.
 */

const LOOP_MATCH_TOLERANCE = 0.25;

/**
 * Offline engine specs, used only when `engine.index.json` cannot be fetched.
 * They mirror scripts/assets/build-audio.mjs so the synth still describes the
 * right engine (the loop beds are then simply absent).
 */
const FALLBACK_SPECS = Object.freeze({
  'aurora-v12': {
    character: 'petrol-v12',
    cylinders: 12,
    firingOrder: [1, 7, 5, 11, 3, 9, 6, 12, 2, 8, 4, 10],
    idleRpm: 950,
    redlineRpm: 8600,
    resonanceHz: [118, 268, 690],
    resonanceQ: [5.5, 4.0, 2.6],
    resonanceGain: [1.0, 0.62, 0.34],
    pulseDecay: 6.5,
    layers: [],
  },
  'sikandar-diesel': {
    character: 'turbo-diesel',
    cylinders: 4,
    firingOrder: [1, 3, 4, 2],
    idleRpm: 750,
    redlineRpm: 5200,
    resonanceHz: [58, 132, 286],
    resonanceQ: [7.0, 5.0, 3.0],
    resonanceGain: [1.0, 0.72, 0.3],
    pulseDecay: 3.6,
    turbo: { whineHz: 920, whineRatio: 2.6, gain: 0.12 },
    layers: [],
  },
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Power pulses per second for a four-stroke engine: one per cylinder per 2 revs. */
export function firingFrequency(rpm, cylinders) {
  return (Math.max(0, rpm) / 60) * (Math.max(1, cylinders) / 2);
}

/**
 * Each cylinder's oscillator runs at the four-stroke cycle rate, not the firing
 * rate: the summed bank produces the firing frequency.
 */
export function cylinderOscillatorHz(rpm) {
  return Math.max(0, rpm) / 120;
}

/**
 * Position of each firing event within one 720° cycle, as a fraction 0..1.
 *
 * An even-firing four-stroke spaces its events 720°/N apart; the firing order
 * decides which cylinder fires at each event, and the small label-derived jitter
 * is what stops a cross-plane order from sounding like a metronome.
 */
export function cylinderFiringOffsets(cylinders, firingOrder = null) {
  const count = Math.max(1, firingOrder?.length ?? cylinders);
  const offsets = [];
  for (let event = 0; event < count; event += 1) {
    const label = firingOrder?.[event] ?? event + 1;
    offsets.push(event / count + ((label % 3) - 1) * 0.0035);
  }
  return offsets;
}

/**
 * Fourier coefficients of one cylinder's pressure pulse, phase-rotated by `tau`.
 *
 * The blow-down is a pure exponential over one cycle, whose coefficients are
 * closed form — `∫₀¹ e^{-dt} e^{-i2πkt} dt = (1 - e^{-d}) / (d + i2πk)` — so
 * this is exact and costs O(harmonics) instead of a DFT. `rollOffK` models the
 * finite combustion rise time as a second-order low-pass on the pulse: pressure
 * cannot rise instantaneously, and without it the wave is a click.
 *
 * @param {number} tau phase offset as a fraction of the cycle (0..1)
 * @returns {{real: Float32Array, imag: Float32Array}}
 */
export function pulseWaveCoefficients({ decay = 6, harmonics = 128, rollOffK = 34, tau = 0 } = {}) {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  const scale = 1 - Math.exp(-decay);
  for (let k = 1; k <= harmonics; k += 1) {
    const w = 2 * Math.PI * k;
    const denominator = decay * decay + w * w;
    const rollOff = 1 / (1 + (k / rollOffK) ** 2);
    const a = ((2 * scale * decay) / denominator) * rollOff;
    const b = ((2 * scale * w) / denominator) * rollOff;
    const theta = 2 * Math.PI * k * tau;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    // x(t - tau): rotate the coefficients, which keeps the phase exact at any
    // playback frequency (a start() offset would not).
    real[k] = a * cos - b * sin;
    imag[k] = a * sin + b * cos;
  }
  return { real, imag };
}

/**
 * Crossfade weights for the low/mid/high loop beds, from RPM.
 *
 * Each layer owns a `referenceRpm`; the weight peaks at 1 there and falls off
 * towards its neighbours on a log scale (engine pitch is perceived
 * logarithmically), so the sum stays near 1 across the whole rev range and a
 * crossfade is a timbre change rather than a volume change.
 *
 * @param {number} rpm
 * @param {Array<{referenceRpm: number}>} layers
 * @returns {number[]} weights, same order as `layers`
 */
export function layerWeights(rpm, layers = []) {
  if (!layers.length) return [];
  if (layers.length === 1) return [1];
  const speed = Math.max(1, rpm);
  const references = layers.map((layer) => Math.max(1, layer.referenceRpm ?? 1000));
  const width = 0.85; // octaves of overlap between neighbouring beds
  const raw = references.map((reference) => {
    const octaves = Math.log2(speed / reference);
    return Math.exp(-(octaves * octaves) / (2 * width * width));
  });
  // Keep the extremes from collapsing to nothing below idle / above redline.
  const first = references.indexOf(Math.min(...references));
  const last = references.indexOf(Math.max(...references));
  if (speed <= references[first]) raw[first] = Math.max(raw[first], 1);
  if (speed >= references[last]) raw[last] = Math.max(raw[last], 1);
  const total = raw.reduce((sum, value) => sum + value, 0) || 1;
  return raw.map((value) => value / total);
}

/**
 * Exhaust resonance frequencies at `rpm`.
 *
 * The pipes are physical and their tuning is *nearly* fixed — that is the whole
 * point. A sharp cylinder pulse is broadband, and a bandpass at the pipe's own
 * frequency picks out whichever harmonic of the firing order currently lands
 * there. As the revs climb the harmonics sweep past the tune, so the exhaust
 * "sings" at some revs and goes quiet at others, exactly as a real system does.
 * Only a mild drift is applied (hotter, faster gas raises the effective tune by
 * a few percent), because tracking RPM outright would turn the pipes into a
 * second oscillator and lose that behaviour.
 */
export function exhaustResonance(spec, rpm) {
  const base = spec?.resonanceHz?.length ? spec.resonanceHz : [110, 260, 640];
  const idle = Math.max(1, spec?.idleRpm ?? 900);
  const ratio = clamp(0.92 + 0.1 * Math.log2(clamp(rpm, idle * 0.6, idle * 12) / idle), 0.85, 1.2);
  return base.map((frequency) => clamp(frequency * ratio, 24, 6800));
}

/**
 * Off-throttle overrun level, 0..1. Zero on throttle; rising with RPM when the
 * driver has lifted but the engine is still being dragged by the car.
 */
export function overrunLevel({ rpm, throttle = 0, idleRpm = 900, redlineRpm = 8000 }) {
  const lifted = clamp(1 - throttle * 2.4, 0, 1);
  const revs = clamp((rpm - idleRpm) / Math.max(1, redlineRpm - idleRpm), 0, 1);
  return clamp(lifted * (0.25 + revs * 0.95), 0, 1);
}

/** On-throttle brightness, 0..1: combustion under load opens the note up. */
export function throttleTone({ throttle = 0, rpm, idleRpm = 900 }) {
  const revs = clamp((rpm - idleRpm * 0.8) / 2600, 0, 1);
  return clamp(throttle * (0.55 + revs * 0.45), 0, 1);
}

/** Total length of the shift-dip envelope, in seconds (see shiftDipEnvelope). */
export const SHIFT_DIP_SECONDS = 0.31;

/**
 * Gear-shift dip envelope. `elapsed` is seconds since the shift; returns a gain
 * multiplier: a fast drop (clutch out) and a slower recovery (clutch back in).
 */
export function shiftDipEnvelope(elapsed, { dip = 0.05, hold = 0.02, recover = 0.24, depth = 0.28 } = {}) {
  if (elapsed < 0) return 1;
  if (elapsed < dip) return 1 - (1 - depth) * (elapsed / dip);
  if (elapsed < dip + hold) return depth;
  const t = (elapsed - dip - hold) / recover;
  if (t >= 1) return 1;
  // Smoothstep back to unity so the recovery is not a straight line.
  return depth + (1 - depth) * (t * t * (3 - 2 * t));
}

/** Diesel/petrol character switch used for drive amount and noise balance. */
function isDiesel(spec) {
  return spec?.character === 'turbo-diesel';
}

export function createEngineAudio({ carId, tier } = {}) {
  const AudioContextClass = typeof window !== 'undefined'
    ? (window.AudioContext ?? window.webkitAudioContext)
    : null;
  if (!AudioContextClass) return createSilentEngine();

  let context = null;
  let master = null;
  let engineBus = null;
  let dipGain = null;
  let shelf = null;
  let shaper = null;
  let resonators = [];
  let resonanceBus = null;
  let pulseGain = null;
  let pulseDip = null;
  let driveCurve = 0;
  let overrunOsc = null;
  let overrunGain = null;
  let burbleOsc = null;
  let burbleGain = null;
  let turboOsc = null;
  let turboGain = null;
  let cylinders = [];
  let layers = [];
  let spec = null;
  let noiseSource = null;
  let noiseGain = null;
  let started = false;
  let disposed = false;
  let index = null;
  let indexPromise = null;
  let currentCar = carId ?? null;
  let loadToken = 0;
  let volume = tier?.mobile ? 0.5 : 0.7;
  let lastGear = null;
  let shiftAt = -1;
  // Horn: its own gain straight to the output (engine load must not duck it),
  // with an analyser so the HUD / tests can tell it is actually sounding.
  let hornBuffer = null;
  let hornSource = null;
  let hornGain = null;
  let hornAnalyser = null;
  let hornHeld = false;
  let hornStopTimer = 0;
  let mutedNow = false;

  function fetchIndex() {
    if (index) return Promise.resolve(index);
    if (!indexPromise) {
      indexPromise = fetch('/audio/engine.index.json')
        .then((response) => {
          if (!response.ok) throw new Error(`engine.index.json -> ${response.status}`);
          return response.json();
        })
        .then((data) => {
          index = data;
          return data;
        })
        .catch((error) => {
          indexPromise = null;
          throw error;
        });
    }
    return indexPromise;
  }

  /** Spec for the current car: the shipped index, or the offline fallback. */
  async function resolveSpec() {
    const fallback = FALLBACK_SPECS[currentCar] ?? { cylinders: 8, layers: [] };
    try {
      const data = await fetchIndex();
      const engine = data.engines?.find((entry) => entry.id === currentCar);
      if (!engine) throw new Error(`no engine profile for ${currentCar}`);
      return { ...fallback, ...engine, layers: engine.layers ?? [] };
    } catch (error) {
      // The synthesised pulse train does not need the WAVs, so a missing index
      // must never leave the car silent (that was the M2.5 SUV bug's twin).
      console.info('MaxMotors engine index unavailable, synthesising:', error.message);
      return { ...fallback, layers: [] };
    }
  }

  function ensureContext() {
    if (context) return context;
    context = new AudioContextClass();
    master = context.createGain();
    master.gain.value = 0;
    master.connect(context.destination);
    return context;
  }

  /** Builds the fixed part of the graph (bus, resonators, overrun, turbo). */
  function buildEngineGraph() {
    engineBus = context.createGain();
    engineBus.gain.value = 1;

    // Gear-shift dip sits between the engine and the master so it ducks the
    // whole note, not just one part of it.
    dipGain = context.createGain();
    dipGain.gain.value = 1;

    // On/off-throttle tone: a high shelf that opens under load and closes when
    // the driver lifts.
    shelf = context.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 1400;
    shelf.gain.value = 0;

    // Combustion drive: a soft clipper that hardens the pulse under load.
    shaper = context.createWaveShaper();
    shaper.curve = createDriveCurve(isDiesel(spec) ? 1.6 : 3.2);
    shaper.oversample = '2x';

    // Exhaust resonance bank.
    resonanceBus = context.createGain();
    resonanceBus.gain.value = 0.85;
    resonators = (spec?.resonanceHz ?? [110, 260, 640]).map((frequency, position) => {
      const filter = context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = frequency;
      filter.Q.value = spec?.resonanceQ?.[position] ?? 4;
      const gain = context.createGain();
      gain.gain.value = spec?.resonanceGain?.[position] ?? 0.5;
      gain.connect(filter);
      filter.connect(resonanceBus);
      return { filter, gain };
    });

    // A tail-pipe lowpass keeps the resonances from sounding like a synth lead.
    const tail = context.createBiquadFilter();
    tail.type = 'lowpass';
    tail.frequency.value = isDiesel(spec) ? 2600 : 5200;
    tail.Q.value = 0.4;

    pulseGain = context.createGain();
    pulseGain.gain.value = 0;
    // The shift dip lives on its own node so `update()` can keep setting the
    // pulse level every frame without fighting a scheduled ramp.
    pulseDip = context.createGain();
    pulseDip.gain.value = 1;

    // pulse train → dip → drive → shelf → { exhaust resonators, direct } → tail
    pulseGain.connect(pulseDip);
    pulseDip.connect(shaper);
    shaper.connect(shelf);
    // Each resonator is fed from the shelf: the summed cylinder pulses are what
    // the pipes ring against.
    for (const resonator of resonators) shelf.connect(resonator.gain);
    const direct = context.createGain();
    direct.gain.value = isDiesel(spec) ? 0.85 : 0.6;
    shelf.connect(direct);
    resonanceBus.connect(tail);
    direct.connect(tail);
    tail.connect(dipGain);

    // Off-throttle overrun tone: a hollow, leaning column of air.
    overrunOsc = context.createOscillator();
    overrunOsc.type = isDiesel(spec) ? 'triangle' : 'sawtooth';
    overrunOsc.frequency.value = 90;
    const overrunFilter = context.createBiquadFilter();
    overrunFilter.type = 'bandpass';
    overrunFilter.frequency.value = isDiesel(spec) ? 220 : 480;
    overrunFilter.Q.value = 2.2;
    overrunGain = context.createGain();
    overrunGain.gain.value = 0;
    overrunOsc.connect(overrunFilter);
    overrunFilter.connect(overrunGain);
    overrunGain.connect(dipGain);
    overrunOsc.start();

    // Burble LFO: modulates the pulse amplitude off throttle so a lift at high
    // RPM reads as fuel cut / overrun burble instead of as silence.
    burbleOsc = context.createOscillator();
    burbleOsc.type = 'sine';
    burbleOsc.frequency.value = isDiesel(spec) ? 9 : 17;
    burbleGain = context.createGain();
    burbleGain.gain.value = 0;
    burbleOsc.connect(burbleGain);
    burbleGain.connect(pulseGain.gain);
    burbleOsc.start();

    // Turbocharger whine (diesel only).
    if (spec?.turbo) {
      turboOsc = context.createOscillator();
      turboOsc.type = 'sine';
      turboOsc.frequency.value = spec.turbo.whineHz ?? 900;
      turboGain = context.createGain();
      turboGain.gain.value = 0;
      turboOsc.connect(turboGain);
      turboGain.connect(dipGain);
      turboOsc.start();
    }

    dipGain.connect(engineBus);
    engineBus.connect(master);
  }

  function createDriveCurve(amount) {
    const frames = 1024;
    const curve = new Float32Array(frames);
    for (let index = 0; index < frames; index += 1) {
      const x = (index / (frames - 1)) * 2 - 1;
      curve[index] = Math.tanh(x * amount) / Math.tanh(amount);
    }
    return curve;
  }

  /** One oscillator per cylinder, each phase-rotated to its firing event. */
  function buildCylinders() {
    const count = Math.max(1, spec?.cylinders ?? 8);
    const offsets = cylinderFiringOffsets(count, spec?.firingOrder ?? null);
    const decay = spec?.pulseDecay ?? (isDiesel(spec) ? 3.6 : 6.5);
    const harmonics = isDiesel(spec) ? 72 : 128;
    cylinders = offsets.map((tau) => {
      const { real, imag } = pulseWaveCoefficients({ decay, harmonics, tau });
      const wave = context.createPeriodicWave(real, imag, { disableNormalization: false });
      const oscillator = context.createOscillator();
      oscillator.setPeriodicWave(wave);
      oscillator.frequency.value = 8;
      oscillator.connect(pulseGain);
      oscillator.start();
      return oscillator;
    });
  }

  async function loadLayers() {
    if (!spec?.layers?.length) return [];
    const loaded = await Promise.all(spec.layers.map(async (layer) => {
      const response = await fetch(layer.file);
      if (!response.ok) throw new Error(`${layer.file} -> ${response.status}`);
      const buffer = await response.arrayBuffer();
      const decoded = await context.decodeAudioData(buffer);
      const source = context.createBufferSource();
      source.buffer = decoded;
      source.loop = true;
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = layer.id === 'low' ? 700 : layer.id === 'mid' ? 2000 : 3600;
      filter.Q.value = 0.5;
      const gain = context.createGain();
      gain.gain.value = 0;
      source.connect(filter).connect(gain).connect(engineBus);
      source.start(0, Math.random() * (layer.loopSeconds ?? 1) * 0.5);
      return { ...layer, source, gain, filter, started: true };
    }));
    return loaded;
  }

  async function loadHorn() {
    if (hornBuffer) return;
    const data = await fetchIndex();
    const effect = data.effects?.find((entry) => entry.id === 'horn');
    if (!effect) return;
    const response = await fetch(effect.file);
    if (!response.ok) throw new Error(`${effect.file} -> ${response.status}`);
    hornBuffer = await context.decodeAudioData(await response.arrayBuffer());
    hornGain = context.createGain();
    hornGain.gain.value = 0;
    hornAnalyser = context.createAnalyser();
    hornAnalyser.fftSize = 1024;
    hornGain.connect(hornAnalyser).connect(context.destination);
  }

  function teardownEngine() {
    for (const oscillator of cylinders) {
      try {
        oscillator.stop();
      } catch { /* already stopped */ }
      oscillator.disconnect();
    }
    for (const layer of layers) {
      try {
        layer.source.stop();
      } catch { /* already stopped */ }
      layer.source.disconnect();
      layer.gain.disconnect();
      layer.filter.disconnect();
    }
    for (const node of [overrunOsc, burbleOsc, turboOsc]) {
      try {
        node?.stop();
      } catch { /* already stopped */ }
      node?.disconnect();
    }
    for (const node of [pulseGain, pulseDip, shaper, shelf, resonanceBus, dipGain, engineBus, ...resonators.flatMap((entry) => [entry.filter, entry.gain])]) {
      node?.disconnect?.();
    }
    cylinders = [];
    layers = [];
    resonators = [];
    pulseDip = null;
    driveCurve = 0;
    overrunOsc = null;
    burbleOsc = null;
    turboOsc = null;
  }

  /**
   * (Re)builds the engine for `currentCar`. Token-guarded so switching cars
   * twice in quick succession cannot leave two engines running.
   */
  async function buildEngine() {
    const token = ++loadToken;
    spec = await resolveSpec();
    if (token !== loadToken || disposed || !context) return false;
    teardownEngine();
    buildEngineGraph();
    buildCylinders();
    try {
      layers = await loadLayers();
    } catch (error) {
      // The beds are a nicety; the pulse train alone is still an engine.
      console.info('MaxMotors engine beds unavailable:', error.message);
      layers = [];
    }
    if (token !== loadToken || disposed) return false;
    started = true;
    lastGear = null;
    return true;
  }

  function applyHorn() {
    if (!context || !hornBuffer || !hornGain) return;
    const now = context.currentTime;
    const sounding = hornHeld && !mutedNow;
    if (sounding) {
      window.clearTimeout(hornStopTimer);
      if (!hornSource) {
        hornSource = context.createBufferSource();
        hornSource.buffer = hornBuffer;
        hornSource.loop = true;
        hornSource.connect(hornGain);
        hornSource.start();
      }
      hornGain.gain.cancelScheduledValues(now);
      hornGain.gain.setTargetAtTime(Math.min(1, volume * 0.85), now, 0.012);
    } else if (hornSource) {
      hornGain.gain.cancelScheduledValues(now);
      hornGain.gain.setTargetAtTime(0, now, 0.035);
      const source = hornSource;
      hornSource = null;
      hornStopTimer = window.setTimeout(() => {
        try {
          source.stop();
        } catch { /* already stopped */ }
      }, 300);
    }
  }

  function startTyreNoise() {
    if (noiseSource) return;
    const frames = context.sampleRate * 2;
    const buffer = context.createBuffer(1, frames, context.sampleRate);
    const channel = buffer.getChannelData(0);
    let smoothed = 0;
    for (let i = 0; i < frames; i += 1) {
      smoothed = smoothed * 0.96 + (Math.random() * 2 - 1) * 0.04;
      channel[i] = smoothed;
    }
    noiseSource = context.createBufferSource();
    noiseSource.buffer = buffer;
    noiseSource.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 480;
    filter.Q.value = 0.6;
    noiseGain = context.createGain();
    noiseGain.gain.value = 0;
    noiseSource.connect(filter).connect(noiseGain).connect(master);
    noiseSource.start();
  }

  /** Marks the moment of a gear change; `update()` plays the dip envelope. */
  function triggerShiftDip(now) {
    shiftAt = now;
  }

  /**
   * Drives the clutch-out / clutch-in envelope from the pure
   * `shiftDipEnvelope()`, so the shape the tests assert is the shape heard.
   *
   * The latch is only released once the envelope has run its full course, not
   * merely when it reads 1: `triggerShiftDip()` and this run in the same frame,
   * where `now - shiftAt` is still 0 and the envelope is at its starting value
   * of 1 — clearing on that would cancel every dip before it began.
   */
  function applyShiftDip(now) {
    if (shiftAt < 0) return 1;
    const elapsed = now - shiftAt;
    const envelope = shiftDipEnvelope(elapsed);
    dipGain.gain.setTargetAtTime(envelope, now, 0.008);
    // The pulse train drops harder than the whole bus: the torque path is what
    // actually opens when the clutch lifts.
    pulseDip.gain.setTargetAtTime(envelope * envelope, now, 0.008);
    if (elapsed > SHIFT_DIP_SECONDS) shiftAt = -1;
    return envelope;
  }

  return {
    get ready() {
      return Boolean(context && started);
    },
    get enabled() {
      return Boolean(context) && !disposed;
    },
    /** The engine spec in use (cylinders, firing order, layers) — diagnostics. */
    get spec() {
      return spec;
    },
    get carId() {
      return currentCar;
    },
    /** Called from a user gesture (button click / first key press). */
    async unlock() {
      if (disposed) return false;
      try {
        ensureContext();
        if (context.state === 'suspended') await context.resume();
        if (!started) await buildEngine();
        startTyreNoise();
        await loadHorn().catch((error) => console.info('MaxMotors horn unavailable:', error.message));
        applyHorn();
        return Boolean(started);
      } catch (error) {
        console.info('MaxMotors engine audio unavailable:', error.message);
        return false;
      }
    },
    /**
     * Switches the engine to another car. This used to leave the game silent:
     * it tore the layers down and set `started = false`, but only `unlock()`
     * (a user-gesture-only entry point) ever rebuilt them, and it is not called
     * again after the first click. It now rebuilds the engine itself when the
     * context already exists, and just records the choice when it does not.
     */
    setCar(nextCarId) {
      if (!nextCarId || nextCarId === currentCar) return false;
      currentCar = nextCarId;
      started = false;
      lastGear = null;
      if (!context || disposed) return false;
      // Fire and forget: the next update() frames stay silent until it lands,
      // and the token in buildEngine() drops a superseded rebuild.
      buildEngine().catch((error) => console.info('MaxMotors engine swap failed:', error.message));
      return true;
    },
    setVolume(value) {
      volume = Math.max(0, Math.min(1, value));
    },
    /** H key / HORN button: true while held. */
    setHorn(active) {
      if (hornHeld === Boolean(active)) return;
      hornHeld = Boolean(active);
      applyHorn();
    },
    get hornHeld() {
      return hornHeld;
    },
    /** RMS of the horn output (0 when silent) — proof it is audible. */
    hornLevel() {
      if (!hornAnalyser) return 0;
      const data = new Float32Array(hornAnalyser.fftSize);
      hornAnalyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const value of data) sum += value * value;
      return Math.sqrt(sum / data.length);
    },
    /**
     * @param {object} params
     * @param {number} params.rpm engine speed
     * @param {number} params.load 0..1 engine load
     * @param {number} params.throttle 0..1 smoothed throttle plate
     * @param {number} params.speedKmh road speed (tyre noise)
     * @param {number} params.slip 0..1 slip (tyre noise + engine strain)
     * @param {number} [params.gear] current gear, for the shift dip
     * @param {boolean} params.muted
     */
    update({ rpm = 900, load = 0, throttle = 0, speedKmh = 0, slip = 0, gear = null, muted = false } = {}) {
      if (mutedNow !== muted) {
        mutedNow = muted;
        applyHorn();
      }
      if (!started || disposed || !context) return;
      const now = context.currentTime;
      const idle = spec?.idleRpm ?? 900;
      const redline = spec?.redlineRpm ?? 8000;
      const revs = clamp((rpm - idle) / Math.max(1, redline - idle), 0, 1);

      // --- gear-shift dips -------------------------------------------------
      if (gear !== null && lastGear !== null && gear !== lastGear) triggerShiftDip(now);
      if (gear !== null) lastGear = gear;
      const dip = applyShiftDip(now);
      void dip;

      // --- master level ----------------------------------------------------
      // Idle must not be silent, and load opens the note up from there.
      const targetMaster = muted ? 0 : volume * (0.34 + load * 0.66) * (0.85 + revs * 0.15);
      master.gain.setTargetAtTime(targetMaster, now, 0.08);

      // --- per-cylinder pulse train ---------------------------------------
      const frequency = clamp(cylinderOscillatorHz(rpm), 2, 140);
      for (const oscillator of cylinders) {
        oscillator.frequency.setTargetAtTime(frequency, now, 0.025);
      }
      const onThrottle = throttleTone({ throttle, rpm, idleRpm: idle });
      const overrun = overrunLevel({ rpm, throttle, idleRpm: idle, redlineRpm: redline });
      const diesel = isDiesel(spec);
      // The pulse amplitude is mostly RPM and load; the diesel's is bigger at
      // low RPM because its combustion pressure rise is far sharper.
      const pulseLevel = (diesel ? 0.34 : 0.26) * (0.45 + revs * 0.55) * (0.6 + onThrottle * 0.75);
      pulseGain.gain.setTargetAtTime(pulseLevel, now, 0.06);
      // Burble depth: only off throttle, and only where there are revs to cut.
      burbleGain.gain.setTargetAtTime(overrun * pulseLevel * (diesel ? 0.35 : 0.6), now, 0.12);
      burbleOsc?.frequency.setTargetAtTime(diesel ? 7 + revs * 6 : 12 + revs * 14, now, 0.2);

      // --- exhaust resonance follows RPM ----------------------------------
      const frequencies = exhaustResonance(spec, rpm);
      for (const [position, resonator] of resonators.entries()) {
        resonator.filter.frequency.setTargetAtTime(frequencies[position] ?? frequencies.at(-1), now, 0.14);
      }

      // --- on/off-throttle tone -------------------------------------------
      // Under load the shelf opens and the drive hardens; lifted, both close so
      // the note goes hollow instead of just quiet.
      shelf.gain.setTargetAtTime(-6 + onThrottle * 16, now, 0.08);
      // Rebuilding a 1024-point curve every frame is pure waste (and makes the
      // WaveShaper re-allocate): only swap it when the drive actually moves.
      const drive = (diesel ? 1.4 : 2.2) + onThrottle * (diesel ? 1.4 : 2.6);
      if (Math.abs(drive - driveCurve) > 0.08) {
        driveCurve = drive;
        shaper.curve = createDriveCurve(drive);
      }
      overrunGain.gain.setTargetAtTime(overrun * (diesel ? 0.12 : 0.2), now, 0.1);
      overrunOsc?.frequency.setTargetAtTime(clamp(firingFrequency(rpm, spec?.cylinders ?? 8) * 0.5, 20, 900), now, 0.1);
      if (turboOsc && spec?.turbo) {
        // Compressor speed lags the crank, then whines above ~1500 rpm.
        const spool = clamp((rpm - 1300) / 2400, 0, 1);
        turboOsc.frequency.setTargetAtTime((spec.turbo.whineHz ?? 900) * (0.6 + spool * 1.4), now, 0.25);
        turboGain.gain.setTargetAtTime((spec.turbo.gain ?? 0.12) * spool * (0.4 + onThrottle * 0.6), now, 0.2);
      }

      // --- RPM-blended loop beds ------------------------------------------
      const weights = layerWeights(rpm, layers);
      for (const [position, layer] of layers.entries()) {
        const reference = layer.referenceRpm ?? 1600;
        const rate = clamp(rpm / reference, 0.35, 3.2);
        layer.source.playbackRate.setTargetAtTime(rate, now, 0.05);
        const weight = weights[position] ?? 0;
        // Beds sit under the synth: they supply the recorded texture (induction,
        // valvetrain, exhaust gas) while the pulse train supplies the pitch.
        const gain = weight * (diesel ? 0.5 : 0.42) * (0.5 + load * 0.5);
        layer.gain.gain.setTargetAtTime(muted ? 0 : gain, now, 0.12);
        const cutoff = 500 + revs * (diesel ? 2200 : 4200);
        layer.filter.frequency.setTargetAtTime(cutoff, now, 0.15);
      }

      // --- tyres -----------------------------------------------------------
      if (noiseGain) {
        const tyre = Math.min(0.22, (speedKmh / 140) * 0.12 + slip * 0.16);
        noiseGain.gain.setTargetAtTime(muted ? 0 : tyre, now, 0.1);
      }
    },
    /** Loop-bed sanity check used by `npm test` (no AudioContext involved). */
    matchesLoop({ rpm, referenceRpm, loopSeconds }) {
      const cycles = loopSeconds * (rpm / 60);
      return Math.abs(cycles - Math.round(cycles)) <= LOOP_MATCH_TOLERANCE;
    },
    dispose() {
      disposed = true;
      loadToken += 1;
      teardownEngine();
      try {
        noiseSource?.stop();
        hornSource?.stop();
      } catch { /* noop */ }
      noiseSource?.disconnect();
      master?.disconnect();
      context?.close?.();
      context = null;
    },
  };
}

function createSilentEngine() {
  return {
    ready: false,
    enabled: false,
    spec: null,
    carId: null,
    unlock: async () => false,
    setCar: () => false,
    setVolume: () => {},
    setHorn: () => {},
    hornHeld: false,
    hornLevel: () => 0,
    update: () => {},
    matchesLoop: () => true,
    dispose: () => {},
  };
}
