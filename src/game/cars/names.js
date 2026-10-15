/**
 * Node/material name patterns shared by the runtime rig (loader.js) and the
 * asset pipeline (scripts/assets/*), so both sides classify a part the same way.
 */

/**
 * `rim` only counts as a whole word: the Sikandar's exterior paint slot is called
 * `primary` (GTA-style colour slot), and a bare /rim/ used to classify the whole
 * body as a wheel — the paint override then skipped it.
 */
export const WHEEL_NAME_PATTERN = /wheel|tyre|tire|(?:^|[^a-z])rims?(?:[^a-z]|$)|pneu|roue|jante/i;

export function isWheelName(name) {
  return WHEEL_NAME_PATTERN.test(String(name ?? ''));
}

/** Steering wheel nodes: `movsteer`, `steering_dummy`, `volant`, `lenkrad`. */
export const STEERING_NAME_PATTERN = /steer|volant|lenkrad/i;

/** Hinged body panels that may be opened when they are separate named nodes. */
export const OPENABLE_PATTERNS = [
  // GTA-style dummies (door_lf, door_rf, door_lr, door_rr, bonnet, boot).
  { kind: 'door', pattern: /^door_([lr])([fr])$/i },
  { kind: 'bonnet', pattern: /^(bonnet|hood)$/i },
  { kind: 'boot', pattern: /^(boot|trunk|tailgate)$/i },
  // Game-rip "detach" parts (Terzo Millennio: detach_door_L_60_63, detach_trunk_50_85).
  { kind: 'door', pattern: /^detach_door_([lr])_\d+_\d+$/i },
  { kind: 'boot', pattern: /^detach_trunk_\d+_\d+$/i },
  { kind: 'bonnet', pattern: /^detach_(hood|bonnet)_\d+_\d+$/i },
];

export function openableKind(name) {
  const value = String(name ?? '');
  for (const { kind, pattern } of OPENABLE_PATTERNS) {
    if (pattern.test(value)) return kind;
  }
  return null;
}
