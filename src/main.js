import './styles.css';
import { CAR_PRESETS, getCar } from './game/cars/catalog.js';
import { createGame } from './game/game.js';
import { InputController } from './game/input-controller.js';

const speedValue = document.querySelector('#speed-value');
const speedFill = document.querySelector('#speed-meter-fill');
const driveState = document.querySelector('#drive-state');
const gearValue = document.querySelector('#gear-value');
const rpmValue = document.querySelector('#rpm-value');
const surfaceLabel = document.querySelector('#surface-label');
const tractionWarning = document.querySelector('#traction-warning');
const sessionStatus = document.querySelector('#session-status-text');
const carName = document.querySelector('#car-name');
const carMeta = document.querySelector('#car-meta');
const trackIdLabel = document.querySelector('#track-id-label');
const trackSubtitle = document.querySelector('#track-subtitle');
const trackOptions = document.querySelector('#track-options');
const carOptions = document.querySelector('#car-options');
const paintOptions = document.querySelector('#paint-options');
const audioButton = document.querySelector('#audio-button');
const audioLabel = document.querySelector('#audio-label');
const loadToast = document.querySelector('#load-toast');
const creditsDialog = document.querySelector('#credits-dialog');

const TRACKS = [
  {
    id: 'test-circuit-01',
    label: 'Test Circuit 01',
    subtitle: 'Closed-loop asphalt handling course',
    surface: 'ASPHALT',
  },
  {
    id: 'forest-dirt-trail',
    label: 'Forest Dirt Trail',
    subtitle: 'Dirt road through forest · loose surface',
    surface: 'DIRT',
  },
];

let game;
let inputController;
let selectedCarId = 'aurora-v12';
let selectedTrackId = 'test-circuit-01';
let toastTimer = 0;

function showToast(message, { timeout = 4200 } = {}) {
  if (!message) {
    loadToast.classList.remove('is-visible');
    return;
  }
  loadToast.textContent = message;
  loadToast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  if (timeout) {
    toastTimer = window.setTimeout(() => loadToast.classList.remove('is-visible'), timeout);
  }
}

function setActive(container, predicate) {
  for (const button of container.querySelectorAll('button[data-id]')) {
    const active = predicate(button.dataset.id);
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-checked', String(active));
  }
}

function renderTracks() {
  trackOptions.replaceChildren(...TRACKS.map((track) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.dataset.id = track.id;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(track.id === selectedTrackId));
    button.innerHTML = `<strong>${track.label}</strong><small>${track.surface}</small>`;
    button.addEventListener('click', async () => {
      if (track.id === selectedTrackId) return;
      selectedTrackId = track.id;
      setActive(trackOptions, (id) => id === selectedTrackId);
      applyTrackCopy();
      sessionStatus.textContent = 'LOADING TRACK';
      const ok = await game?.selectTrack(track.id);
      sessionStatus.textContent = ok ? 'READY' : 'TRACK ERROR';
      if (!ok) showToast('That track could not be loaded. Check the console for details.');
    });
    return button;
  }));
}

function applyTrackCopy() {
  const track = TRACKS.find((entry) => entry.id === selectedTrackId) ?? TRACKS[0];
  trackIdLabel.textContent = track.id === 'test-circuit-01' ? 'TEST CIRCUIT 01' : 'FOREST DIRT TRAIL';
  trackSubtitle.textContent = track.subtitle;
  surfaceLabel.textContent = track.surface;
  document.querySelector('#track-title').innerHTML = track.id === 'test-circuit-01'
    ? 'Proving<br /><em>Grounds</em>'
    : 'Forest<br /><em>Trail</em>';
}

function renderCars() {
  carOptions.replaceChildren(...Object.values(CAR_PRESETS).map((car) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.dataset.id = car.id;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(car.id === selectedCarId));
    button.innerHTML = `<strong>${car.name}</strong><small>${car.className}</small>`;
    button.addEventListener('click', () => {
      if (car.id === selectedCarId) return;
      selectedCarId = car.id;
      setActive(carOptions, (id) => id === selectedCarId);
      game?.selectCar(car.id);
      applyCarCopy(car);
      renderPaints(car);
      showToast(`${car.name} ready — box preview until the model loads.`);
      sessionStatus.textContent = 'CAR SWAP';
      window.setTimeout(() => {
        if (sessionStatus.textContent === 'CAR SWAP') sessionStatus.textContent = 'READY';
      }, 1200);
    });
    return button;
  }));
}

function applyCarCopy(car) {
  carName.textContent = car.name.toUpperCase();
  carMeta.innerHTML = `<span>${car.className}</span><span>${car.physics.mass} kg</span><span>${car.physics.topSpeedKmh} km/h</span><span>${car.fuel}</span>`;
}

function renderPaints(car) {
  paintOptions.replaceChildren(...car.paint.map((paint, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'paint-chip';
    button.dataset.id = paint.id;
    button.setAttribute('role', 'radio');
    button.title = paint.label;
    button.setAttribute('aria-label', paint.label);
    const selected = index === 0;
    button.setAttribute('aria-checked', String(selected));
    button.style.setProperty('--paint', paint.color);
    button.classList.toggle('is-active', selected);
    button.addEventListener('click', () => {
      game?.selectPaint(paint.id);
      setActive(paintOptions, (id) => id === paint.id);
    });
    return button;
  }));
}

function updateTelemetry(telemetry, input) {
  const speed = Math.round(telemetry.speedKmh);
  speedValue.textContent = String(speed).padStart(3, '0');
  const topSpeed = getCar(selectedCarId).physics.topSpeedKmh;
  speedFill.style.width = `${Math.min(speed / topSpeed, 1) * 100}%`;

  gearValue.textContent = telemetry.gear > 0 ? `GEAR ${telemetry.gear}` : 'REVERSE';
  rpmValue.textContent = `${Math.round(telemetry.rpm)} RPM`;
  surfaceLabel.textContent = (telemetry.surface ?? 'asphalt').toUpperCase();
  tractionWarning.hidden = telemetry.onTrack !== false;

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

function handleStatus(status) {
  if (status.loading?.car) {
    const { loaded, total } = status.loading;
    if (loaded && total) {
      showToast(`Loading ${status.loading.car} model… ${Math.round((loaded / total) * 100)}%`);
    } else {
      showToast(`Loading ${status.loading.car} model…`);
    }
    return;
  }
  if (status.car && status.model === 'loaded') {
    showToast(`${getCar(status.car).name} model loaded · ${status.wheels} wheel rigs · ${status.triangles.toLocaleString()} triangles`, { timeout: 3200 });
    sessionStatus.textContent = 'READY';
    return;
  }
  if (status.car && status.model === 'fallback') {
    showToast(`Using the box-car preview for ${getCar(status.car).name} (${status.reason}).`, { timeout: 6000 });
    sessionStatus.textContent = 'PREVIEW';
    return;
  }
  if (status.car && status.warning) {
    showToast(`${getCar(status.car).name}: ${status.warning}`, { timeout: 7000 });
    return;
  }
  if (status.track && status.state === 'loading') {
    sessionStatus.textContent = 'LOADING TRACK';
    showToast(status.track === 'forest-dirt-trail' ? 'Loading forest trail (15 MB scene)…' : 'Loading test circuit…');
    return;
  }
  if (status.track && status.state === 'ready') {
    sessionStatus.textContent = 'READY';
    showToast('');
    return;
  }
  if (status.track && status.state === 'error') {
    sessionStatus.textContent = 'TRACK ERROR';
    showToast(`Track failed to load: ${status.reason}`, { timeout: 8000 });
    return;
  }
  if (status.environment) {
    console.info('Environment:', status.environment);
  }
}

function unlockAudio() {
  game?.unlockAudio().then((unlocked) => {
    audioButton.setAttribute('aria-pressed', String(Boolean(unlocked)));
    audioLabel.textContent = unlocked ? 'SOUND ON' : 'NO AUDIO';
    if (!unlocked) {
      game.toggleMute();
      audioLabel.textContent = 'MUTED';
    }
  });
}

try {
  game = createGame({
    container: document.querySelector('#scene-container'),
    getInput: () => inputController?.read() ?? {},
    onTelemetry: updateTelemetry,
    onStatus: handleStatus,
    initialCarId: selectedCarId,
    initialTrackId: selectedTrackId,
  });
  inputController = new InputController({
    root: document,
    onReset: () => game?.reset(),
    onAnyInput: () => {
      if (!game.muted && !audioLabel.textContent.includes('ON')) unlockAudio();
    },
  });

  renderTracks();
  renderCars();
  applyCarCopy(getCar(selectedCarId));
  applyTrackCopy();
  renderPaints(getCar(selectedCarId));
  sessionStatus.textContent = 'LOADING';

  document.querySelector('#app').dataset.quality = game.quality.id;
  game.init().then(() => {
    sessionStatus.textContent = 'READY';
    showToast('Box-car preview is drivable now — the licensed model swaps in when it loads.', { timeout: 5000 });
  });
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

audioButton.addEventListener('click', () => {
  const muted = game?.toggleMute();
  audioButton.setAttribute('aria-pressed', String(!muted));
  audioLabel.textContent = muted ? 'MUTED' : 'SOUND ON';
});

window.addEventListener('pointerdown', () => unlockAudio(), { once: true });
window.addEventListener('keydown', () => unlockAudio(), { once: true });

window.addEventListener('beforeunload', () => {
  inputController?.destroy();
  game?.destroy();
}, { once: true });
