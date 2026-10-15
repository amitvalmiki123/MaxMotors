/**
 * Surface (terrain) presets.
 *
 * Each track publishes a `surface` describing how the car behaves on it. The
 * physics module consumes grip + suspension modifiers; the effects module uses
 * `dust`, `skid` and `dustColor` to decide what to throw off the tyres.
 *
 * Values are multipliers over the car preset, so switching car/track keeps the
 * M1 handling numbers as the reference for asphalt.
 */

export const SURFACES = Object.freeze({
  asphalt: Object.freeze({
    id: 'asphalt',
    label: 'Asphalt',
    grip: 1,
    frictionScale: 1,
    suspensionScale: 1,
    dust: 0.15,
    dustColor: '#b8b6ae',
    skid: 0.55,
    offTrackGrip: 0.82,
    offTrackSkid: 0.9,
    offTrackDust: 1,
    offTrackDustColor: '#8d8a72',
  }),
  dirt: Object.freeze({
    id: 'dirt',
    label: 'Dirt',
    // Loose surface: less grip, so the SUV steps out and slides.
    grip: 0.9,
    frictionScale: 0.88,
    // Slightly softer suspension travel reads as "bumpy trail" without
    // changing the simulation step or the fixed M1 tuning numbers.
    suspensionScale: 1.12,
    dampingScale: 0.9,
    dust: 1,
    dustColor: '#a8895f',
    skid: 0.85,
    offTrackGrip: 0.68,
    offTrackSkid: 1,
    offTrackDust: 1.4,
    offTrackDustColor: '#7d6a4a',
    /** Roll resistance on loose ground slows the car gently. */
    rollingResistance: 0.012,
  }),
});

export function getSurface(id) {
  return SURFACES[id] ?? SURFACES.asphalt;
}
