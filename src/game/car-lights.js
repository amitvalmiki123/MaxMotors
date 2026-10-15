import * as THREE from 'three';

/**
 * Head / tail lights.
 *
 *   L        toggles the headlights: lamp lenses go from a dim daytime glow to
 *            full emissive, and on the high (desktop) tier two real SpotLights
 *            at the measured headlight positions throw beams down the road.
 *   braking  tail lamps flare whenever the brake is applied.
 *
 * The spotlights stay in the scene and only change intensity, so toggling never
 * changes the light count (which would recompile every material).
 */

export const LAMP_LEVELS = Object.freeze({
  headOn: 3.2,
  headOff: 0.3,
  tailRunning: 1.25,
  tailOff: 0.45,
  brake: 3.6,
});
/** Candela-ish (physically based lights): a clear pool ~10–20 m ahead in daylight. */
export const SPOT_INTENSITY = 160;

function estimateHeadAnchors(rig) {
  const box = rig.bounds?.box ?? (rig.bounds?.isBox3 ? rig.bounds : new THREE.Box3().setFromObject(rig.group));
  const width = box.max.x - box.min.x;
  const y = box.min.y + (box.max.y - box.min.y) * 0.38;
  return [[-width * 0.33, y, box.min.z + 0.15], [width * 0.33, y, box.min.z + 0.15]];
}

export function createCarLights({ tier } = {}) {
  const realBeams = !tier?.mobile;
  let rig = null;
  let on = false;
  let braking = false;
  let spots = [];

  function clearSpots() {
    for (const { light, target } of spots) {
      light.removeFromParent();
      target.removeFromParent();
      light.dispose?.();
    }
    spots = [];
  }

  function apply() {
    if (!rig) return;
    for (const material of rig.headlightMaterials ?? []) {
      material.emissiveIntensity = (material.userData?.baseEmissiveIntensity ?? 1) * (on ? LAMP_LEVELS.headOn : LAMP_LEVELS.headOff);
    }
    const tailLevel = braking ? LAMP_LEVELS.brake : on ? LAMP_LEVELS.tailRunning : LAMP_LEVELS.tailOff;
    for (const material of rig.taillightMaterials ?? []) {
      material.emissiveIntensity = (material.userData?.baseEmissiveIntensity ?? 1) * tailLevel;
    }
    for (const { light } of spots) light.intensity = on ? SPOT_INTENSITY : 0;
  }

  return {
    get on() {
      return on;
    },
    get beams() {
      return spots.length;
    },
    /** Re-targets the lights onto a freshly mounted car rig. */
    attach(nextRig) {
      clearSpots();
      rig = nextRig;
      if (rig && realBeams) {
        const anchors = rig.lightAnchors?.head?.length ? rig.lightAnchors.head : estimateHeadAnchors(rig);
        for (const anchor of anchors) {
          const light = new THREE.SpotLight(0xfff0d6, 0, 55, THREE.MathUtils.degToRad(26), 0.6, 1.5);
          light.name = 'headlight-beam';
          light.position.fromArray(anchor);
          light.castShadow = false;
          const target = new THREE.Object3D();
          target.position.set(anchor[0] * 1.1, anchor[1] - 1.1, anchor[2] - 16);
          light.target = target;
          rig.group.add(light, target);
          spots.push({ light, target });
        }
      }
      apply();
    },
    toggle() {
      on = !on;
      apply();
      return on;
    },
    setOn(value) {
      on = Boolean(value);
      apply();
      return on;
    },
    update({ braking: nextBraking = false } = {}) {
      if (nextBraking === braking) return;
      braking = nextBraking;
      apply();
    },
    dispose() {
      clearSpots();
      rig = null;
    },
  };
}
