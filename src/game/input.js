const KEY_BINDINGS = Object.freeze({
  forward: ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
});

function isPressed(keys, code) {
  if (keys instanceof Set) return keys.has(code);
  if (Array.isArray(keys)) return keys.includes(code);
  return Boolean(keys?.[code]);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function mapKeyboardInput(keys = {}) {
  const pressed = (binding) => KEY_BINDINGS[binding].some((code) => isPressed(keys, code));
  const left = pressed('left');
  const right = pressed('right');

  return {
    steer: Number(right) - Number(left),
    throttle: Number(pressed('forward')),
    brake: Number(pressed('backward')),
    handbrake: pressed('handbrake'),
  };
}

export function normalizeInput(input = {}) {
  return {
    steer: clamp(input.steer, -1, 1),
    throttle: clamp(input.throttle, 0, 1),
    brake: clamp(input.brake, 0, 1),
    handbrake: Boolean(input.handbrake),
  };
}

export function combineInputs(keyboard = {}, touch = {}) {
  return normalizeInput({
    steer: (Number(keyboard.steer) || 0) + (Number(touch.steer) || 0),
    throttle: Math.max(Number(keyboard.throttle) || 0, Number(touch.throttle) || 0),
    brake: Math.max(Number(keyboard.brake) || 0, Number(touch.brake) || 0),
    handbrake: keyboard.handbrake || touch.handbrake,
  });
}
