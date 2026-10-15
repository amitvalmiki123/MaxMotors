import assert from 'node:assert/strict';
import test from 'node:test';
import { combineInputs, mapKeyboardInput, normalizeInput } from '../src/game/input.js';

test('WASD input maps to throttle, steering, brake, and handbrake', () => {
  assert.deepEqual(mapKeyboardInput(new Set(['KeyW', 'KeyA', 'Space'])), {
    steer: -1,
    throttle: 1,
    brake: 0,
    handbrake: true,
  });
});

test('arrow keys map to the same drive actions as WASD', () => {
  assert.deepEqual(mapKeyboardInput({ ArrowUp: true, ArrowRight: true, ArrowDown: true }), {
    steer: 1,
    throttle: 1,
    brake: 1,
    handbrake: false,
  });
});

test('opposing steering cancels and touch plus keyboard input is clamped', () => {
  assert.equal(mapKeyboardInput(['KeyA', 'ArrowLeft', 'KeyD']).steer, 0);
  assert.deepEqual(combineInputs(
    { steer: -1, throttle: 0.5 },
    { steer: -1, throttle: 1, brake: 0.25, handbrake: true },
  ), {
    steer: -1,
    throttle: 1,
    brake: 0.25,
    handbrake: true,
  });
});

test('input normalization rejects values outside the control range', () => {
  assert.deepEqual(normalizeInput({ steer: 3, throttle: -1, brake: 1.5, handbrake: 0 }), {
    steer: 1,
    throttle: 0,
    brake: 1,
    handbrake: false,
  });
});
