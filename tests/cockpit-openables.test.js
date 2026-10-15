import assert from 'node:assert/strict';
import test from 'node:test';
import { computeCockpit, steeringColumnAxis } from '../src/game/cars/cockpit.js';
import { openableKind } from '../src/game/cars/names.js';
import { planOpenable } from '../src/game/cars/openables.js';

test('steering column axis is the rim normal, pointed back at the driver', () => {
  const rake = (20 * Math.PI) / 180;
  const points = [];
  for (let step = 0; step < 64; step += 1) {
    const angle = (step / 64) * Math.PI * 2;
    // A 0.18 m rim tilted 20° from vertical, centred at (0.4, 1.2, -0.4).
    const x = Math.cos(angle) * 0.18;
    const local = Math.sin(angle) * 0.18;
    points.push([0.4 + x, 1.2 + local * Math.cos(rake), -0.4 - local * Math.sin(rake)]);
  }
  const { center, axis } = steeringColumnAxis(points);
  assert.ok(Math.abs(center[0] - 0.4) < 1e-6 && Math.abs(center[1] - 1.2) < 1e-6);
  assert.ok(axis[2] > 0.9 && Math.abs(axis[1] - Math.sin(rake)) < 1e-3, `axis ${axis}`);
  const cockpit = computeCockpit({ bounds: { min: [-1, 0, -2.3], max: [1, 1.8, 2.3] }, steering: { center, axis } });
  assert.equal(cockpit.driverSide, 'right');
  assert.ok(cockpit.head[2] > center[2] + 0.3, 'head sits behind the wheel');
});

test('without a steering node the cockpit is estimated on the driver side', () => {
  const cockpit = computeCockpit({ bounds: { min: [-1.05, -0.04, -2.25], max: [1.05, 0.91, 2.25] }, driverSide: 'left' });
  assert.equal(cockpit.source, 'estimate');
  assert.ok(cockpit.head[0] < 0 && cockpit.head[1] < 0.91 && cockpit.steeringWheel.center[2] < cockpit.head[2]);
});

test('openables: only named panels, with hinges on the right edges', () => {
  assert.equal(openableKind('door_lf'), 'door');
  assert.equal(openableKind('door_lf_dummy'), null, 'the dummy wrapper is not the panel');
  assert.equal(openableKind('detach_door_L_60_63'), 'door');
  assert.equal(openableKind('detach_door_L_60_carpaint_LOD2_60'), null);
  assert.equal(openableKind('boot'), 'boot');
  assert.equal(openableKind('chassis_57'), null);
  const left = planOpenable({ kind: 'door', name: 'door_lf', min: [-1.08, 0.3, -0.9], max: [-0.66, 1.7, 0.26] });
  assert.deepEqual([left.axis, left.style, left.hinge[2]], ['y', 'swing', -0.9]);
  assert.ok(left.angle < 0, 'left door swings out to -X');
  const scissor = planOpenable({ kind: 'door', name: 'detach_door_L_60_63', min: [-0.9, 0.2, -0.5], max: [-0.4, 0.9, 0.6] });
  assert.deepEqual([scissor.axis, scissor.style], ['x', 'scissor']);
  assert.ok(scissor.angle < 0, 'scissor door lifts');
});
