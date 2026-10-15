/**
 * Drivetrain model shared by the HUD, the engine audio synth, and the tests.
 *
 * Pure math, no DOM/three.js: `npm test` covers the gear/RPM behaviour directly.
 * RPM is derived from wheel speed through a gearbox so the needle, the engine
 * note, and the shifting feel all agree with the physics simulation.
 */

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
 * Chooses a gear for the current speed, then reports the resulting RPM plus the
 * throttle-independent "load" used for engine volume.
 */
export function shift({ speedKmh, gear = 1, throttle = 0, gearbox = DEFAULT_GEARBOX }) {
  const config = mergeGearbox(gearbox);
  const forward = speedKmh >= 0;
  let nextGear = gear;

  if (!forward) {
    return { gear: -1, rpm: clamp(config.idleRpm * 0.85 + Math.abs(speedKmh) * 12, config.idleRpm * 0.6, config.redlineRpm * 0.6) };
  }

  if (nextGear <= 0) nextGear = 1;
  nextGear = clamp(Math.round(nextGear), 1, config.ratios.length - 1);

  const rpmAt = (candidate) => rpmForGear(speedKmh, candidate, config);
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
  if (speedKmh < 8) {
    rpm = Math.max(rpm, idleTarget * (1 - speedKmh / 8) + rpm * (speedKmh / 8));
  }

  return {
    gear: nextGear,
    rpm: clamp(rpm, config.idleRpm * 0.7, config.redlineRpm),
    gearCount: config.ratios.length - 1,
  };
}

/** Normalised 0..1 engine load used for audio gain and the HUD bar. */
export function engineLoad({ rpm, throttle = 0, gearbox = DEFAULT_GEARBOX }) {
  const config = mergeGearbox(gearbox);
  const normalized = clamp(
    (rpm - config.idleRpm) / Math.max(1, config.redlineRpm - config.idleRpm),
    0,
    1,
  );
  return clamp(normalized * 0.72 + throttle * 0.28, 0, 1);
}
