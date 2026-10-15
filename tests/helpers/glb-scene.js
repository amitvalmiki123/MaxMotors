/**
 * Test helper: rebuilds a three.js scene graph from a shipped GLB with
 * gltf-transform (node names, transforms, geometry, material factors), so
 * runtime code can be exercised against the real assets without a browser.
 * Textures are represented by a placeholder Texture, which is all the
 * classification code needs to know.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import * as THREE from 'three';

let io = null;

async function getIO() {
  if (io) return io;
  await MeshoptDecoder.ready;
  io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  return io;
}

export async function loadGlbScene(file) {
  const document = await (await getIO()).read(file);
  const materials = new Map();
  const toMaterial = (source) => {
    if (!source) return new THREE.MeshStandardMaterial();
    if (materials.has(source)) return materials.get(source);
    const [r, g, b, a] = source.getBaseColorFactor();
    const material = new THREE.MeshStandardMaterial({
      name: source.getName(),
      color: new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace),
      opacity: a,
      transparent: source.getAlphaMode() === 'BLEND',
      metalness: source.getMetallicFactor(),
      roughness: source.getRoughnessFactor(),
    });
    const [er, eg, eb] = source.getEmissiveFactor();
    material.emissive.setRGB(er, eg, eb, THREE.LinearSRGBColorSpace);
    const strength = source.getExtension('KHR_materials_emissive_strength');
    if (strength) material.emissiveIntensity = strength.getEmissiveStrength();
    if (source.getBaseColorTexture()) material.map = new THREE.Texture();
    if (source.getEmissiveTexture()) material.emissiveMap = new THREE.Texture();
    materials.set(source, material);
    return material;
  };
  const build = (node) => {
    const object = new THREE.Group();
    object.name = node.getName();
    object.position.fromArray(node.getTranslation());
    object.quaternion.fromArray(node.getRotation());
    object.scale.fromArray(node.getScale());
    const mesh = node.getMesh();
    if (mesh) {
      for (const primitive of mesh.listPrimitives()) {
        const geometry = new THREE.BufferGeometry();
        const position = primitive.getAttribute('POSITION');
        const array = new Float32Array(position.getCount() * 3);
        const element = [];
        for (let index = 0; index < position.getCount(); index += 1) array.set(position.getElement(index, element), index * 3);
        geometry.setAttribute('position', new THREE.BufferAttribute(array, 3));
        const indices = primitive.getIndices();
        if (indices) geometry.setIndex(Array.from(indices.getArray()));
        const child = new THREE.Mesh(geometry, toMaterial(primitive.getMaterial()));
        child.name = node.getName();
        object.add(child);
      }
    }
    for (const child of node.listChildren()) object.add(build(child));
    return object;
  };
  const scene = new THREE.Group();
  for (const node of document.getRoot().getDefaultScene().listChildren()) scene.add(build(node));
  scene.updateMatrixWorld(true);
  return scene;
}
