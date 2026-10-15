import * as THREE from 'three';
import { sanitizeNodeName } from './cars/loader.js';
import { openableKind } from './cars/names.js';
import { planOpenable } from './cars/openables.js';

/**
 * Doors (O) and bonnet / boot (B) — only where the source GLB has them as
 * separate named nodes (checked in assets/reports/*.tree.txt: the Sikandar has
 * door_lf/rf/lr/rr + boot, the Aurora detach_door_L/R). Each panel is
 * re-parented onto a pivot at its hinge and swung by the plan the pipeline
 * baked into the manifest (`openables`); manifests that predate the field fall
 * back to the same rule at runtime. Panels close by themselves once the car
 * drives off. Purely visual: nothing here touches physics.
 *
 * Deferred — no separate node to hinge, so nothing is faked:
 *   - Sikandar SUV bonnet: the Scorpio-N export has no bonnet/hood node
 *     (assets/reports/sikandar-suv.tree.txt lists doors + boot only);
 *   - Aurora V12 bonnet / engine cover: `detach_trunk_50_85` exists in the
 *     source tree but does not survive as its own node in the shipped GLB.
 * Revisit when the models are re-exported with those panels split out.
 */

const AUTO_CLOSE_KMH = 12;
const SWING_RATE = 1.4;

function detectPlans(rig) {
  const plans = [];
  const box = new THREE.Box3();
  rig.group.updateMatrixWorld(true);
  const toLocal = rig.group.matrixWorld.clone().invert();
  rig.root.traverse((object) => {
    const kind = openableKind(object.name);
    if (!kind) return;
    let meshes = 0;
    object.traverse((child) => {
      if (child.isMesh) meshes += 1;
    });
    if (!meshes) return;
    box.setFromObject(object).applyMatrix4(toLocal);
    plans.push({ kind, node: object.name, ...planOpenable({ kind, name: object.name, min: box.min.toArray(), max: box.max.toArray() }) });
  });
  return plans;
}

export function attachOpenables(rig, manifest) {
  const plans = manifest?.openables?.length ? manifest.openables : detectPlans(rig);
  const parts = [];
  for (const plan of plans) {
    const node = rig.root.getObjectByName(sanitizeNodeName(plan.node));
    if (!node) continue;
    const pivot = new THREE.Group();
    pivot.name = `hinge:${plan.node}`;
    pivot.position.fromArray(plan.hinge);
    rig.group.add(pivot);
    rig.group.updateMatrixWorld(true);
    pivot.attach(node);
    parts.push({ kind: plan.kind, style: plan.style, pivot, axis: plan.axis, angle: plan.angle, open: 0, target: 0 });
  }
  const group = (name) => parts.filter((part) => (name === 'doors' ? part.kind === 'door' : part.kind !== 'door'));
  return {
    parts,
    get doors() {
      return group('doors').length;
    },
    get panels() {
      return group('bonnet').length;
    },
    /** 'doors' (O) or 'bonnet' (B, bonnet + boot). Returns the new state, or null if the car has none. */
    toggle(name, speedKmh = 0) {
      const list = group(name);
      if (!list.length) return null;
      const open = list.some((part) => part.target === 0) && speedKmh < AUTO_CLOSE_KMH;
      for (const part of list) part.target = open ? 1 : 0;
      return open;
    },
    update(deltaTime, speedKmh = 0) {
      for (const part of parts) {
        if (speedKmh > AUTO_CLOSE_KMH) part.target = 0;
        const step = Math.min(Math.abs(part.target - part.open), deltaTime * SWING_RATE);
        if (step <= 0) continue;
        part.open += Math.sign(part.target - part.open) * step;
        const eased = part.open * part.open * (3 - 2 * part.open);
        part.pivot.rotation[part.axis] = part.angle * eased;
      }
    },
  };
}
