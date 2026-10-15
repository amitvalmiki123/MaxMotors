import * as THREE from 'three';
import { computeCockpit } from './cockpit.js';
import { sanitizeNodeName } from './loader.js';

/**
 * Cockpit rig: the driver-head anchor for the cockpit camera and a steering
 * wheel that turns with the front wheels.
 *
 * The anchor comes from the manifest (`cockpit`, baked by the asset pipeline).
 * A real steering wheel node (Sikandar: `steering_dummy`, found by name) or
 * steering wheel meshes found by material (`Volant…`) are re-parented onto a
 * pivot aligned with the measured column axis. A car without either gets a
 * procedural wheel — torus rim, three spokes, hub — built here from primitives
 * with its own material (CC0, part of this project).
 */

/** Rim turns per wheel-angle radian (front wheels ±0.48 rad → rim ±3.4 rad). */
export const STEERING_RATIO = 7;
const AXIS_Z = new THREE.Vector3(0, 0, 1);

export function createProceduralSteeringWheel(radius = 0.17) {
  const group = new THREE.Group();
  group.name = 'procedural-steering-wheel';
  const leather = new THREE.MeshStandardMaterial({ name: 'procedural-steering-leather', color: 0x1c1e21, roughness: 0.62, metalness: 0.05 });
  const metal = new THREE.MeshStandardMaterial({ name: 'procedural-steering-metal', color: 0x8b9097, roughness: 0.32, metalness: 0.85 });
  const rim = new THREE.Mesh(new THREE.TorusGeometry(radius, radius * 0.11, 10, 36), leather);
  group.add(rim);
  // Three spokes: left, right and bottom (the classic sports layout).
  for (const angle of [0, Math.PI, -Math.PI / 2]) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.92, radius * 0.14, radius * 0.08), metal);
    spoke.position.set(Math.cos(angle) * radius * 0.5, Math.sin(angle) * radius * 0.5, -radius * 0.04);
    spoke.rotation.z = angle;
    group.add(spoke);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.3, radius * 0.34, radius * 0.22, 20), leather);
  hub.rotation.x = Math.PI / 2;
  hub.position.z = -radius * 0.08;
  group.add(hub);
  for (const mesh of group.children) {
    mesh.castShadow = false;
    mesh.receiveShadow = true;
  }
  return group;
}

function rigBounds(rig) {
  const box = rig.bounds?.box ?? new THREE.Box3().setFromObject(rig.group);
  return { min: box.min.toArray(), max: box.max.toArray() };
}

/**
 * @param {object} rig       built car rig (group, root, bounds)
 * @param {object} manifest  car manifest (may predate `cockpit`)
 * @param {object} [options]
 * @param {'left'|'right'} [options.driverSide] used only for the estimate
 */
export function attachCockpit(rig, manifest, { driverSide = 'left' } = {}) {
  const cockpit = manifest?.cockpit ?? computeCockpit({ bounds: rigBounds(rig), driverSide });
  const head = new THREE.Vector3().fromArray(cockpit.head);
  const spec = cockpit.steeringWheel;
  if (!spec) return { head, source: cockpit.source, steering: null, update() {} };

  const pivot = new THREE.Group();
  pivot.name = 'steering-pivot';
  pivot.position.fromArray(spec.center);
  pivot.quaternion.setFromUnitVectors(AXIS_Z, new THREE.Vector3().fromArray(spec.axis).normalize());
  rig.group.add(pivot);
  rig.group.updateMatrixWorld(true);

  let source = 'procedural';
  const node = spec.node ? rig.root.getObjectByName(sanitizeNodeName(spec.node)) : null;
  const byMaterial = [];
  if (!node && spec.material) {
    rig.root.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some((material) => material?.name === spec.material)) byMaterial.push(object);
    });
  }
  if (node) {
    pivot.attach(node);
    source = 'node';
  } else if (byMaterial.length) {
    for (const mesh of byMaterial) pivot.attach(mesh);
    source = 'material';
  } else {
    pivot.add(createProceduralSteeringWheel(spec.radius ?? 0.17));
  }

  const base = pivot.quaternion.clone();
  const turn = new THREE.Quaternion();
  return {
    head,
    source,
    anchorSource: cockpit.source,
    steering: pivot,
    /** Positive steer angle (left) turns the rim counter-clockwise as the driver sees it. */
    update(steerAngle = 0) {
      turn.setFromAxisAngle(AXIS_Z, steerAngle * STEERING_RATIO);
      pivot.quaternion.copy(base).multiply(turn);
    },
  };
}
