import './styles.css';
import { createGame } from './game/game.js';
import { InputController } from './game/input-controller.js';

const speedValue = document.querySelector('#speed-value');
const speedFill = document.querySelector('#speed-meter-fill');
const driveState = document.querySelector('#drive-state');
const creditsDialog = document.querySelector('#credits-dialog');
let game;
let inputController;

function updateTelemetry(telemetry, input) {
  const speed = Math.round(telemetry.speedKmh);
  speedValue.textContent = String(speed).padStart(3, '0');
  speedFill.style.width = `${Math.min(speed / 165, 1) * 100}%`;

  if (input.handbrake && speed > 2) {
    driveState.textContent = 'HANDBRAKE';
  } else if (input.brake > input.throttle && Math.abs(telemetry.signedSpeedKmh) > 1.4) {
    driveState.textContent = 'BRAKING';
  } else if (input.brake > input.throttle) {
    driveState.textContent = 'REVERSE';
  } else if (input.throttle > 0) {
    driveState.textContent = 'DRIVING';
  } else if (speed > 2) {
    driveState.textContent = 'COASTING';
  } else {
    driveState.textContent = 'READY';
  }
}

try {
  game = createGame({
    container: document.querySelector('#scene-container'),
    getInput: () => inputController?.read() ?? {},
    onTelemetry: updateTelemetry,
  });
  inputController = new InputController({ root: document, onReset: () => game?.reset() });
} catch (error) {
  console.error('MaxMotors could not initialize the 3D driving scene.', error);
  const message = document.createElement('div');
  message.className = 'webgl-error';
  message.textContent = 'The 3D drive could not start. Check that WebGL is enabled in this browser, then reload the page.';
  document.querySelector('#app').append(message);
}

document.querySelector('#reset-button').addEventListener('click', () => game?.reset());
document.querySelector('#credits-button').addEventListener('click', () => creditsDialog.showModal());
document.querySelector('#credits-close').addEventListener('click', () => creditsDialog.close());
creditsDialog.addEventListener('click', (event) => {
  if (event.target === creditsDialog) creditsDialog.close();
});

window.addEventListener('beforeunload', () => {
  inputController?.destroy();
  game?.destroy();
}, { once: true });
