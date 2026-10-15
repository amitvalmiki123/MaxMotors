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

test('a standing car idles and reverse reports a reverse gear', () => {
  const idle = shift({ speedKmh: 0, gear: 1, throttle: 0 });
  assert.equal(idle.gear, 1);
  assert.ok(idle.rpm >= DEFAULT_GEARBOX.idleRpm * 0.7);

  const reverse = shift({ speedKmh: -12, gear: 1, throttle: 0 });
  assert.equal(reverse.gear, -1);
  assert.ok(reverse.rpm > 0);
});

test('engine load tracks rpm and throttle within 0..1', () => {
  assert.equal(engineLoad({ rpm: DEFAULT_GEARBOX.idleRpm, throttle: 0 }), 0);
  const redline = engineLoad({ rpm: DEFAULT_GEARBOX.redlineRpm, throttle: 1 });
  assert.ok(redline > 0.9 && redline <= 1, `expected a high load, got ${redline}`);
  assert.ok(engineLoad({ rpm: 99999, throttle: 5 }) <= 1);
  assert.ok(engineLoad({ rpm: -100, throttle: -3 }) >= 0);
});
