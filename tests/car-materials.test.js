import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { classifyCarMaterials } from '../src/game/cars/loader.js';
import { isWheelName } from '../src/game/cars/names.js';
import { loadGlbScene } from './helpers/glb-scene.js';

function mesh(name, material, position = [0, 0.5, 0]) {
  const object = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.2), material);
  object.name = name;
  object.position.fromArray(position);
  return object;
}

test('`rim` only matches as a word: "primary" is paint, not a wheel', () => {
  assert.equal(isWheelName('chassis_primary_0'), false);
  assert.equal(isWheelName('wheel_rf.003'), true);
  assert.equal(isWheelName('front_rim_LOD2'), true);
  assert.equal(isWheelName('Jantes_I'), true);
});

test('three.js default emissive (black, intensity 1) does not make every material a lamp', () => {
  const root = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ name: 'primary', color: 0x224411 });
  const interior = new THREE.MeshStandardMaterial({ name: 'scorpio_n_int_body.1' });
  root.add(mesh('chassis_primary_0', body, [0, 0.8, 0]), mesh('door_lf_primary_0', body, [-0.9, 0.8, 0]));
  root.add(mesh('scorpio_n_int_body', interior), mesh('scorpio_n_int_body_2', interior));
  const result = classifyCarMaterials(root, { paint: { color: '#31543a' } });
  assert.deepEqual(result.paintMaterials.map((material) => material.name), ['primary-paint']);
  assert.equal(result.lights.head.length + result.lights.tail.length + result.lights.indicator.length, 0);
  assert.equal(root.children[0].material.name, 'primary-paint');
  assert.equal(root.children[2].material.name, 'scorpio_n_int_body.1', 'interior is never painted');
});

test('a lamp material shared by both ends is split into head and tail roles', () => {
  const root = new THREE.Group();
  const lamp = new THREE.MeshStandardMaterial({ name: 'lights', color: 0xffffff, emissive: 0xffffff });
  root.add(mesh('lamp_a', lamp, [-0.6, 0.7, -2.1]), mesh('lamp_b', lamp, [0.6, 0.7, -2.1]), mesh('lamp_c', lamp, [0.6, 0.8, 2.1]));
  const red = new THREE.MeshStandardMaterial({ name: 'Material.040', color: 0xff0000, emissive: 0xff0000 });
  root.add(mesh('Object_9', red, [0, 0.8, 2.2]));
  const { lights, lightAnchors } = classifyCarMaterials(root);
  assert.deepEqual(lights.head.map((material) => material.name), ['lights']);
  assert.deepEqual(lights.tail.map((material) => material.name).sort(), ['Material.040', 'lights-tail']);
  assert.equal(lightAnchors.head.length, 2, 'one headlight anchor per side');
  assert.ok(lightAnchors.head.every((point) => point[2] < -2));
});

test('real Sikandar SUV: the exterior `primary` slot takes the paint, lamps get roles', async () => {
  const root = await loadGlbScene('public/models/sikandar-suv.glb');
  const result = classifyCarMaterials(root, { paint: { color: '#31543a' } });
  assert.deepEqual(result.paintMaterials.map((material) => material.name), ['primary-paint']);
  assert.ok(result.lights.head.length > 0, 'has headlights');
  assert.ok(result.lights.tail.length > 0, 'has tail lights');
  assert.ok(result.glassMaterials.length > 0, 'has glass');
});

test('real Aurora V12: Carosserie takes the paint, Lumire_* lamps split by colour', async () => {
  const root = await loadGlbScene('public/models/aurora-v12.glb');
  const result = classifyCarMaterials(root, { paint: { color: '#d9b063' } });
  assert.deepEqual(result.paintMaterials.map((material) => material.name), ['Carosserie-paint']);
  const names = (list) => list.map((material) => material.name.replace(/-(head|tail|indicator)$/, ''));
  assert.ok(names(result.lights.head).includes('Lumire_blanche'));
  assert.ok(names(result.lights.tail).includes('Lumire_rouge'));
  assert.ok(names(result.lights.indicator).includes('Lumire_Orange'));
});
