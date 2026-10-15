import { combineInputs, mapKeyboardInput } from './input.js';

const RELEVANT_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight',
  'Space', 'KeyR',
]);

export class InputController {
  constructor({ root = document, onReset = () => {}, onAnyInput = () => {} } = {}) {
    this.root = root;
    this.onReset = onReset;
    this.onAnyInput = onAnyInput;
    this.keys = new Set();
    this.touchPointers = new Map();
    this.touch = { steer: 0, throttle: 0, brake: 0, handbrake: false };

    this.handleKeyDown = (event) => {
      if (!RELEVANT_KEYS.has(event.code)) return;
      event.preventDefault();
      this.onAnyInput(event);
      if (event.code === 'KeyR' && !event.repeat) this.onReset();
      this.keys.add(event.code);
    };
    this.handleKeyUp = (event) => {
      if (!RELEVANT_KEYS.has(event.code)) return;
      event.preventDefault();
      this.keys.delete(event.code);
    };
    this.clearKeys = () => this.keys.clear();
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
  }

  updateTouchState() {
    const actions = [...this.touchPointers.values()];
    this.touch.steer = Number(actions.includes('right')) - Number(actions.includes('left'));
    this.touch.throttle = Number(actions.includes('throttle'));
    this.touch.brake = Number(actions.includes('brake'));
    this.touch.handbrake = actions.includes('handbrake');
    this.buttons.forEach((button) => {
      button.classList.toggle('is-active', actions.includes(button.dataset.control));
    });
  }

  read() {
    return combineInputs(mapKeyboardInput(this.keys), this.touch);
  }

  destroy() {
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
