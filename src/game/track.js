import * as THREE from 'three';

const TRACK_RADIUS_X = 46;
const TRACK_RADIUS_Z = 30;
const ROAD_HALF_WIDTH = 4.8;
const TRACK_SAMPLES = 256;

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

function createRibbonGeometry(curve, { width, offset = 0, segments = TRACK_SAMPLES, y = 0.025 }) {
  const positions = [];
  const indices = [];

  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    const point = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t).normalize();
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x);
    const left = point.clone().addScaledVector(normal, offset + width / 2);
    const right = point.clone().addScaledVector(normal, offset - width / 2);

    positions.push(left.x, y, left.z, right.x, y, right.z);
    if (index < segments) {
      const current = index * 2;
      const next = current + 2;
      indices.push(current, next, current + 1, current + 1, next, next + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
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
  scene.add(redMarkers, lightMarkers);
}

function addTrees(scene) {
  const count = 30;
  const trunkGeometry = new THREE.CylinderGeometry(0.18, 0.28, 2.3, 6);
  const foliageGeometry = new THREE.ConeGeometry(1.05, 2.65, 7);
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x544236, roughness: 1 });
  const foliageMaterial = new THREE.MeshStandardMaterial({ color: 0x3b5548, roughness: 1 });
  const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, count);
  const foliage = new THREE.InstancedMesh(foliageGeometry, foliageMaterial, count);
  const dummy = new THREE.Object3D();

  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2 + 0.08;
    const jitter = Math.sin(index * 2.17) * 3;
    const x = Math.cos(angle) * (66 + jitter);
    const z = Math.sin(angle) * (47 + jitter * 0.7);
    const scale = 0.78 + ((index * 7) % 5) * 0.09;

    dummy.position.set(x, 1.15 * scale, z);
    dummy.rotation.set(0, index * 0.73, 0);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    trunks.setMatrixAt(index, dummy.matrix);

    dummy.position.y = 3.0 * scale;
    dummy.updateMatrix();
    foliage.setMatrixAt(index, dummy.matrix);
  }

  trunks.castShadow = true;
  foliage.castShadow = true;
  scene.add(trunks, foliage);
}

export function createTrack(scene) {
  const curve = createTrackCurve();
  const roadMaterial = new THREE.MeshStandardMaterial({
    color: 0x272d2e,
    roughness: 0.92,
    metalness: 0.02,
  });
  const road = new THREE.Mesh(createRibbonGeometry(curve, { width: ROAD_HALF_WIDTH * 2, y: 0.012 }), roadMaterial);
  road.receiveShadow = true;
  scene.add(road);

  const edgeMaterial = new THREE.MeshStandardMaterial({ color: 0xd8d4c7, roughness: 0.85 });
  for (const side of [-1, 1]) {
    const edge = new THREE.Mesh(
      createRibbonGeometry(curve, { width: 0.11, offset: side * (ROAD_HALF_WIDTH - 0.16), y: 0.035 }),
      edgeMaterial,
    );
    edge.receiveShadow = true;
    scene.add(edge);
  }

  const curbMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
  addCurb(scene, curve, -1, curbMaterial);
  addCurb(scene, curve, 1, curbMaterial);

  const startLine = new THREE.Mesh(
    new THREE.BoxGeometry(0.72, 0.025, ROAD_HALF_WIDTH * 2 - 0.1),
    new THREE.MeshStandardMaterial({ map: createStartLineTexture(), roughness: 0.82 }),
  );
  startLine.position.set(0, 0.043, -TRACK_RADIUS_Z);
  startLine.receiveShadow = true;
  scene.add(startLine);

  addSafetyMarkers(scene, curve);
  addTrees(scene);
  return { curve, roadHalfWidth: ROAD_HALF_WIDTH };
}
