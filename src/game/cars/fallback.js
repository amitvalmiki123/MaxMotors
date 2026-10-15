import * as THREE from 'three';

/**
 * Procedural box car.
 *
 * Used until (or instead of) a licensed GLB: as the instant visual at spawn so
 * the drive never waits on the network, and as the fallback when a model fails
 * to load. It is deliberately shaped like the M1 prototype and shares the same
 * rig interface as `buildCarRig`, so nothing downstream branches on it.
 */

function addBox(parent, size, position, material, { rotation = null, castShadow = true } = {}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function makeWheelPair(material, hubMaterial, radius, width) {
  const steerPivot = new THREE.Group();
  const spinPivot = new THREE.Group();
  steerPivot.add(spinPivot);
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 20, 1), material);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, width * 1.06, 14, 1), hubMaterial);
  for (const mesh of [tire, hub]) {
    mesh.rotation.z = Math.PI / 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    spinPivot.add(mesh);
  }
  return { steerPivot, spinPivot };
}

function makeDecalTexture(label, color = '#e8e4d8') {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  context.fillStyle = 'rgba(12,16,18,0.78)';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = 'rgba(240,238,226,0.5)';
  context.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
  context.fillStyle = color;
  context.font = 'bold 30px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(label, canvas.width / 2, canvas.height / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createFallbackCarVisual({ preset, paint, quality } = {}) {
  const group = new THREE.Group();
  group.name = 'car:fallback';

  const physics = preset?.physics ?? {};
  const halfExtents = physics.bodyHalfExtents ?? [0.91, 0.36, 1.72];
  const [halfWidth, halfHeight, halfLength] = halfExtents;
  const wheelRadius = physics.wheelRadius ?? 0.38;
  const isSuv = (preset?.id ?? '').includes('suv');

  const paintMaterial = new THREE.MeshPhysicalMaterial({
    name: 'fallback-paint',
    color: new THREE.Color(paint?.color ?? '#d9b063'),
    metalness: paint?.metalness ?? 0.5,
    roughness: paint?.roughness ?? 0.28,
    clearcoat: 1,
    clearcoatRoughness: 0.1,
    envMapIntensity: quality?.mobile ? 0.9 : 1.2,
  });
  paintMaterial.userData.isPaint = true;
  const carbonMaterial = new THREE.MeshStandardMaterial({ color: 0x20262a, metalness: 0.5, roughness: 0.4 });
  const glassMaterial = new THREE.MeshPhysicalMaterial({
    name: 'fallback-glass',
    color: 0x14262e,
    metalness: 0.2,
    roughness: 0.08,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
  });
  const rubberMaterial = new THREE.MeshStandardMaterial({ color: 0x111617, roughness: 0.92 });
  const rimMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa7a5, metalness: 0.85, roughness: 0.3 });
  const headlightMaterial = new THREE.MeshStandardMaterial({
    color: 0xf4f8f2,
    emissive: new THREE.Color(0xfff2d4),
    emissiveIntensity: 1.8,
    roughness: 0.2,
  });
  const taillightMaterial = new THREE.MeshStandardMaterial({
    color: 0xb23025,
    emissive: new THREE.Color(0xff3a24),
    emissiveIntensity: 1.5,
    roughness: 0.3,
  });

  const bodyHeight = isSuv ? halfHeight * 2.1 : halfHeight * 2;
  addBox(group, [halfWidth * 2, bodyHeight * 0.62, halfLength * 2], [0, halfHeight * 0.6, 0], paintMaterial);
  addBox(group, [halfWidth * 1.86, bodyHeight * (isSuv ? 0.62 : 0.42), halfLength * (isSuv ? 1.24 : 0.72)], [0, halfHeight * (isSuv ? 1.5 : 1.25), isSuv ? 0.28 : -0.2], carbonMaterial);
  addBox(group, [halfWidth * 1.7, bodyHeight * (isSuv ? 0.5 : 0.34), halfLength * (isSuv ? 1.1 : 0.6)], [0, halfHeight * (isSuv ? 1.62 : 1.32), isSuv ? 0.3 : -0.2], glassMaterial, { castShadow: false });
  addBox(group, [halfWidth * 1.05, bodyHeight * 0.16, 0.06], [0, halfHeight * 0.72, -halfLength - 0.02], headlightMaterial, { castShadow: false });
  addBox(group, [halfWidth * 1.05, bodyHeight * 0.16, 0.06], [0, halfHeight * 0.72, halfLength + 0.02], taillightMaterial, { castShadow: false });

  const label = (preset?.name ?? 'MAXMOTORS').split(' ')[0].toUpperCase().slice(0, 9);
  const decalMaterial = new THREE.MeshBasicMaterial({ map: makeDecalTexture(label, preset?.accent ?? '#e8e4d8'), transparent: true });
  for (const side of [-1, 1]) {
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), decalMaterial);
    decal.position.set(side * (halfWidth + 0.005), halfHeight * 0.8, halfLength * 0.45);
    decal.rotation.y = side * Math.PI / 2;
    group.add(decal);
  }

  const wheels = [];
  const corners = [
    ['front-left', -1, -1],
    ['front-right', 1, -1],
    ['rear-left', -1, 1],
    ['rear-right', 1, 1],
  ];
  for (const [corner, side, end] of corners) {
    const { steerPivot, spinPivot } = makeWheelPair(
      rubberMaterial,
      rimMaterial,
      wheelRadius,
      isSuv ? 0.32 : 0.28,
    );
    steerPivot.position.set(
      side * (physics.wheelHalfTrack ?? halfWidth * 0.99),
      wheelRadius * 0.98,
      end * (physics.wheelHalfBase ?? halfLength * 0.66),
    );
    group.add(steerPivot);
    wheels.push({ corner, index: wheels.length, front: end < 0, steerPivot, spinPivot, radius: wheelRadius, measured: wheelRadius * 2, source: 'procedural' });
  }

  void quality;

  return {
    group,
    root: group,
    wheels,
    complete: true,
    problems: [],
    fallback: true,
    paintMaterials: [paintMaterial],
    glassMaterials: [glassMaterial],
    headlightMaterials: [headlightMaterial],
    taillightMaterials: [taillightMaterial],
    wheelMaterials: [rubberMaterial, rimMaterial],
    brandMaterials: [],
    bounds: new THREE.Box3().setFromObject(group),
    stats: { meshes: group.children.length, triangles: 0 },
  };
}
