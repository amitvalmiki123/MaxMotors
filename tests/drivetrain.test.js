import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_GEARBOX, engineLoad, rpmForGear, shift } from '../src/game/drivetrain.js';

test('rpm rises with road speed inside a gear and drops on the upshift', () => {
  const first = rpmForGear(40, 1, DEFAULT_GEARBOX);
  const second = rpmForGear(40, 2, DEFAULT_GEARBOX);
  const faster = rpmForGear(60, 1, DEFAULT_GEARBOX);

  assert.ok(first > DEFAULT_GEARBOX.idleRpm, 'a moving car should be above idle');
  assert.ok(second < first, 'a taller gear should turn fewer rpm at the same speed');
  assert.ok(faster > first, 'more speed in the same gear should rev higher');
});

test('the gearbox shifts up near the redline and back down when it bogs', () => {
  const high = shift({ speedKmh: 120, gear: 1, throttle: 1 });
  assert.ok(high.gear > 1, `expected an upshift, got gear ${high.gear}`);
  assert.ok(high.gear <= 3, `expected to settle near 120 km/h, got gear ${high.gear}`);
  assert.ok(high.rpm <= DEFAULT_GEARBOX.redlineRpm);

  const low = shift({ speedKmh: 6, gear: 5, throttle: 0.2 });
  assert.ok(low.gear < 5, `expected a downshift, got gear ${low.gear}`);
});

test('a standing car idles in D', () => {
  const idle = shift({ speedKmh: 0, gear: 1, throttle: 0 });
  assert.equal(idle.gear, 1);
  assert.equal(idle.selector, 'D');
  assert.ok(idle.drive, 'D delivers torque');
  assert.ok(idle.rpm >= DEFAULT_GEARBOX.idleRpm * 0.7);
});

test('reverse comes from the selector, not from a negative road speed (M2.6)', () => {
  // This is the "S in D must only brake" fix: rolling backwards in D used to be
  // read as "the driver wants reverse", so the gearbox selected -1 by itself.
  const rollingBackInDrive = shift({ speedKmh: -12, gear: 1, throttle: 0, selector: 'D' });
  assert.equal(rollingBackInDrive.gear, 1, 'D never selects reverse on its own');
  assert.equal(rollingBackInDrive.selector, 'D');
  assert.ok(rollingBackInDrive.rpm > 0, 'the needle still reads something sane');

  const reverse = shift({ speedKmh: -12, gear: 1, throttle: 0.4, selector: 'R' });
  assert.equal(reverse.gear, -1);
  assert.ok(reverse.drive, 'R delivers torque');
  assert.ok(reverse.rpm > DEFAULT_GEARBOX.idleRpm * 0.7);

  // A standing car in R, off throttle, sits at idle rather than screaming.
  const parkedReverse = shift({ speedKmh: 0, gear: -1, throttle: 0, selector: 'R' });
  assert.equal(parkedReverse.gear, -1);
  assert.ok(parkedReverse.rpm < DEFAULT_GEARBOX.idleRpm * 1.6, `idle in R, got ${parkedReverse.rpm}`);
});

test('P and N disconnect the engine: gear 0, no torque, throttle-only revs', () => {
  for (const selector of ['P', 'N']) {
    const parked = shift({ speedKmh: 140, gear: 6, throttle: 0, selector });
    assert.equal(parked.gear, 0, `${selector} has no gear`);
    assert.equal(parked.drive, false, `${selector} delivers no torque`);
    assert.ok(Math.abs(parked.rpm - DEFAULT_GEARBOX.idleRpm) < 200, `${selector} off throttle idles: ${parked.rpm}`);

    // Road speed must not leak into the needle: the engine is off the wheels.
    const blip = shift({ speedKmh: 0, gear: 1, throttle: 1, selector });
    assert.ok(blip.rpm > DEFAULT_GEARBOX.idleRpm * 2, 'on throttle it free-revs');
    assert.ok(blip.rpm < DEFAULT_GEARBOX.redlineRpm, '...but the limiter holds it below redline');
  }
});

test('an unknown or missing selector falls back to D', () => {
  assert.equal(shift({ speedKmh: 40, gear: 2, selector: 'Q' }).selector, 'D');
  assert.equal(shift({ speedKmh: 40, gear: 2 }).selector, 'D');
  assert.equal(shift({ speedKmh: 40, gear: 2, selector: 'r' }).selector, 'R', 'case insensitive');
});

test('engine load tracks rpm and throttle within 0..1', () => {
  assert.equal(engineLoad({ rpm: DEFAULT_GEARBOX.idleRpm, throttle: 0 }), 0);
  const redline = engineLoad({ rpm: DEFAULT_GEARBOX.redlineRpm, throttle: 1 });
  assert.ok(redline > 0.9 && redline <= 1, `expected a high load, got ${redline}`);
  assert.ok(engineLoad({ rpm: 99999, throttle: 5 }) <= 1);
  assert.ok(engineLoad({ rpm: -100, throttle: -3 }) >= 0);
});

test('a rev in P or N is loud but unloaded (M2.6)', () => {
  // Off the driveline there is no torque reaction, so the exhaust note must not
  // claim full load — that is what makes a parked blip sound empty.
  const loaded = engineLoad({ rpm: 6000, throttle: 1, selector: 'D' });
  const neutral = engineLoad({ rpm: 6000, throttle: 1, selector: 'N' });
  const parked = engineLoad({ rpm: 6000, throttle: 1, selector: 'P' });
  assert.ok(neutral < 0.2 && parked < 0.2, `P/N load should be near zero, got ${parked} / ${neutral}`);
  assert.ok(loaded > neutral * 4, 'the same rev under drive reads as far more load');
});
