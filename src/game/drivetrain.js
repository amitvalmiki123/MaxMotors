/**
 * Drivetrain model shared by the HUD, the engine audio synth, and the tests.
 *
 * Pure math, no DOM/three.js: `npm test` covers the gear/RPM behaviour directly.
 * RPM is derived from wheel speed through a gearbox so the needle, the engine
 * note, and the shifting feel all agree with the physics simulation.
 *
 * M2.6: the model is driven by an explicit P/R/N/D selector instead of inferring
 * reverse from a negative road speed. That is what makes `S` in D brake-only:
 * the automatic gearbox can no longer select reverse because the car happens to
 * be rolling backwards, it can only do so when the driver puts the gate in R.
 */

import { normalizeSelector } from './input.js';

export const DEFAULT_GEARBOX = Object.freeze({
  idleRpm: 900,
  redlineRpm: 8200,
  shiftUpRpm: 7400,
  shiftDownRpm: 3600,
  finalDrive: 3.6,
  /** Index 0 is neutral, then gears 1..N as total ratios. */
  ratios: [0, 3.55, 2.31, 1.71, 1.34, 1.09, 0.91, 0.78],
  reverseRatio: 3.2,
  /** Wheel radius used to convert km/h into engine speed. */
  wheelRadius: 0.38,
  /** Free-rev ceiling in P/N, so an empty throttle-blip does not hit redline. */
  neutralRevLimit: 0.92,
});

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function mergeGearbox(overrides = {}) {
  return { ...DEFAULT_GEARBOX, ...overrides };
}

/** Wheel rotational speed (rad/s) for a given road speed. */
export function wheelAngularVelocity(speedKmh, gearbox = DEFAULT_GEARBOX) {
  const radius = gearbox.wheelRadius || DEFAULT_GEARBOX.wheelRadius;
  return (speedKmh / 3.6) / radius;
}

export function rpmForGear(speedKmh, gear, gearbox = DEFAULT_GEARBOX) {
  const ratio = gear === 0 ? 0 : gear < 0 ? gearbox.reverseRatio : gearbox.ratios[gear] ?? gearbox.ratios.at(-1);
  if (!ratio) return gearbox.idleRpm;
  const rpm = (wheelAngularVelocity(speedKmh, gearbox) * ratio * gearbox.finalDrive * 60) / (2 * Math.PI);
  return rpm;
}

/**
 * Chooses a gear for the current speed, then reports the resulting RPM.
 *
 * @param {object} params
 * @param {number} params.speedKmh signed road speed (negative = rolling backwards)
 * @param {number} [params.gear] current gear (1..N); 0 or negative is coerced
 * @param {number} [params.throttle] 0..1, for idle flare and the neutral rev
 * @param {object} [params.gearbox]
 * @param {'P'|'R'|'N'|'D'} [params.selector] transmission gate, default 'D'
 * @returns {{gear: number, rpm: number, selector: string, gearCount?: number, shifted: boolean, drive: boolean}}
 *          `gear` is 0 in P/N, -1 in R, 1..N in D. `drive` says whether the
 *          gearbox is delivering torque (false in P and N).
 */
export function shift({ speedKmh, gear = 1, throttle = 0, gearbox = DEFAULT_GEARBOX, selector = 'D' }) {
  const config = mergeGearbox(gearbox);
  const position = normalizeSelector(selector) ?? 'D';
  const revLimit = config.redlineRpm * (config.neutralRevLimit ?? 0.92);
  // Off-throttle the engine settles to idle; on throttle it free-revs, but only
  // up to the limiter — a parked car should not scream at 8600 rpm.
  const freeRev = clamp(config.idleRpm + throttle * 3200, config.idleRpm * 0.9, revLimit);

  if (position === 'P' || position === 'N') {
    // No torque path: the engine is disconnected from the wheels, so the needle
    // follows the throttle alone and the road speed is irrelevant.
    return { gear: 0, rpm: freeRev, selector: position, shifted: false, drive: false };
  }

  if (position === 'R') {
    const rolling = rpmForGear(Math.abs(speedKmh), -1, config);
    const rpm = speedKmh > -1.5 ? freeRev : clamp(Math.max(rolling, config.idleRpm * 0.9), config.idleRpm * 0.7, revLimit);
    return {
      gear: -1,
      rpm,
      selector: position,
      gearCount: 1,
      shifted: gear !== -1,
      drive: true,
    };
  }

  // --- D: forward automatic ------------------------------------------------
  let nextGear = clamp(Math.round(gear <= 0 ? 1 : gear), 1, config.ratios.length - 1);
  const requested = Math.round(gear);
  // Rolling backwards in D (pushed, or on a slope) does not select reverse; the
  // converter just slips, and the needle reads from the wheel speed.
  const forwardSpeed = Math.max(0, speedKmh);
  const rpmAt = (candidate) => rpmForGear(forwardSpeed, candidate, config);
  let rpm = rpmAt(nextGear);

  // Shift up at the redline, down when the engine would bog.
  while (rpm > config.shiftUpRpm && nextGear < config.ratios.length - 1) {
    nextGear += 1;
    rpm = rpmAt(nextGear);
  }
  while (rpm < config.shiftDownRpm && nextGear > 1) {
    nextGear -= 1;
    rpm = rpmAt(nextGear);
  }

  // Clutch slip: at very low speed the engine free-revs above the wheel speed.
  const idleTarget = config.idleRpm + throttle * 900;
  if (forwardSpeed < 8) {
    rpm = Math.max(rpm, idleTarget * (1 - forwardSpeed / 8) + rpm * (forwardSpeed / 8));
  }
  if (speedKmh < 0) {
    // Backing up in D: the wheels are turning the engine backwards, which reads
    // as a low, slipping idle rather than as a negative gear.
    rpm = Math.max(rpm, config.idleRpm * 0.8 + Math.min(Math.abs(speedKmh) * 12, config.idleRpm));
  }

  return {
    gear: nextGear,
    rpm: clamp(rpm, config.idleRpm * 0.7, config.redlineRpm),
    gearCount: config.ratios.length - 1,
    selector: position,
    shifted: Number.isFinite(requested) && requested !== nextGear && requested >= 1,
    drive: true,
  };
}

/** Normalised 0..1 engine load used for audio gain and the HUD bar. */
export function engineLoad({ rpm, throttle = 0, gearbox = DEFAULT_GEARBOX, selector = 'D' }) {
  const config = mergeGearbox(gearbox);
  const position = normalizeSelector(selector) ?? 'D';
  // In P/N there is no load on the engine at all — it is off the driveline, so
  // a rev is loud but empty (the audio uses `load` for the exhaust note).
  if (position === 'P' || position === 'N') return clamp(throttle * 0.12, 0, 0.15);
  const normalized = clamp(
    (rpm - config.idleRpm) / Math.max(1, config.redlineRpm - config.idleRpm),
    0,
    1,
  );
  return clamp(normalized * 0.72 + throttle * 0.28, 0, 1);
}
