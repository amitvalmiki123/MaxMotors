import * as THREE from 'three';

function addBox(parent, size, position, material, { rotation = null, castShadow = true } = {}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function addWindow(parent, size, position, rotation, material) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(...size), material);
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.castShadow = false;
  parent.add(mesh);
  return mesh;
}

function makeWheel() {
  const root = new THREE.Group();
  const rubber = new THREE.MeshStandardMaterial({ color: 0x111719, roughness: 0.9, metalness: 0.02 });
  const rim = new THREE.MeshStandardMaterial({ color: 0x9aa7a5, roughness: 0.32, metalness: 0.82 });
  const hub = new THREE.MeshStandardMaterial({ color: 0x303a3b, roughness: 0.44, metalness: 0.7 });
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.29, 22, 1), rubber);
  const rimFace = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.305, 16, 1), rim);
  const hubFace = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.32, 12, 1), hub);

  for (const mesh of [tire, rimFace, hubFace]) {
    mesh.rotation.z = Math.PI / 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  return root;
}

export function createCarVisual(scene) {
  const body = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({
    color: 0xd36b46,
    metalness: 0.5,
    roughness: 0.28,
  });
  const darkPaint = new THREE.MeshStandardMaterial({
    color: 0x202a2c,
    metalness: 0.48,
    roughness: 0.35,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x16343d,
    metalness: 0.35,
    roughness: 0.15,
    clearcoat: 0.9,
    clearcoatRoughness: 0.12,
    side: THREE.DoubleSide,
  });
  const headlightMaterial = new THREE.MeshStandardMaterial({
    color: 0xe9f4ef,
    emissive: 0xc8e5dd,
    emissiveIntensity: 1.5,
    roughness: 0.24,
  });
  const tailLightMaterial = new THREE.MeshStandardMaterial({
    color: 0xb53128,
    emissive: 0x931b13,
    emissiveIntensity: 1.35,
    roughness: 0.3,
  });

  addBox(body, [1.82, 0.48, 3.42], [0, 0.02, 0], paint);
  addBox(body, [1.76, 0.2, 1.22], [0, 0.3, -1.02], paint);
  addBox(body, [1.72, 0.21, 0.72], [0, 0.28, 1.18], paint);
  addBox(body, [1.94, 0.17, 0.26], [0, -0.12, -1.77], darkPaint);
  addBox(body, [1.92, 0.18, 0.25], [0, -0.12, 1.77], darkPaint);
  addBox(body, [1.42, 0.63, 1.78], [0, 0.51, 0.08], darkPaint);
  addBox(body, [1.3, 0.085, 0.86], [0, 0.87, 0.08], paint);
  addBox(body, [1.86, 0.08, 1.34], [0, -0.25, 0.05], darkPaint, { castShadow: false });
  addBox(body, [1.36, 0.08, 1.06], [0, 0.42, -1.04], darkPaint, { castShadow: false });

  addWindow(body, [1.18, 0.43], [0, 0.67, -0.77], [0.48, Math.PI, 0], glass);
  addWindow(body, [1.16, 0.38], [0, 0.68, 0.94], [-0.42, 0, 0], glass);
  for (const side of [-1, 1]) {
    addWindow(body, [0.72, 0.32], [side * 0.716, 0.67, -0.29], [0, side * Math.PI / 2, 0], glass);
    addWindow(body, [0.62, 0.32], [side * 0.716, 0.67, 0.48], [0, side * Math.PI / 2, 0], glass);
    addBox(body, [0.1, 0.14, 0.3], [side * 0.92, 0.22, -0.18], darkPaint, { castShadow: false });
  }

  for (const side of [-1, 1]) {
    addBox(body, [0.42, 0.09, 0.08], [side * 0.56, 0.12, -1.75], headlightMaterial, { castShadow: false });
    addBox(body, [0.38, 0.1, 0.075], [side * 0.59, 0.12, 1.76], tailLightMaterial, { castShadow: false });
  }

  scene.add(body);
  const wheels = [makeWheel(), makeWheel(), makeWheel(), makeWheel()];
  wheels.forEach((wheel) => scene.add(wheel));

  return { body, wheels };
}

export function syncCarVisual(carVisual, physics) {
  const { body, wheels } = carVisual;
  body.position.set(
    physics.chassisBody.position.x,
    physics.chassisBody.position.y,
    physics.chassisBody.position.z,
  );
  body.quaternion.set(
    physics.chassisBody.quaternion.x,
    physics.chassisBody.quaternion.y,
    physics.chassisBody.quaternion.z,
    physics.chassisBody.quaternion.w,
  );

  physics.vehicle.wheelInfos.forEach((wheelInfo, index) => {
    physics.vehicle.updateWheelTransform(index);
    const transform = wheelInfo.worldTransform;
    wheels[index].position.set(transform.position.x, transform.position.y, transform.position.z);
    wheels[index].quaternion.set(
      transform.quaternion.x,
      transform.quaternion.y,
      transform.quaternion.z,
      transform.quaternion.w,
    );
  });
}
