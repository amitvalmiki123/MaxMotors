#!/usr/bin/env node
/**
 * Development fixtures for the asset pipeline.
 *
 * The owner's source GLBs are not reachable from every environment, so this
 * builds three synthetic stand-ins with the same shape as the real models
 * (nested wheel nodes, decorative density, a named dirt-road strip, embedded
 * textures) and lets the whole pipeline run offline:
 *
 *   node scripts/assets/dev-fixtures.mjs
 *   MAXMOTORS_RAW_DIR=assets/fixtures node scripts/assets/inspect-glb.mjs --out /tmp/inspect
 *   MAXMOTORS_RAW_DIR=assets/fixtures node scripts/assets/optimize-glb.mjs --out-dir /tmp/out
 *
 * Nothing here ships; the fixtures land in the ignored `assets/fixtures/`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';

const OUT_DIR = process.env.MAXMOTORS_FIXTURE_DIR || 'assets/fixtures';

async function makeTexture({ width = 512, height = 512, hue = 0, label = 'texture' } = {}) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const value = 90 + Math.round(120 * Math.sin((x + hue) / 37) * Math.cos((y + hue) / 41));
      pixels[offset] = Math.max(0, Math.min(255, value + hue));
      pixels[offset + 1] = Math.max(0, Math.min(255, value));
      pixels[offset + 2] = Math.max(0, Math.min(255, 255 - value));
    }
  }
  const svg = Buffer.from(`<svg width="${width}" height="${height}"><rect x="8" y="8" width="${width - 16}" height="60" fill="rgba(0,0,0,0.45)"/><text x="20" y="50" font-family="monospace" font-size="34" fill="#ffd9a0">${label}</text></svg>`);
  return sharp(pixels, { raw: { width, height, channels: 3 } }).composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
}

function addBox(document, { name, position, size, material }) {
  const [width, height, depth] = size.map((value) => value / 2);
  // Six quad faces, each with an outward normal and simple UVs.
  const faces = [
    { normal: [0, 0, 1], corners: [[-width, -height, depth], [width, -height, depth], [width, height, depth], [-width, height, depth]] },
    { normal: [0, 0, -1], corners: [[width, -height, -depth], [-width, -height, -depth], [-width, height, -depth], [width, height, -depth]] },
    { normal: [1, 0, 0], corners: [[width, -height, depth], [width, -height, -depth], [width, height, -depth], [width, height, depth]] },
    { normal: [-1, 0, 0], corners: [[-width, -height, -depth], [-width, -height, depth], [-width, height, depth], [-width, height, -depth]] },
    { normal: [0, 1, 0], corners: [[-width, height, depth], [width, height, depth], [width, height, -depth], [-width, height, -depth]] },
    { normal: [0, -1, 0], corners: [[-width, -height, -depth], [width, -height, -depth], [width, -height, depth], [-width, -height, depth]] },
  ];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  faces.forEach((face, faceIndex) => {
    const base = faceIndex * 4;
    for (const [index, corner] of face.corners.entries()) {
      positions.push(...corner);
      normals.push(...face.normal);
      uvs.push(index === 0 || index === 3 ? 0 : 1, index < 2 ? 0 : 1);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });

  const primitive = document.createPrimitive()
    .setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(new Float32Array(positions)))
    .setAttribute('NORMAL', document.createAccessor().setType('VEC3').setArray(new Float32Array(normals)))
    .setAttribute('TEXCOORD_0', document.createAccessor().setType('VEC2').setArray(new Float32Array(uvs)))
    .setIndices(document.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)))
    .setMaterial(material);

  const mesh = document.createMesh(name).addPrimitive(primitive);
  return document.createNode(name).setMesh(mesh).setTranslation([...position]);
}

function addCylinder(document, { name, position, radius, width, material, sides = 24 }) {
  // A disc whose axle is +X, closed with two flat ends.
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (const end of [-1, 1]) {
    for (let segment = 0; segment < sides; segment += 1) {
      const angle = (segment / sides) * Math.PI * 2;
      positions.push(end * width / 2, Math.cos(angle) * radius, Math.sin(angle) * radius);
      normals.push(end, 0, 0);
      uvs.push(segment / sides, (end + 1) / 2);
    }
  }
  for (let segment = 0; segment < sides; segment += 1) {
    const next = (segment + 1) % sides;
    indices.push(segment, next, sides + next, segment, sides + next, sides + segment);
  }
  // Caps.
  const capCentre = [positions.length / 3, positions.length / 3 + 1];
  for (const end of [-1, 1]) {
    positions.push(end * width / 2, 0, 0);
    normals.push(end, 0, 0);
    uvs.push(0.5, 0.5);
  }
  for (let segment = 0; segment < sides; segment += 1) {
    const next = (segment + 1) % sides;
    indices.push(capCentre[0], sides + segment, sides + next);
    indices.push(capCentre[1], next, segment);
  }

  const primitive = document.createPrimitive()
    .setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(new Float32Array(positions)))
    .setAttribute('NORMAL', document.createAccessor().setType('VEC3').setArray(new Float32Array(normals)))
    .setAttribute('TEXCOORD_0', document.createAccessor().setType('VEC2').setArray(new Float32Array(uvs)))
    .setIndices(document.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)))
    .setMaterial(material);
  const mesh = document.createMesh(name).addPrimitive(primitive);
  return document.createNode(name).setMesh(mesh).setTranslation([...position]);
}

async function buildCar({ file, length = 4.6, wheelRadius = 0.38, badge = false, frontSign = -1 }) {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene('Scene');

  const bodyTexture = document.createTexture('BodyPaint').setImage(await makeTexture({ label: 'body paint' })).setMimeType('image/png');
  const wheelTexture = document.createTexture('WheelRubber').setImage(await makeTexture({ hue: 40, label: 'wheel' })).setMimeType('image/png');
  const badgeTexture = document.createTexture('BrandBadge').setImage(await makeTexture({ hue: 180, label: 'BADGE' })).setMimeType('image/png');

  const paint = document.createMaterial('Carosserie').setBaseColorTexture(bodyTexture).setMetallicFactor(0.6).setRoughnessFactor(0.3);
  const rubber = document.createMaterial('Tire').setBaseColorTexture(wheelTexture).setRoughnessFactor(0.9);
  const glass = document.createMaterial('Vitres').setBaseColorFactor([0.2, 0.3, 0.35, 1]).setAlphaMode('OPAQUE').setRoughnessFactor(0.1);

  const root = document.createNode('ModelRoot');
  scene.addChild(root);

  const bodyLength = length - wheelRadius * 2.6;
  root.addChild(addBox(document, {
    name: 'body_shell',
    position: [0, wheelRadius + 0.35, 0],
    size: [1.9, 0.7, bodyLength],
    material: paint,
  }));
  root.addChild(addBox(document, {
    name: 'cabin_glass',
    position: [0, wheelRadius + 0.95, 0],
    size: [1.6, 0.5, bodyLength * 0.45],
    material: glass,
  }));
  root.addChild(addBox(document, {
    name: 'headlight_front',
    position: [0, wheelRadius + 0.3, frontSign * (bodyLength / 2 + 0.05)],
    size: [1.4, 0.18, 0.2],
    material: paint,
  }));
  root.addChild(addBox(document, {
    name: 'taillight_rear',
    position: [0, wheelRadius + 0.3, -frontSign * (bodyLength / 2 + 0.05)],
    size: [1.4, 0.18, 0.2],
    material: paint,
  }));

  const halfBase = bodyLength / 2 + 0.4;
  for (const side of [-1, 1]) {
    for (const end of [-1, 1]) {
      const isFront = end === frontSign;
      const dummy = document.createNode(`wheel_${isFront ? 'f' : 'r'}_dummy`);
      dummy.setTranslation([side * 0.8, wheelRadius, end * halfBase]);
      root.addChild(dummy);
      dummy.addChild(addCylinder(document, {
        name: `wheel_${isFront ? 'f' : 'r'}${side < 0 ? 'l' : 'r'}`,
        position: [0, 0, 0],
        radius: wheelRadius,
        width: 0.26,
        material: rubber,
      }));
    }
  }

  if (badge) {
    const badgeNode = addBox(document, {
      name: 'Badge_Logo_Decal',
      position: [0, wheelRadius + 0.7, frontSign * (bodyLength / 2)],
      size: [0.3, 0.12, 0.04],
      material: document.createMaterial('Logo_Emblem').setBaseColorTexture(badgeTexture),
    });
    root.addChild(badgeNode);
  }

  // Extra decoration to give the simplifier something to chew on.
  for (let index = 0; index < 40; index += 1) {
    root.addChild(addBox(document, {
      name: `detail_trim_${index}`,
      position: [0, wheelRadius + 0.1 + index * 0.005, -bodyLength / 2 + (index / 40) * bodyLength],
      size: [1.85, 0.03, 0.02],
      material: paint,
    }));
  }

  const nodeIO = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const target = path.join(OUT_DIR, file);
  await mkdir(OUT_DIR, { recursive: true });
  await nodeIO.write(target, document);
  console.log(`[fixtures] ${file}: ${length} m car, wheels at ±0.8, badge=${badge}, front=${frontSign < 0 ? '-Z' : '+Z'}`);
  void buffer;
}

async function buildTrack({ file, size = 240, trees = 600 }) {
  const document = new Document();
  document.createBuffer();
  const scene = document.createScene('Scene');
  const root = document.createNode('Dirt road scene.fbx');
  scene.addChild(root);

  const roadTexture = document.createTexture('Dirt_Road_Bare').setImage(await makeTexture({ hue: 20, label: 'dirt road' })).setMimeType('image/png');
  const grassTexture = document.createTexture('Grass_Vegetation_Green').setImage(await makeTexture({ hue: 80, label: 'grass' })).setMimeType('image/png');
  const roadMaterial = document.createMaterial('Dirt_Road').setBaseColorTexture(roadTexture).setRoughnessFactor(0.9);
  const grassMaterial = document.createMaterial('Grass_Vegetation').setBaseColorTexture(grassTexture).setRoughnessFactor(1);

  // A wavy road strip running along Z with gentle S-bends.
  const segments = 320;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const halfWidth = 3.2;
  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    const z = -size / 2 + t * size;
    const x = Math.sin(t * Math.PI * 2) * 9;
    const y = (1 - t) * 3 + Math.sin(t * Math.PI * 3) * 0.6;
    for (const side of [-1, 1]) {
      positions.push(x + side * halfWidth, y, z);
      normals.push(0, 1, 0);
      uvs.push((side + 1) / 2, t * 20);
    }
    if (index < segments) {
      const base = index * 2;
      indices.push(base, base + 1, base + 3, base, base + 3, base + 2);
    }
  }
  const roadPrimitive = document.createPrimitive()
    .setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(new Float32Array(positions)))
    .setAttribute('NORMAL', document.createAccessor().setType('VEC3').setArray(new Float32Array(normals)))
    .setAttribute('TEXCOORD_0', document.createAccessor().setType('VEC2').setArray(new Float32Array(uvs)))
    .setIndices(document.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)))
    .setMaterial(roadMaterial);
  const tier = document.createNode('Background_Tree_Atlas.008_Ground_Dirt_0').setMesh(document.createMesh('Dirt_Road_Bare_0').addPrimitive(roadPrimitive));
  root.addChild(tier);

  // Ground plane on both sides plus scattered "trees" (cones).
  const groundPrimitive = document.createPrimitive()
    .setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(new Float32Array([
      -size, -1.2, -size, size, -1.2, -size, size, -1.2, size, -size, -1.2, size,
    ])))
    .setAttribute('NORMAL', document.createAccessor().setType('VEC3').setArray(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0])))
    .setIndices(document.createAccessor().setType('SCALAR').setArray(new Uint32Array([0, 1, 2, 0, 2, 3])))
    .setMaterial(grassMaterial);
  root.addChild(document.createNode('Ground_Dirt_plane').setMesh(document.createMesh('Ground_Dirt_0').addPrimitive(groundPrimitive)));

  const treePositions = [];
  const treeNormals = [];
  const treeIndices = [];
  const trunkHeight = 6;
  for (let cone = 0; cone < 6; cone += 1) {
    const base = treePositions.length / 3;
    const segmentCount = 16;
    const y0 = (cone / 6) * trunkHeight;
    const y1 = ((cone + 1) / 6) * trunkHeight;
    const r0 = 2.2 * (1 - cone / 7);
    const r1 = 2.2 * (1 - (cone + 1) / 7);
    for (let segment = 0; segment <= segmentCount; segment += 1) {
      const angle = (segment / segmentCount) * Math.PI * 2;
      treePositions.push(Math.cos(angle) * r0, y0, Math.sin(angle) * r0);
      treeNormals.push(Math.cos(angle), 0.3, Math.sin(angle));
      treePositions.push(Math.cos(angle) * r1, y1, Math.sin(angle) * r1);
      treeNormals.push(Math.cos(angle), 0.3, Math.sin(angle));
    }
    for (let segment = 0; segment < segmentCount; segment += 1) {
      const a = base + segment * 2;
      treeIndices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  const treePrimitive = document.createPrimitive()
    .setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(new Float32Array(treePositions)))
    .setAttribute('NORMAL', document.createAccessor().setType('VEC3').setArray(new Float32Array(treeNormals)))
    .setIndices(document.createAccessor().setType('SCALAR').setArray(new Uint32Array(treeIndices)))
    .setMaterial(grassMaterial);
  const treeMesh = document.createMesh('Background_Tree_Atlas').addPrimitive(treePrimitive);

  for (let index = 0; index < trees; index += 1) {
    const t = index / trees;
    const z = -size / 2 + t * size;
    const roadX = Math.sin(t * Math.PI * 2) * 9;
    const side = index % 2 === 0 ? 1 : -1;
    const offset = 6 + ((index * 7) % 11);
    const node = document.createNode(`Background_Tree_Atlas.${String(index).padStart(3, '0')}_Trunk_${index % 3 === 0 ? 'Birch' : 'Oak'}_0`)
      .setMesh(treeMesh)
      .setTranslation([roadX + side * offset, -1.2, z])
      .setScale([0.6 + ((index * 13) % 7) / 10]);
    root.addChild(node);
  }

  const nodeIO = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  await mkdir(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, file);
  await nodeIO.write(target, document);
  console.log(`[fixtures] ${file}: ${size} m road with ${trees} instanced trees`);
}

async function main() {
  await buildCar({ file: 'scorpio-n.glb', length: 4.66, wheelRadius: 0.38, badge: true, frontSign: -1 });
  await buildCar({ file: 'terzo-millennio.glb', length: 3.56, wheelRadius: 0.2, badge: true, frontSign: 1 });
  await buildTrack({ file: 'forest-dirt-road.glb' });
  console.log(`[fixtures] written to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error('[fixtures] FATAL:', error);
  process.exitCode = 1;
});
