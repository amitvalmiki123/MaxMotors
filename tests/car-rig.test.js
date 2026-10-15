import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { collectSceneCandidates, resolveNodePath, sanitizeNodeName } from '../src/game/cars/loader.js';

/**
 * Mirrors the real export: Sketchfab wraps the model in nodes whose names repeat
 * (`Object_5` twice), and `GLTFLoader` sanitizes names (dots and slashes go away,
 * duplicates get a `_1` suffix). The pipeline therefore writes child-index paths.
 */
function buildExport() {
  // glTF scene -> `Sketchfab_model` root node -> exporter node -> ... exactly the
  // nesting the pipeline walks (paths always start at the scene's children).
  const scene = new THREE.Group();
  scene.name = 'Sketchfab_scene';

  const sketchfab = new THREE.Group();
  sketchfab.name = 'Sketchfab_model';
  scene.add(sketchfab);

  const fbx = new THREE.Group();
  fbx.name = 'scorpio_n.fbx'; // three loads this one as `scorpio_nfbx`
  sketchfab.add(fbx);

  const rootNode = new THREE.Group();
  rootNode.name = 'RootNode';
  fbx.add(rootNode);

  const model = new THREE.Group();
  model.name = 'Scorpio-N22';
  rootNode.add(model);

  const dummy = new THREE.Group();
  dummy.name = 'wheel_rf_dummy';
  model.add(dummy);

  const hub = new THREE.Group();
  hub.name = 'wheel_rf.003';
  dummy.add(hub);

  const tyre = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.76, 0.76), new THREE.MeshBasicMaterial());
  tyre.name = 'wheel_rf.003_wheel_rf.2_0';
  tyre.position.set(-0.79, 0.38, -1.56);
  hub.add(tyre);

  // Two same-named siblings: three keeps `Object_5` for the first and renames the
  // second to `Object_5_1`, so only the child index stays meaningful.
  const firstPanel = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.4, 0.4), new THREE.MeshBasicMaterial());
  firstPanel.name = 'Object_5';
  firstPanel.position.set(-1.0, 0.9, -0.4);
  model.add(firstPanel);

  // A mesh whose *geometry* name mentions a wheel but whose node does not: this
  // is the door-trim case that used to be rigged as a wheel.
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.69, 0.69), new THREE.MeshBasicMaterial());
  door.name = 'Object_5';
  door.geometry.name = 'int_door_lf_wheel_rf.2_0';
  door.position.set(-0.86, 1.02, -0.42);
  model.add(door);

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.91, 1.49, 4.57), new THREE.MeshBasicMaterial());
  body.name = 'chassis';
  model.add(body);

  return { scene, tyre, door, body, model, parentOfDoor: model };
}

test('index paths resolve through renamed and duplicated nodes', () => {
  const { scene, tyre, model, door } = buildExport();
  scene.updateMatrixWorld(true);

  const tyrePath = '/0:Sketchfab_model/0:scorpio_n.fbx/0:RootNode/0:Scorpio-N22/0:wheel_rf_dummy/0:wheel_rf.003/0:wheel_rf.003_wheel_rf.2_0';
  const doorPath = '/0:Sketchfab_model/0:scorpio_n.fbx/0:RootNode/0:Scorpio-N22/2:Object_5';
  assert.equal(resolveNodePath(scene, tyrePath), tyre, 'the index path should find the tyre mesh');
  assert.equal(resolveNodePath(scene, doorPath), door, 'the duplicated child resolves by index');

  // Now resolve the same paths from a tree whose names three already sanitized
  // (`scorpio_n.fbx` -> `scorpio_nfbx`, the duplicate -> `Object_5_1`).
  const fbx = scene.children[0].children[0];
  fbx.name = 'scorpio_nfbx';
  door.name = 'Object_5_1';
  assert.equal(resolveNodePath(scene, tyrePath), tyre, 'sanitized names still resolve');
  assert.equal(resolveNodePath(scene, doorPath), door);
});

test('legacy name-based segments still resolve, and bad paths return null', () => {
  const { scene, tyre, door } = buildExport();
  scene.updateMatrixWorld(true);

  assert.equal(
    resolveNodePath(scene, '/Sketchfab_model/scorpio_n.fbx/RootNode/Scorpio-N22/wheel_rf_dummy/wheel_rf.003/wheel_rf.003_wheel_rf.2_0'),
    tyre,
  );
  assert.equal(
    resolveNodePath(scene, '/Sketchfab_model/scorpio_n.fbx/RootNode/Scorpio-N22/2:Object_5'),
    door,
  );
  assert.equal(resolveNodePath(scene, '/0:Sketchfab_model/9:nope'), null);
  assert.equal(resolveNodePath(scene, ''), null);
});

test('sanitizeNodeName matches three: dots, slashes and spaces', () => {
  assert.equal(sanitizeNodeName('wheel_rf.003_wheel_rf.2_0'), 'wheel_rf003_wheel_rf2_0');
  assert.equal(sanitizeNodeName('Dirt road scene.fbx'), 'Dirt_road_scenefbx');
  assert.equal(sanitizeNodeName('Object_5'), 'Object_5');
});

test('scene candidates ignore geometry names and flag node-named wheels', () => {
  const { scene, tyre, door, body } = buildExport();
  const { candidates, objects } = collectSceneCandidates(scene);

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const tyreCandidate = byId.get(tyre.uuid);
  const doorCandidate = byId.get(door.uuid);
  const bodyCandidate = byId.get(body.uuid);
  void doorCandidate;

  assert.ok(tyreCandidate, 'the tyre mesh should be a candidate');
  assert.equal(tyreCandidate.wheelish, true, 'the node name marks the tyre as a wheel');
  assert.ok(Math.abs(tyreCandidate.radius - 0.38) < 0.01, `tyre radius ${tyreCandidate.radius}`);

  assert.equal(doorCandidate.wheelish, false, 'the door node is named Object_5, not a wheel');
  assert.equal(bodyCandidate.wheelish, false);
  assert.equal(objects.get(tyre.uuid), tyre, 'candidates map back to their Object3D');
});

test('candidate bounds are measured in rig space, not world space', () => {
  const { scene, tyre } = buildExport();
  // Simulate the manifest transform: the root is scaled and offset before the rig
  // is built, and the wheels must still be measured where the car will sit.
  scene.scale.setScalar(1.3);
  scene.position.set(-0.01, -0.06, -0.003);
  const { candidates } = collectSceneCandidates(scene);
  const tyreCandidate = candidates.find((candidate) => candidate.name === tyre.name);

  assert.ok(Math.abs(tyreCandidate.center[0] + 1.038) < 0.02, `x ${tyreCandidate.center[0]}`);
  assert.ok(Math.abs(tyreCandidate.center[1] - 0.434) < 0.02, `y ${tyreCandidate.center[1]}`);
  assert.ok(Math.abs(tyreCandidate.center[2] + 2.031) < 0.02, `z ${tyreCandidate.center[2]}`);
});
