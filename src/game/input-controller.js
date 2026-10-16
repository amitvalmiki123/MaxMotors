import { GEAR_KEYS, combineInputs, mapKeyboardInput, normalizeSelector } from './input.js';

const RELEVANT_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight',
  'Space', 'KeyR',
]);

/**
 * Discrete feature keys (pressed once, never part of the driving input that
 * mapKeyboardInput / physics read): C camera, L headlights, O doors,
 * B bonnet / boot, T drift mode. H (the horn) is held, and reported by read()
 * as `horn`.
 */
export const ACTION_KEYS = Object.freeze({
  KeyC: 'camera',
  KeyL: 'lights',
  KeyO: 'doors',
  KeyB: 'bonnet',
  KeyT: 'drift',
});
const HORN_KEY = 'KeyH';
/** Keys that reach the transmission gate (digits 1–4, plus the free letters P/N). */
const GEAR_KEY_SET = new Set(Object.keys(GEAR_KEYS));

const isFormField = (target) => Boolean(target?.closest?.('input, textarea, select, [contenteditable]'));

export class InputController {
  constructor({
    root = document,
    onReset = () => {},
    onAnyInput = () => {},
    onAction = () => {},
    onGear = () => {},
  } = {}) {
    this.root = root;
    this.onReset = onReset;
    this.onAnyInput = onAnyInput;
    this.onAction = onAction;
    this.onGear = onGear;
    this.keys = new Set();
    this.hornKey = false;
    this.touchPointers = new Map();
    this.touch = { steer: 0, throttle: 0, brake: 0, handbrake: false, horn: false };

    this.handleKeyDown = (event) => {
      if (isFormField(event.target)) return;
      if (event.code === HORN_KEY) {
        event.preventDefault();
        this.onAnyInput(event);
        this.hornKey = true;
        return;
      }
      // Transmission gate: a press selects a position, it is never "held".
      if (GEAR_KEY_SET.has(event.code)) {
        event.preventDefault();
        if (event.repeat) return;
        this.onAnyInput(event);
        this.onGear(GEAR_KEYS[event.code], event.code);
        return;
      }
      const action = ACTION_KEYS[event.code];
      if (action) {
        event.preventDefault();
        this.onAnyInput(event);
        if (!event.repeat) this.onAction(action);
        return;
      }
      if (!RELEVANT_KEYS.has(event.code)) return;
      event.preventDefault();
      this.onAnyInput(event);
      if (event.code === 'KeyR' && !event.repeat) this.onReset();
      this.keys.add(event.code);
    };
    this.handleKeyUp = (event) => {
      if (event.code === HORN_KEY) {
        this.hornKey = false;
        return;
      }
      if (!RELEVANT_KEYS.has(event.code)) return;
      event.preventDefault();
      this.keys.delete(event.code);
    };
    this.clearKeys = () => {
      this.keys.clear();
      this.hornKey = false;
    };
    this.handlePointerDown = (event) => {
      const action = event.currentTarget.dataset.control;
      if (!action) return;
      event.preventDefault();
      this.onAnyInput(event);
      this.touchPointers.set(event.pointerId, action);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      this.updateTouchState();
    };
    this.handlePointerEnd = (event) => {
      if (!this.touchPointers.has(event.pointerId)) return;
      event.preventDefault();
      this.touchPointers.delete(event.pointerId);
      this.updateTouchState();
    };

    this.root.addEventListener('keydown', this.handleKeyDown);
    this.root.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.clearKeys);
    this.buttons = [...this.root.querySelectorAll('[data-control]')];
    this.buttons.forEach((button) => {
      button.addEventListener('pointerdown', this.handlePointerDown);
      button.addEventListener('pointerup', this.handlePointerEnd);
      button.addEventListener('pointercancel', this.handlePointerEnd);
      button.addEventListener('lostpointercapture', this.handlePointerEnd);
    });
    // Tap buttons for discrete actions (CAM, DRIFT) and the gear gate (P/R/N/D).
    this.handleActionTap = (event) => {
      const gear = event.currentTarget.dataset.gear;
      if (gear) {
        event.preventDefault();
        const selector = normalizeSelector(gear);
        if (!selector) return;
        this.onAnyInput(event);
        this.onGear(selector, 'touch');
        return;
      }
      const action = event.currentTarget.dataset.action;
      if (!action) return;
      event.preventDefault();
      this.onAnyInput(event);
      this.onAction(action);
    };
    this.actionButtons = [...this.root.querySelectorAll('[data-action],[data-gear]')];
    this.actionButtons.forEach((button) => button.addEventListener('click', this.handleActionTap));
  }

  updateTouchState() {
    const actions = [...this.touchPointers.values()];
    this.touch.steer = Number(actions.includes('right')) - Number(actions.includes('left'));
    this.touch.throttle = Number(actions.includes('throttle'));
    this.touch.brake = Number(actions.includes('brake'));
    // The handbrake is a held control on touch too (the DRIFT button): the
    // desktop had SPACE for it and phones had nothing, so drifting was
    // keyboard-only until now.
    this.touch.handbrake = actions.includes('handbrake');
    this.touch.horn = actions.includes('horn');
    this.buttons.forEach((button) => {
      button.classList.toggle('is-active', actions.includes(button.dataset.control));
    });
  }

  /** Reflects the latched transmission position on the on-screen gate. */
  setGear(selector) {
    const active = normalizeSelector(selector);
    this.root.querySelectorAll?.('[data-gear]').forEach((button) => {
      const selected = button.dataset.gear === active;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-checked', String(selected));
    });
  }

  /** Reflects the drift-mode toggle (T key / DRIFT button) on the UI. */
  setDriftMode(enabled) {
    this.root.querySelectorAll?.('[data-action="drift"]').forEach((button) => {
      button.classList.toggle('is-active', Boolean(enabled));
      button.setAttribute('aria-pressed', String(Boolean(enabled)));
    });
  }

  read() {
    // `horn` rides along with the driving input but is not part of it: the
    // physics step normalizes input down to steer / throttle / brake / handbrake.
    return { ...combineInputs(mapKeyboardInput(this.keys), this.touch), horn: this.hornKey || this.touch.horn };
  }

  destroy() {
    this.actionButtons?.forEach((button) => button.removeEventListener('click', this.handleActionTap));
    this.root.removeEventListener('keydown', this.handleKeyDown);
    this.root.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.clearKeys);
    this.buttons.forEach((button) => {
      button.removeEventListener('pointerdown', this.handlePointerDown);
      button.removeEventListener('pointerup', this.handlePointerEnd);
      button.removeEventListener('pointercancel', this.handlePointerEnd);
      button.removeEventListener('lostpointercapture', this.handlePointerEnd);
    });
    this.touchPointers.clear();
    this.keys.clear();
  }
}
