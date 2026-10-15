import { combineInputs, mapKeyboardInput } from './input.js';

const RELEVANT_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight',
  'Space', 'KeyR',
]);

/**
 * Discrete feature keys (pressed once, never part of the driving input that
 * mapKeyboardInput / physics read): C camera, L headlights, O doors,
 * B bonnet / boot. H (the horn) is held, and reported by read() as `horn`.
 */
export const ACTION_KEYS = Object.freeze({ KeyC: 'camera', KeyL: 'lights', KeyO: 'doors', KeyB: 'bonnet' });
const HORN_KEY = 'KeyH';

export class InputController {
  constructor({ root = document, onReset = () => {}, onAnyInput = () => {}, onAction = () => {} } = {}) {
    this.root = root;
    this.onReset = onReset;
    this.onAnyInput = onAnyInput;
    this.onAction = onAction;
    this.keys = new Set();
    this.hornKey = false;
    this.touchPointers = new Map();
    this.touch = { steer: 0, throttle: 0, brake: 0, handbrake: false, horn: false };

    this.handleKeyDown = (event) => {
      if (event.code === HORN_KEY) {
        if (event.target?.closest?.('input, textarea, select, [contenteditable]')) return;
        event.preventDefault();
        this.onAnyInput(event);
        this.hornKey = true;
        return;
      }
      const action = ACTION_KEYS[event.code];
      if (action) {
        if (event.target?.closest?.('input, textarea, select, [contenteditable]')) return;
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
    // Tap buttons for discrete actions (CAM).
    this.handleActionTap = (event) => {
      const action = event.currentTarget.dataset.action;
      if (!action) return;
      event.preventDefault();
      this.onAnyInput(event);
      this.onAction(action);
    };
    this.actionButtons = [...this.root.querySelectorAll('[data-action]')];
    this.actionButtons.forEach((button) => button.addEventListener('click', this.handleActionTap));
  }

  updateTouchState() {
    const actions = [...this.touchPointers.values()];
    this.touch.steer = Number(actions.includes('right')) - Number(actions.includes('left'));
    this.touch.throttle = Number(actions.includes('throttle'));
    this.touch.brake = Number(actions.includes('brake'));
    this.touch.handbrake = actions.includes('handbrake');
    this.touch.horn = actions.includes('horn');
    this.buttons.forEach((button) => {
      button.classList.toggle('is-active', actions.includes(button.dataset.control));
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
