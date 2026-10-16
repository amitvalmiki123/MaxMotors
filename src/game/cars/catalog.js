/**
 * Car catalog: in-game cars, their physics presets, paint options, and audio
 * profiles. Fictional names only — see docs/ASSET_LICENSES.md for the real
 * source models and attribution.
 *
 * The Aurora V12 preset keeps the M1 handling numbers (mass, forces, brakes,
 * top speed, engine bite) so the original feel and its physics tests are
 * unchanged; only the wheel geometry is fitted to the shipped model, because the
 * rigged wheels have to sit where the physics RaycastVehicle thinks they are.
 */

export const CAR_PRESETS = Object.freeze({
  'aurora-v12': Object.freeze({
    id: 'aurora-v12',
    name: 'Aurora V12',
    className: 'Concept hypercar',
    blurb: 'V10-style mid-engine concept. Sharp, low, and glued to the asphalt.',
    modelUrl: '/models/aurora-v12.glb',
    manifestUrl: '/models/aurora-v12.manifest.json',
    audioProfile: 'aurora-v12',
    fuel: 'petrol',
    accent: '#e56f49',
    physics: Object.freeze({
      // Keep in sync with VEHICLE_CONFIG defaults (M1 handling).
      mass: 1180,
      // Measured from the shipped Aurora V12 GLB (0.59 m tyre diameter).
      wheelRadius: 0.295,
      maxForwardForce: 2050,
      maxReverseForce: 1150,
      serviceBrakeForce: 8500,
      handbrakeForce: 11500,
      topSpeedKmh: 165,
      frictionSlip: 5.2,
      engineBite: 0.12,
      // 8500 N on 1180 kg is 0.73 g; the M2.6 brake model scales that to a
      // realistic ~1.1 g for a car with these brakes (see BRAKE_RESPONSE).
      brakeGain: 1.5,
      brakeBias: 0.6,
      bodyHalfExtents: [0.91, 0.36, 1.72],
      wheelHalfTrack: 0.85,
      wheelHalfBase: 1.36,
      wheelAnchorY: -0.17,
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
    /**
     * Cockpit-camera corrections over the pipeline's baked `cockpit` block.
     *
     * The Terzo Millennio is a canopy car with almost no interior geometry: the
     * estimate put the driver's eyes in their lap and gave them a bus-sized
     * wheel, and looking up showed sky through the roof. M2.6 raises the head,
     * fits a smaller, lower rim, and — in the cockpit camera only — closes the
     * cabin with a dark headliner shell (see cars/cockpit-rig.js).
     */
    cockpit: Object.freeze({
      /** Raised eye point, in rig metres: [x, y, z]. */
      headOffset: [0, 0.085, 0.015],
      /** Hypercar rim: smaller and tucked lower under the dash. */
      wheelRadius: 0.142,
      wheelOffset: [0, -0.045, 0.035],
      /** Build the dark cabin/headliner shell used by the cockpit camera. */
      darkInterior: true,
      interiorColor: '#14161a',
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
      // Measured from the shipped Sikandar SUV GLB (0.76 m tyre diameter).
      wheelRadius: 0.38,
      maxForwardForce: 4400,
      maxReverseForce: 2100,
      serviceBrakeForce: 11000,
      handbrakeForce: 13500,
      topSpeedKmh: 148,
      // Lighter tail: the SUV steps out of line on loose surfaces.
      frictionSlip: 4.6,
      engineBite: 0.2,
      // 11000 N on 2200 kg is only 0.51 g — the heavier car would need twice
      // the pedal travel for the same stop, so it gets a larger gain (~0.97 g)
      // and a slightly more rear-biased split (a tall, lightly loaded nose).
      brakeGain: 1.9,
      brakeBias: 0.58,
      bodyHalfExtents: [0.98, 0.5, 1.86],
      wheelHalfTrack: 0.79,
      wheelHalfBase: 1.375,
      wheelAnchorY: -0.2,
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
    /**
     * The SUV has a real, modelled cabin (`steering_dummy` is found by name), so
     * its baked cockpit anchor is already correct — the rim only gets a touch
     * more rake and the standard 0.18 m wheel a real SUV diameter.
     */
    cockpit: Object.freeze({
      headOffset: [0, 0.02, 0],
      wheelRadius: 0.19,
      wheelOffset: [0, 0, 0],
      darkInterior: false,
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

/** Per-car cockpit corrections; `{}` when the preset has none. */
export function getCockpitOverride(id) {
  return getCar(id).cockpit ?? {};
}

export function getPaint(id, paintId) {
  const car = getCar(id);
  return car.paint.find((option) => option.id === paintId) ?? car.paint[0];
}
