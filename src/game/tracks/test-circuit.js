import * as THREE from 'three';
import { SURFACES } from '../surfaces.js';

/**
 * Test Circuit 01 — the M1 asphalt oval, upgraded for M2:
 *   - Poly Haven CC0 asphalt PBR (2K albedo / normal / ARM) on the road,
 *   - the M1 cone trees are gone; the scenery is now instanced boulders and
 *     bushes (two draw calls),
 *   - kerbs, start line and safety markers keep the M1 layout exactly, so the
 *     handling numbers and spawn are unchanged.
 *
 * The road geometry is rebuilt from the M1 curve definition; nothing about size,
 * width or position changes.
 */

const TRACK_RADIUS_X = 46;
const TRACK_RADIUS_Z = 30;
const ROAD_HALF_WIDTH = 4.8;
const TRACK_SAMPLES = 256;

export const TEST_CIRCUIT_SPAWN = Object.freeze({ position: { x: 0, y: 1.02, z: -30 }, yaw: -Math.PI / 2 });

function createTrackCurve() {
  const points = Array.from({ length: 128 }, (_, index) => {
    const angle = (index / 128) * Math.PI * 2;
    return new THREE.Vector3(
      Math.cos(angle) * TRACK_RADIUS_X,
      0,
      Math.sin(angle) * TRACK_RADIUS_Z,
    );
  });
  return new THREE.CatmullRomCurve3(points, true, 'centripetal', 0.5);
}

/** Road ribbon with UVs so the asphalt textures can tile along the length. */
function createRibbonGeometry(curve, { width, offset = 0, segments = TRACK_SAMPLES, y = 0.025, tileMetres = 6 } = {}) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const length = curve.getLength();
  let travelled = 0;
  let previous = null;

  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    const point = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t).normalize();
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x);
    const left = point.clone().addScaledVector(normal, offset + width / 2);
    const right = point.clone().addScaledVector(normal, offset - width / 2);
    if (previous) travelled += point.distanceTo(previous);
    previous = point;

    positions.push(left.x, y, left.z, right.x, y, right.z);
    const v = (travelled / tileMetres);
    uvs.push(0, v, width / tileMetres, v);
    if (index < segments) {
      const current = index * 2;
      const next = current + 2;
      indices.push(current, next, current + 1, current + 1, next, next + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  void length;
  return geometry;
}

function addCurb(scene, curve, side, material) {
  const positions = [];
  const colors = [];
  const indices = [];
  const segments = 256;
  const curbWidth = 0.46;
  const curbOffset = side * (ROAD_HALF_WIDTH - 0.28);
  const red = new THREE.Color(0xe45a42);
  const cream = new THREE.Color(0xece9dd);

  for (let index = 0; index < segments; index += 1) {
    const t0 = index / segments;
    const t1 = (index + 1) / segments;
    const point0 = curve.getPointAt(t0);
    const point1 = curve.getPointAt(t1);
    const tangent0 = curve.getTangentAt(t0).normalize();
    const tangent1 = curve.getTangentAt(t1).normalize();
    const normal0 = new THREE.Vector3(-tangent0.z, 0, tangent0.x);
    const normal1 = new THREE.Vector3(-tangent1.z, 0, tangent1.x);
    const inner0 = point0.clone().addScaledVector(normal0, curbOffset + side * curbWidth / 2);
    const outer0 = point0.clone().addScaledVector(normal0, curbOffset - side * curbWidth / 2);
    const inner1 = point1.clone().addScaledVector(normal1, curbOffset + side * curbWidth / 2);
    const outer1 = point1.clone().addScaledVector(normal1, curbOffset - side * curbWidth / 2);
    const start = index * 4;
    const color = Math.floor(index / 4) % 2 === 0 ? red : cream;

    positions.push(
      inner0.x, 0.045, inner0.z,
      outer0.x, 0.045, outer0.z,
      inner1.x, 0.045, inner1.z,
      outer1.x, 0.045, outer1.z,
    );
    for (let vertex = 0; vertex < 4; vertex += 1) colors.push(color.r, color.g, color.b);
    indices.push(start, start + 2, start + 1, start + 1, start + 2, start + 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'circuit-curb';
  scene.add(mesh);
}

function createStartLineTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  const tile = 64;
  for (let y = 0; y < canvas.height / tile; y += 1) {
    for (let x = 0; x < canvas.width / tile; x += 1) {
      context.fillStyle = (x + y) % 2 === 0 ? '#f0eee7' : '#202528';
      context.fillRect(x * tile, y * tile, tile, tile);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function addSafetyMarkers(scene, curve) {
  const geometry = new THREE.BoxGeometry(0.28, 0.62, 0.3);
  const redMaterial = new THREE.MeshStandardMaterial({ color: 0xd9583e, roughness: 0.68 });
  const lightMaterial = new THREE.MeshStandardMaterial({ color: 0xe4ded0, roughness: 0.7 });
  const markerCount = 64;
  const redCount = Math.ceil(markerCount / 2);
  const redMarkers = new THREE.InstancedMesh(geometry, redMaterial, redCount);
  const lightMarkers = new THREE.InstancedMesh(geometry, lightMaterial, markerCount - redCount);
  const dummy = new THREE.Object3D();
  let redIndex = 0;
  let lightIndex = 0;

  for (let index = 0; index < markerCount; index += 1) {
    const t = index / markerCount;
    const point = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t);
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    const side = index % 2 === 0 ? 1 : -1;
    const position = point.addScaledVector(normal, side * (ROAD_HALF_WIDTH + 1.55));
    dummy.position.set(position.x, 0.34, position.z);
    dummy.rotation.set(0, Math.atan2(tangent.x, tangent.z), 0);
    dummy.updateMatrix();
    if (index % 2 === 0) redMarkers.setMatrixAt(redIndex++, dummy.matrix);
    else lightMarkers.setMatrixAt(lightIndex++, dummy.matrix);
  }

  redMarkers.castShadow = true;
  lightMarkers.castShadow = true;
  redMarkers.receiveShadow = true;
  lightMarkers.receiveShadow = true;
  redMarkers.name = 'circuit-markers-red';
  lightMarkers.name = 'circuit-markers-light';
  scene.add(redMarkers, lightMarkers);
}

/**
 * Instanced scenery. The M1 cone trees are deliberately gone (they read as
 * placeholder geometry); boulders and bushes dress the infield with two draw
 * calls and no alpha-tested foliage cost on mobile.
 */
function addScenery(scene, { count = 90, maxInstances = 2400 } = {}) {
  const total = Math.min(count, maxInstances);
  const rockGeometry = new THREE.IcosahedronGeometry(1, 0);
  const bushGeometry = new THREE.IcosahedronGeometry(1, 1);
  const rockMaterial = new THREE.MeshStandardMaterial({ color: 0x7b7c72, roughness: 0.95, flatShading: true });
  const bushMaterial = new THREE.MeshStandardMaterial({ color: 0x3f5a3c, roughness: 1, flatShading: true });
  const rocks = new THREE.InstancedMesh(rockGeometry, rockMaterial, total);
  const bushes = new THREE.InstancedMesh(bushGeometry, bushMaterial, total);
  const dummy = new THREE.Object3D();

  for (let index = 0; index < total; index += 1) {
    const angle = (index / total) * Math.PI * 2 + 0.11;
    const jitter = Math.sin(index * 2.17) * 4.5;
    const radiusX = 62 + jitter;
    const radiusZ = 44 + jitter * 0.7;
    const scale = 0.9 + ((index * 7) % 6) * 0.22;

    dummy.position.set(Math.cos(angle) * radiusX, 0.35 * scale, Math.sin(angle) * radiusZ);
    dummy.rotation.set(index * 0.31, index * 0.73, index * 0.17);
    dummy.scale.set(scale * 1.35, scale * 0.75, scale * 1.2);
    dummy.updateMatrix();
    rocks.setMatrixAt(index, dummy.matrix);

    dummy.position.set(
      Math.cos(angle + 0.28) * (radiusX + 9),
      0.5 * scale,
      Math.sin(angle + 0.28) * (radiusZ + 7),
    );
    dummy.rotation.set(0, index * 1.11, 0);
    dummy.scale.set(scale * 1.6, scale * 1.25, scale * 1.6);
    dummy.updateMatrix();
    bushes.setMatrixAt(index, dummy.matrix);
  }

  rocks.castShadow = true;
  rocks.receiveShadow = true;
  bushes.castShadow = true;
  bushes.receiveShadow = true;
  rocks.name = 'circuit-rocks';
  bushes.name = 'circuit-bushes';
  scene.add(rocks, bushes);
}

/**
 * Builds the circuit. `group` holds every mesh so the track manager can hide the
 * whole thing when another track is selected.
 */
export function createTestCircuitTrack({ scene, quality, roadTextures = null }) {
  const group = new THREE.Group();
  group.name = 'track:test-circuit-01';
  scene.add(group);

  const curve = createTrackCurve();
  const roadMaterial = new THREE.MeshStandardMaterial({
    color: roadTextures ? 0xffffff : 0x272d2e,
    roughness: 0.92,
    metalness: 0.02,
  });

  let textureSet = null;
  if (roadTextures) {
    const loader = new THREE.TextureLoader();
    const anisotropy = quality?.anisotropy ?? 4;
    const load = (file, colorSpace) => {
      const texture = loader.load(file);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = anisotropy;
      if (colorSpace) texture.colorSpace = colorSpace;
      return texture;
    };
    textureSet = {
      map: load(roadTextures.diffuse, THREE.SRGBColorSpace),
      normalMap: roadTextures.normal ? load(roadTextures.normal) : null,
      armMap: roadTextures.arm ? load(roadTextures.arm) : null,
    };
    roadMaterial.map = textureSet.map;
    roadMaterial.normalMap = textureSet.normalMap;
    if (textureSet.normalMap) roadMaterial.normalScale = new THREE.Vector2(0.85, 0.85);
    roadMaterial.roughness = 0.85;
  }

  const road = new THREE.Mesh(createRibbonGeometry(curve, { width: ROAD_HALF_WIDTH * 2, y: 0.012 }), roadMaterial);
  road.receiveShadow = true;
  road.name = 'circuit-road';
  group.add(road);

  const edgeMaterial = new THREE.MeshStandardMaterial({ color: 0xd8d4c7, roughness: 0.85 });
  for (const side of [-1, 1]) {
    const edge = new THREE.Mesh(
      createRibbonGeometry(curve, { width: 0.11, offset: side * (ROAD_HALF_WIDTH - 0.16), y: 0.035 }),
      edgeMaterial,
    );
    edge.receiveShadow = true;
    edge.name = 'circuit-edge-line';
    group.add(edge);
  }

  const curbMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
  addCurb(group, curve, -1, curbMaterial);
  addCurb(group, curve, 1, curbMaterial);

  const startLine = new THREE.Mesh(
    new THREE.BoxGeometry(0.72, 0.025, ROAD_HALF_WIDTH * 2 - 0.1),
    new THREE.MeshStandardMaterial({ map: createStartLineTexture(), roughness: 0.82 }),
  );
  startLine.position.set(0, 0.043, -TRACK_RADIUS_Z);
  startLine.receiveShadow = true;
  startLine.name = 'circuit-start-line';
  group.add(startLine);

  addSafetyMarkers(group, curve);
  addScenery(group, { maxInstances: quality?.maxInstances });

  // Bounds: inside the ribbon is on-track, the grass verge just outside is
  // "off track" for grip/dust purposes.
  const bounds = {
    halfWidth: ROAD_HALF_WIDTH,
    sampleCount: TRACK_SAMPLES,
    curve,
    isOnTrack(x, z) {
      return distanceToCurve(curve, x, z).distance <= ROAD_HALF_WIDTH + 0.35;
    },
    distance(x, z) {
      return distanceToCurve(curve, x, z).distance;
    },
  };

  return {
    id: 'test-circuit-01',
    name: 'Test Circuit 01',
    subtitle: 'Asphalt handling course',
    surface: SURFACES.asphalt,
    group,
    curve,
    roadHalfWidth: ROAD_HALF_WIDTH,
    bounds,
    spawn: TEST_CIRCUIT_SPAWN,
    physics: { groundHeight: 0, groundOffset: -0.04 },
    groundHeightAt() {
      return 0;
    },
    setVisible(visible) {
      group.visible = visible;
    },
    update() {},
    dispose() {
      group.traverse((object) => {
        if (!object.isMesh && !object.isInstancedMesh) return;
        object.geometry?.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          for (const key of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'emissiveMap']) {
            material?.[key]?.dispose?.();
          }
          material?.dispose?.();
        }
      });
      group.removeFromParent();
    },
  };
}

const distanceCache = { t: 0 };
function distanceToCurve(curve, x, z) {
  // Coarse-to-fine over the closed curve: cheap enough for per-frame bounds.
  let best = { distance: Infinity, t: 0 };
  for (let index = 0; index < 48; index += 1) {
    const t = index / 48;
    const point = curve.getPointAt(t);
    const distance = (point.x - x) ** 2 + (point.z - z) ** 2;
    if (distance < best.distance) best = { distance, t };
  }
  for (let step = 1; step <= 3; step += 1) {
    const span = 1 / 48 / Math.pow(2, step - 1);
    for (let offset = -2; offset <= 2; offset += 1) {
      const t = (best.t + (offset * span) / 4 + 1) % 1;
      const point = curve.getPointAt(t);
      const distance = (point.x - x) ** 2 + (point.z - z) ** 2;
      if (distance < best.distance) best = { distance, t };
    }
  }
  void distanceCache;
  return { distance: Math.sqrt(best.distance), t: best.t };
}
