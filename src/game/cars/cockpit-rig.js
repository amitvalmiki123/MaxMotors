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
 *
 * M2.6 adds a per-car correction layer (`preset.cockpit`, see cars/catalog.js).
 * The pipeline measures geometry; it cannot know that the Terzo Millennio's
 * canopy puts the baked eye point in the driver's lap, that a hypercar rim is
 * 14 cm and not 17, or that the same car has no roof at all behind the driver's
 * head — so those are declared per car and applied here:
 *
 *   headOffset    raises/moves the camera eye point, in rig metres
 *   wheelRadius   rescales the steering wheel (real node or procedural)
 *   wheelOffset   moves the wheel, e.g. tucking it lower under the dash
 *   darkInterior  builds a dark cabin shell shown *only* in the cockpit camera
 */

/** Rim turns per wheel-angle radian (front wheels ±0.48 rad → rim ±3.4 rad). */
export const STEERING_RATIO = 7;
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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
  return { min: box.min.toArray(), max: box.max.toArray(), box };
}

/**
 * Radius of whatever is parented under the steering pivot, measured in the
 * pivot's own frame (the wheel disc is the pivot's XY plane, its normal the
 * steering column axis). The pivot is temporarily un-rotated so the box is not
 * measured across a diagonal.
 */
function measureWheelRadius(pivot) {
  const quaternion = pivot.quaternion.clone();
  const position = pivot.position.clone();
  pivot.quaternion.identity();
  pivot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(pivot);
  const size = box.getSize(new THREE.Vector3());
  pivot.quaternion.copy(quaternion);
  pivot.position.copy(position);
  pivot.updateMatrixWorld(true);
  if (!Number.isFinite(size.x) || size.x <= 0) return 0;
  return Math.max(size.x, size.y) / 2;
}

/**
 * The dark cabin shell: a closed box around the driver, rendered from the
 * inside (`BackSide`) in a near-black material. It exists because canopy cars
 * ship with almost no interior — looking up or behind from the cockpit camera
 * showed the sky through the roof, which reads as a hole in the car.
 *
 * It is hidden except in the cockpit camera (`setInteriorVisible`), so it never
 * changes how the car looks from outside.
 */
export function createCockpitInterior({ head, bounds, color = '#14161a', name = 'cockpit-interior' }) {
  const box = bounds.box ?? new THREE.Box3().setFromObject(bounds.object ?? new THREE.Object3D());
  const width = Math.max(0.7, (box.max.x - box.min.x) * 0.62);
  const roofY = box.max.y + 0.01;
  const floorY = Math.max(box.min.y, head[1] - 0.52);
  const height = Math.max(0.3, roofY - floorY);
  // From just behind the wheel to past the rear of the cabin: the driver never
  // sees the nose from here, and the shell must not clip the windshield frame.
  const frontZ = head[2] - Math.max(0.55, (box.max.z - box.min.z) * 0.2);
  const rearZ = Math.min(box.max.z, head[2] + Math.max(0.5, (box.max.z - box.min.z) * 0.3));
  const length = Math.max(0.6, rearZ - frontZ);

  const material = new THREE.MeshStandardMaterial({
    name: `${name}-material`,
    color: new THREE.Color(color),
    roughness: 0.94,
    metalness: 0.02,
    side: THREE.BackSide,
  });
  const shell = new THREE.Mesh(new THREE.BoxGeometry(width, height, length), material);
  shell.name = name;
  shell.position.set(head[0], floorY + height / 2, frontZ + length / 2);
  shell.castShadow = false;
  shell.receiveShadow = false;
  // A dark, non-reflective cabin: the environment map would otherwise turn the
  // headliner into a bright panel exactly where the roof should be.
  shell.material.envMapIntensity = 0.18;
  shell.visible = false;
  shell.renderOrder = 2;
  return shell;
}

/**
 * @param {object} rig       built car rig (group, root, bounds, preset)
 * @param {object} manifest  car manifest (may predate `cockpit`)
 * @param {object} [options]
 * @param {'left'|'right'} [options.driverSide] used only for the estimate
 */
export function attachCockpit(rig, manifest, { driverSide = 'left', cockpit: cockpitOverrides = null } = {}) {
  // The corrections come from the car preset (see cars/catalog.js). `rig.preset`
  // is carried by both buildCarRig() and the box-car fallback, so a rig always
  // knows which car it is; an explicit override is accepted for tests/fixtures.
  const overrides = rig.preset?.cockpit ?? cockpitOverrides ?? {};
  const bounds = rigBounds(rig);
  const cockpit = manifest?.cockpit ?? computeCockpit({ bounds, driverSide });

  const head = new THREE.Vector3().fromArray(cockpit.head);
  // Per-car eye-point correction (item 8: the Lambo's head sits too low).
  if (Array.isArray(overrides.headOffset)) {
    head.x += overrides.headOffset[0] ?? 0;
    head.y += overrides.headOffset[1] ?? 0;
    head.z += overrides.headOffset[2] ?? 0;
  }
  // Never let the correction push the eyes through the roof.
  head.y = Math.min(head.y, bounds.max[1] - 0.045);

  let interior = null;
  if (overrides.darkInterior) {
    interior = createCockpitInterior({
      head: head.toArray(),
      bounds: { box: bounds.box },
      color: overrides.interiorColor,
    });
    rig.group.add(interior);
  }

  const spec = cockpit.steeringWheel;
  if (!spec) {
    return { head, source: cockpit.source, steering: null, interior, update() {}, setInteriorVisible() {} };
  }

  const pivot = new THREE.Group();
  pivot.name = 'steering-pivot';
  pivot.position.fromArray(spec.center);
  // Per-car wheel placement (item 8: smaller and lower in the Lambo).
  if (Array.isArray(overrides.wheelOffset)) {
    pivot.position.x += overrides.wheelOffset[0] ?? 0;
    pivot.position.y += overrides.wheelOffset[1] ?? 0;
    pivot.position.z += overrides.wheelOffset[2] ?? 0;
  }
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
  const targetRadius = Number.isFinite(overrides.wheelRadius) && overrides.wheelRadius > 0
    ? overrides.wheelRadius
    : (spec.radius ?? 0.17);

  if (node) {
    pivot.attach(node);
    source = 'node';
  } else if (byMaterial.length) {
    for (const mesh of byMaterial) pivot.attach(mesh);
    source = 'material';
  } else {
    pivot.add(createProceduralSteeringWheel(targetRadius));
    source = 'procedural';
  }

  // Rescale a real (or material-matched) wheel to the declared rim radius. The
  // procedural one is already built at `targetRadius`, so it is left alone.
  let wheelScale = 1;
  if (source !== 'procedural') {
    const measured = measureWheelRadius(pivot);
    if (measured > 0.02) {
      wheelScale = clamp(targetRadius / measured, 0.55, 1.7);
      if (Math.abs(wheelScale - 1) > 0.01) pivot.scale.setScalar(wheelScale);
    }
  }

  const base = pivot.quaternion.clone();
  const turn = new THREE.Quaternion();
  return {
    head,
    source,
    anchorSource: cockpit.source,
    steering: pivot,
    interior,
    wheelRadius: targetRadius,
    wheelScale: Number(wheelScale.toFixed(3)),
    /** Positive steer angle (left) turns the rim counter-clockwise as the driver sees it. */
    update(steerAngle = 0) {
      turn.setFromAxisAngle(AXIS_Z, steerAngle * STEERING_RATIO);
      pivot.quaternion.copy(base).multiply(turn);
    },
    /** The dark cabin shell exists for the cockpit camera and nowhere else. */
    setInteriorVisible(visible) {
      if (interior) interior.visible = Boolean(visible);
    },
    dispose() {
      if (!interior) return;
      interior.geometry?.dispose();
      interior.material?.dispose();
      interior.removeFromParent();
      interior = null;
    },
  };
}
