/**
 * Input mapping: raw device state (keys held, touch buttons held) → the neutral
 * `{steer, throttle, brake, handbrake}` shape the physics step consumes.
 *
 * M2.6 adds the transmission selector (P/R/N/D). The selector is *discrete* —
 * a position you choose, not an axis you hold — so it is not part of this
 * driving input: `input-controller.js` reports it through its own callback and
 * `physics.js` latches it onto the persistent control state.
 *
 * Key conflicts: `R` is Reset and `D` is steer-right, both long documented, so
 * the gear positions live on the number row (1–4) with `P` and `N` as mnemonic
 * aliases — the two letters that were still free. The touch widget has explicit
 * P/R/N/D buttons, which is the primary affordance on a phone.
 */

/** Valid transmission selector positions, in gate order. */
export const SELECTORS = Object.freeze(['P', 'R', 'N', 'D']);

/** Keyboard → selector position. Digits are primary; P/N are free-letter aliases. */
export const GEAR_KEYS = Object.freeze({
  Digit1: 'P',
  Digit2: 'R',
  Digit3: 'N',
  Digit4: 'D',
  Numpad1: 'P',
  Numpad2: 'R',
  Numpad3: 'N',
  Numpad4: 'D',
  KeyP: 'P',
  KeyN: 'N',
});

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

/** Normalizes a selector value; returns null when it is not one of P/R/N/D. */
export function normalizeSelector(value) {
  const next = String(value ?? '').trim().toUpperCase();
  return SELECTORS.includes(next) ? next : null;
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
