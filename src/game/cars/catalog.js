/**
 * Car catalog: in-game cars, their physics presets, paint options, and audio
 * profiles. Fictional names only — see docs/ASSET_LICENSES.md for the real
 * source models and attribution.
 *
 * The Aurora V12 preset is intentionally identical to the M1 VEHICLE_CONFIG so
 * the original handling feel and its physics tests are unchanged.
 */

export const CAR_PRESETS = Object.freeze({
  'aurora-v12': Object.freeze({
    id: 'aurora-v12',
    name: 'Aurora V12',
    className: 'Concept hypercar',
    blurb: 'V10-style mid-engine concept. Sharp, low, and glued to the asphalt.',
    modelUrl: '/models/aurora-v12.glb',
    manifestUrl: '/models/aurora-v12.manifest.json',
    audioProfile: 'aurora-v10',
    fuel: 'petrol',
    accent: '#e56f49',
    physics: Object.freeze({
      // Keep in sync with VEHICLE_CONFIG defaults (M1 handling).
      mass: 1180,
      wheelRadius: 0.38,
      maxForwardForce: 2050,
      maxReverseForce: 1150,
      serviceBrakeForce: 8500,
      handbrakeForce: 11500,
      topSpeedKmh: 165,
      frictionSlip: 5.2,
      engineBite: 0.12,
      bodyHalfExtents: [0.91, 0.36, 1.72],
      wheelHalfTrack: 0.9,
      wheelHalfBase: 1.14,
      wheelAnchorY: -0.18,
      suspension: Object.freeze({
        suspensionStiffness: 34,
        suspensionRestLength: 0.32,
        dampingRelaxation: 2.4,
        dampingCompression: 4.6,
        maxSuspensionTravel: 0.28,
        rollInfluence: 0.035,
      }),
      steering: Object.freeze({ maxSteer: 0.48, steerFalloff: 0.23, limitSpeedKmh: 180 }),
    }),
    paint: Object.freeze([
      { id: 'aurora-gold', label: 'Ashen Gold', color: '#d9b063', metalness: 0.62, roughness: 0.26 },
      { id: 'voltaic-blue', label: 'Voltaic Blue', color: '#2050c8', metalness: 0.55, roughness: 0.22 },
      { id: 'carbon-black', label: 'Carbon Black', color: '#26292e', metalness: 0.48, roughness: 0.3 },
    ]),
  }),

  'sikandar-suv': Object.freeze({
    id: 'sikandar-suv',
    name: 'Sikandar SUV',
    className: 'Body-on-frame SUV',
    blurb: 'Turbo-diesel torque and tall suspension. Slides happily on loose dirt.',
    modelUrl: '/models/sikandar-suv.glb',
    manifestUrl: '/models/sikandar-suv.manifest.json',
    audioProfile: 'sikandar-diesel',
    fuel: 'diesel',
    accent: '#7fa86a',
    physics: Object.freeze({
      mass: 2200,
      wheelRadius: 0.42,
      maxForwardForce: 4400,
      maxReverseForce: 2100,
      serviceBrakeForce: 11000,
      handbrakeForce: 13500,
      topSpeedKmh: 148,
      // Lighter tail: the SUV steps out of line on loose surfaces.
      frictionSlip: 4.6,
      engineBite: 0.2,
      bodyHalfExtents: [0.98, 0.5, 1.86],
      wheelHalfTrack: 0.99,
      wheelHalfBase: 1.24,
      wheelAnchorY: -0.22,
      suspension: Object.freeze({
        suspensionStiffness: 40,
        suspensionRestLength: 0.38,
        dampingRelaxation: 2.1,
        dampingCompression: 4.0,
        maxSuspensionTravel: 0.34,
        rollInfluence: 0.055,
      }),
      steering: Object.freeze({ maxSteer: 0.46, steerFalloff: 0.2, limitSpeedKmh: 150 }),
    }),
    paint: Object.freeze([
      { id: 'forest-green', label: 'Forest Green', color: '#31543a', metalness: 0.42, roughness: 0.36 },
      { id: 'desert-sand', label: 'Desert Sand', color: '#b6a077', metalness: 0.35, roughness: 0.42 },
      { id: 'midnight-steel', label: 'Midnight Steel', color: '#38414a', metalness: 0.5, roughness: 0.33 },
    ]),
  }),
});

export const CAR_IDS = Object.freeze(Object.keys(CAR_PRESETS));

export function getCar(id) {
  return CAR_PRESETS[id] ?? CAR_PRESETS['aurora-v12'];
}

export function paintOptions(id) {
  return getCar(id).paint;
}

export function getPaint(id, paintId) {
  const car = getCar(id);
  return car.paint.find((option) => option.id === paintId) ?? car.paint[0];
}
