#!/usr/bin/env node
/**
 * MaxMotors GLB optimizer (gltf-transform).
 *
 * Reads the owner-supplied source GLBs from `assets/raw/` (never committed):
 *   - strips brand badges / interior-only geometry,
 *   - simplifies to the triangle budget,
 *   - resizes + re-encodes textures to WebP (2K cars, 1K foliage),
 *   - applies EXT_meshopt_compression,
 *   - writes the shipped asset into `public/` plus a manifest the game reads at
 *     runtime (placement, wheel pivots, bounds) — and for the forest track a
 *     terrain JSON with a heightfield + traced dirt-road centreline.
 *
 * Usage: node scripts/assets/optimize-glb.mjs [--only <id>] [--out-dir public]
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getBounds } from '@gltf-transform/core';
import { EXTMeshoptCompression, EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, instance, meshopt, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { ASSET_TARGETS, RAW_DIR, REPORT_DIR } from './config.mjs';
import { clusterWheels, descriptorFromBounds } from '../../src/game/cars/wheel-clusters.js';
import { buildTerrainGrid, classifyMaterial, collectTriangles, extractRoadPath, serializeTrail, writeOccupancyArtifacts } from './terrain.mjs';
import { ensureDir, formatBytes, getNodeIO } from './gltf-io.mjs';
import { weldByPosition } from './weld-position.mjs';

const args = process.argv.slice(2);
const onlyIndex = args.indexOf('--only');
const only = onlyIndex === -1 ? null : args[onlyIndex + 1];
const outIndex = args.indexOf('--out-dir');
const OUT_DIR = outIndex === -1 ? null : args[outIndex + 1].replace(/\/$/, '');

/** With --out-dir the pipeline writes somewhere else (dev fixtures / dry runs). */
function targetFor(id, target) {
  if (!OUT_DIR) return target;
  const reroot = (value) => (value ? value.replace(/^public\//, `${OUT_DIR}/`) : value);
  return { ...target, output: reroot(target.output), manifest: reroot(target.manifest), terrainData: reroot(target.terrainData) };
}

const CREDITS = {
  'sikandar-suv': {
    inGameName: 'Sikandar SUV',
    title: '2022 Mahindra Scorpio-N',
    authors: ['Modding Beast (model, textures)', 'BHP3D (export, edits)'],
    source: 'https://sketchfab.com/3d-models/2022-mahindra-scorpio-n-538b10f2860f44e694dc3e9d3e223bf8',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    modified: 'Optimized for MaxMotors (simplified geometry, interior removed, resized/re-encoded textures, brand badges and logos removed).',
  },
  'aurora-v12': {
    inGameName: 'Aurora V12',
    title: '( FREE ) Lamborghini Terzo Millennio',
    authors: ['SDC PERFORMANCE (model)', 'Oxo (base interior)'],
    source: 'https://sketchfab.com/3d-models/free-lamborghini-terzo-millennio-7ad3dffa9d344c3c978eafcc220cb709',
    license: 'CC BY-NC 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
    modified: 'Optimized for MaxMotors (simplified geometry, resized/re-encoded textures, brand badges and logos removed).',
    nonCommercial: 'MaxMotors must remain non-commercial while this model ships.',
  },
  'forest-dirt-trail': {
    inGameName: 'Forest Dirt Trail',
    title: 'Dirt Road Through Forest',
    authors: ['99.Miles'],
    source: 'https://sketchfab.com/99Miles',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    modified: 'Optimized for MaxMotors (simplified geometry, instanced foliage, resized/re-encoded textures).',
  },
};

const ATTEMPTS = [
  { textureScale: 1, qualityDelta: 0, ratioScale: 1 },
  { textureScale: 0.75, qualityDelta: -8, ratioScale: 0.9 },
  { textureScale: 0.5, qualityDelta: -12, ratioScale: 0.8 },
  { textureScale: 0.375, qualityDelta: -16, ratioScale: 0.7 },
];

function matches(value, patterns) {
  const name = (value ?? '').toLowerCase();
  return Boolean(name) && patterns.some((pattern) => name.includes(pattern));
}

function countMeshTriangles(mesh) {
  if (!mesh) return 0;
  let total = 0;
  for (const primitive of mesh.listPrimitives()) {
    const indices = primitive.getIndices();
    total += (indices ? indices.getCount() : primitive.getAttribute('POSITION')?.getCount() ?? 0) / 3;
  }
  return Math.round(total);
}

/**
 * Decoded GPU memory (RGBA8) of every texture that survived into the asset.
 * This is the number the mobile budget in the M2 brief refers to (~150 MB), and
 * it is what forces the forest foliage down to 512 px.
 */
function estimateTextureMemoryMB(document) {
  let bytes = 0;
  for (const texture of document.getRoot().listTextures()) {
    const size = texture.getSize();
    const [width, height] = Array.isArray(size) ? size : [0, 0];
    if (!width || !height) {
      bytes += 1024 * 1024;
      continue;
    }
    bytes += width * height * 4;
  }
  return bytes / (1024 * 1024);
}

function countTriangles(document) {
  let total = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      total += indices ? indices.getCount() / 3 : (primitive.getAttribute('POSITION')?.getCount() ?? 0) / 3;
    }
  }
  return Math.round(total);
}

function stripBrandAssets(document, target) {
  const removedNodes = [];
  const removedMaterials = [];
  const removedMeshes = [];

  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    const label = `${node.getName()} ${mesh?.getName() ?? ''}`;
    if (!matches(label, target.stripNodePatterns)) continue;
    const triangles = mesh
      ? mesh.listPrimitives().reduce((sum, primitive) => {
        const indices = primitive.getIndices();
        return sum + (indices ? indices.getCount() : primitive.getAttribute('POSITION')?.getCount() ?? 0) / 3;
      }, 0)
      : 0;
    // Never delete a node that carries real geometry we still need elsewhere.
    if (triangles > 20_000) continue;
    removedNodes.push(node.getName() || mesh?.getName() || '(unnamed)');
    if (mesh) removedMeshes.push(mesh.getName() || '(unnamed)');
    node.dispose();
  }

  for (const material of document.getRoot().listMaterials()) {
    if (!matches(material.getName(), target.stripMaterialPatterns)) continue;
    removedMaterials.push(material.getName());
    material.dispose();
  }

  return { removedNodes, removedMaterials, removedMeshes };
}

/**
 * Drops interior-only primitives: a chase-camera game never sees them and they
 * cost a large share of the triangle budget. Skipped when the glass is actually
 * transparent, otherwise the empty shell would be visible through it.
 */
function stripInterior(document, kind = 'car') {
  const materials = document.getRoot().listMaterials();
  const transparentGlass = materials.some((material) => {
    if (classifyMaterial(material, { kind }) !== 'glass') return false;
    const alpha = material.getBaseColorFactor()[3];
    return material.getAlphaMode() === 'BLEND' && alpha < 0.92;
  });
  if (transparentGlass) return { removed: [], skipped: 'glass is transparent' };

  const removed = new Map();
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial();
      if (!material || classifyMaterial(material, { kind }) !== 'interior') continue;
      removed.set(material.getName(), (removed.get(material.getName()) ?? 0) + 1);
      primitive.dispose();
    }
  }
  return { removed: [...removed.keys()], skipped: null };
}

/**
 * Removes small, flat plaques: real-world badges and lettering are usually
 * separate 30–60 triangle meshes pressed onto the body, with names that give
 * nothing away (`scorpio_n_ext_1.2`, `detach_04_LOD2_details`). Glass, lights
 * and wheels are never touched, so windows and LEDs survive.
 */
function stripFlatDecals(document, target, kind = 'car') {
  const bounds = sceneBounds(document);
  const length = Math.max(bounds.size[0], bounds.size[2]) || 1;
  const width = Math.max(bounds.size[0], bounds.size[2]) || 1;
  // A badge/lettering plaque is a thin, small plate lying on the body. Aerodynamic
  // parts (wings, splitters, diffusers) are bigger, so they stay.
  const maxThickness = 0.004 * length;
  const maxDimension = 0.16 * length;
  const maxFootprint = 0.03 * length * width;
  const protectedNames = /wing|spoiler|diffuser|splitter|mirror|handle|wiper|grill|vent|duct|camera|plate_?light|reflector/i;
  const removed = [];

  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const label = node.getName() || mesh.getName() || '';
    if (protectedNames.test(label)) continue;
    const triangles = countMeshTriangles(mesh);
    if (triangles > 3000) continue;
    const box = getBounds(node);
    const size = [0, 1, 2].map((axis) => box.max[axis] - box.min[axis]);
    if (!size.every(Number.isFinite)) continue;
    const sorted = [...size].sort((a, b) => a - b);
    const [thickness, middle, longest] = sorted;
    if (thickness > maxThickness || longest > maxDimension || longest * middle > maxFootprint) continue;
    const classes = new Set(mesh.listPrimitives().map((primitive) => classifyMaterial(primitive.getMaterial(), { kind })));
    if (classes.has('glass') || classes.has('light') || classes.has('wheel')) continue;
    removed.push(`${label} (${size.map((value) => value.toFixed(3)).join('x')})`);
    node.dispose();
  }
  return removed;
}

async function compressTextures(document, { textureSize, quality }) {
  const normalTextures = new Set();
  for (const material of document.getRoot().listMaterials()) {
    const normal = material.getNormalTexture();
    if (normal) normalTextures.add(normal);
  }
  let before = 0;
  let after = 0;

  for (const texture of document.getRoot().listTextures()) {
    const image = texture.getImage();
    if (!image) continue;
    before += image.byteLength;
    try {
      const buffer = Buffer.from(image);
      const metadata = await sharp(buffer).metadata();
      const longest = Math.max(metadata.width ?? 0, metadata.height ?? 0);
      let pipeline = sharp(buffer);
      if (longest > textureSize) {
        pipeline = pipeline.resize({
          width: metadata.width >= metadata.height ? textureSize : undefined,
          height: metadata.height > metadata.width ? textureSize : undefined,
          fit: 'inside',
        });
      }
      const encoded = normalTextures.has(texture)
        ? await pipeline.webp({ nearLossless: true, quality: Math.min(95, quality + 12) }).toBuffer()
        : await pipeline.webp({ quality }).toBuffer();
      if (encoded.byteLength < image.byteLength) {
        texture.setImage(encoded).setMimeType('image/webp');
      }
      after += texture.getImage()?.byteLength ?? 0;
    } catch (error) {
      console.warn(`[optimize] texture "${texture.getName()}" left as-is: ${error.message}`);
      after += image.byteLength;
    }
  }

  if (document.getRoot().listTextures().some((texture) => texture.getMimeType() === 'image/webp')) {
    document.createExtension(EXTTextureWebP).setRequired(true);
  }
  return { before, after };
}

function sceneBounds(document) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const node of document.getRoot().listNodes()) {
    if (!node.getMesh()) continue;
    const box = getBounds(node);
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], box.min[axis]);
      max[axis] = Math.max(max[axis], box.max[axis]);
    }
  }
  return { min, max, size: [0, 1, 2].map((axis) => max[axis] - min[axis]) };
}

/**
 * Depth-first walk. Candidate ids are scene-graph paths (`/root/child/...`) so
 * the runtime rig can resolve exactly the same nodes through GLTFLoader.
 */
function collectNodeCandidates(document) {
  const candidates = [];
  const walk = (node, ancestors, parentPath, siblingIndex) => {
    const mesh = node.getMesh();
    const name = node.getName() || mesh?.getName() || '(unnamed)';
    // Node names repeat (two `wheel_f_dummy`s, dozens of `Object_*`), so the
    // path records the occurrence index among same-named siblings: `name#0`.
    const nodePath = `${parentPath}/${name}#${siblingIndex}`;
    if (mesh) {
      const box = getBounds(node);
      candidates.push(descriptorFromBounds({
        id: nodePath,
        name,
        min: box.min,
        max: box.max,
        // Node name only: this model reuses wheel *material* names on doors.
        wheelish: /wheel|tyre|tire|rim|pneu|roue|jante/i.test(node.getName() || ''),
        ancestorIds: ancestors,
      }));
    }
    const counters = new Map();
    for (const child of node.listChildren()) {
      const childName = child.getName() || child.getMesh()?.getName() || '(unnamed)';
      const occurrence = counters.get(childName) ?? 0;
      counters.set(childName, occurrence + 1);
      walk(child, [...ancestors, nodePath], nodePath, occurrence);
    }
  };
  for (const scene of document.getRoot().listScenes()) {
    const counters = new Map();
    for (const node of scene.listChildren()) {
      const name = node.getName() || node.getMesh()?.getName() || '(unnamed)';
      const occurrence = counters.get(name) ?? 0;
      counters.set(name, occurrence + 1);
      walk(node, [], '', occurrence);
    }
  }
  return { candidates };
}

function rotateY(vector, yaw) {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return [vector[0] * cos + vector[2] * sin, vector[1], -vector[0] * sin + vector[2] * cos];
}

/**
 * Normalizes the model into car space: -Z is forward, origin at the wheel
 * contact plane on the model's XZ centre, length scaled to `targetLengthMeters`.
 */
function computeCarPlacement(document, target, bounds) {
  const longAxis = bounds.size[0] >= bounds.size[2] ? 0 : 2;
  const length = bounds.size[longAxis] || 1;
  const scale = target.targetLengthMeters / length;

  // Front detection only reads NODE names: glTF deduplication can legitimately
  // make a headlight and a taillight share one mesh, which would poison any
  // mesh-name based signal.
  const frontPattern = /head.?light|front.?light|front.?bumper|faros|hood|_fl\b|front|anteriore|antérieur|steering|movsteer/i;
  const rearPattern = /tail.?light|rear.?light|back.?light|brake.?light|exhaust|_rl\b|rear|diff|spoiler|trunk|arri|feu.*rouge/i;
  let frontScore = 0;
  let rearScore = 0;
  let named = 0;
  for (const node of document.getRoot().listNodes()) {
    if (!node.getMesh()) continue;
    const label = node.getName() || node.getMesh().getName() || '';
    if (!label) continue;
    const box = getBounds(node);
    const center = [0, 1, 2].map((axis) => (box.min[axis] + box.max[axis]) / 2);
    const relative = center[longAxis] - (bounds.min[longAxis] + bounds.max[longAxis]) / 2;
    if (!Number.isFinite(relative)) continue;
    const sign = relative >= 0 ? 1 : -1;
    if (frontPattern.test(label)) {
      frontScore += sign;
      named += 1;
    } else if (rearPattern.test(label)) {
      rearScore += sign;
      named += 1;
    }
  }
  // Ties default to -Z forward: that is what every car in the pack uses, and
  // guessing +Z would silently spin the shipped model 180°.
  const lean = frontScore - rearScore;
  const frontSign = lean > 0 ? 1 : -1;
  const frontDir = [0, 0, 0];
  frontDir[longAxis] = frontSign;

  let yaw = 0;
  let best = -Infinity;
  for (const candidate of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const rotated = rotateY(frontDir, candidate);
    const score = -rotated[2]; // front must point to -Z
    if (score > best) {
      best = score;
      yaw = candidate;
    }
  }

  const { candidates } = collectNodeCandidates(document);
  const wheelData = clusterWheels(candidates, {
    modelWidth: bounds.size[0],
    modelCenterX: (bounds.min[0] + bounds.max[0]) / 2,
    groundY: bounds.min[1],
    height: bounds.size[1],
    halfLength: bounds.size[2] / 2,
    expectedRadius: Math.max(0.12, length * 0.07),
    axleAxis: 0,
  });

  const contactPlaneY = wheelData.complete && wheelData.frontZ !== null
    ? Math.min(...wheelData.wheels.map((wheel) => wheel.center[1] - wheel.radius))
    : bounds.min[1];
  const pivot = [
    (bounds.min[0] + bounds.max[0]) / 2,
    contactPlaneY,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const position = rotateY([-pivot[0] * scale, -pivot[1] * scale, -pivot[2] * scale], yaw);

  const toNormalized = (point) => {
    const rotated = rotateY([point[0] - pivot[0], point[1] - pivot[1], point[2] - pivot[2]], yaw);
    return rotated.map((value) => value * scale);
  };

  return {
    yaw,
    scale,
    pivot,
    position,
    toNormalized,
    frontConfidence: lean !== 0 ? `naming(${named})` : 'default(-Z)',
    wheelData,
  };
}

async function optimizeOnce(target, attempt) {
  const io = await getNodeIO();
  const document = await io.read(path.join(RAW_DIR, target.source));
  await document.transform(dedup(), weld());

  const strip = stripBrandAssets(document, target);
  const textureSize = Math.max(512, Math.round(target.textureSize * attempt.textureScale));
  const quality = Math.max(45, target.textureQuality + attempt.qualityDelta);

  const trianglesBefore = countTriangles(document);
  let trianglesAfter = trianglesBefore;
  const triangleBudget = Math.round(target.maxTriangles * attempt.ratioScale);
  // The triangle budget is the hard target: the allowed geometric error is
  // scaled up until the mesh fits, so a 341k-triangle model still lands inside
  // its documented limit instead of stopping at whatever ratio simplifies to.
  if (trianglesBefore > triangleBudget) {
    let error = target.simplifyError ?? 0.005;
    for (let round = 0; round < 4 && trianglesAfter > triangleBudget; round += 1) {
      const ratio = Math.max(0.02, Math.min(1, triangleBudget / trianglesAfter));
      await document.transform(simplify({
        simplifier: MeshoptSimplifier,
        ratio,
        error,
        lockBorder: false,
      }));
      const next = countTriangles(document);
      console.log(`[optimize] simplify pass ${round + 1}: ratio ${ratio.toFixed(3)} error ${error.toFixed(4)} -> ${next.toLocaleString()} tris`);
      if (next >= trianglesAfter && round > 0) break;
      error *= 3;
      trianglesAfter = next;
    }

    // Last resort for UV-split exports: welding by position reconnects the mesh so
    // the simplifier can collapse across texture island seams, and dropping the
    // degenerate triangles it creates (pole fans, seam slivers) is what actually
    // lets meshopt work. The grid starts at exact positions and coarsens until the
    // budget is met, so a model that is a soup of per-face vertices still lands
    // inside its documented limit.
    const extent = Math.max(1, ...sceneBounds(document).size);
    const tolerances = [
      1e-4,
      extent * 0.0005,
      extent * 0.001,
      extent * 0.002,
      extent * 0.004,
      extent * 0.008,
      extent * 0.016,
    ];
    for (const tolerance of tolerances) {
      if (trianglesAfter <= triangleBudget) break;
      const { merged, dropped } = weldByPosition(document, { tolerance });
      if (!merged && !dropped) continue;
      console.log(`[optimize] budget pass (grid ${tolerance.toFixed(4)} m): merged ${merged.toLocaleString()} verts, dropped ${dropped.toLocaleString()} degenerate tris`);
      await document.transform(simplify({
        simplifier: MeshoptSimplifier,
        ratio: Math.max(0.02, Math.min(1, triangleBudget / trianglesAfter)),
        error: Math.min(1, error),
        lockBorder: false,
      }));
      trianglesAfter = countTriangles(document);
      console.log(`[optimize] after grid ${tolerance.toFixed(4)} m + simplify -> ${trianglesAfter.toLocaleString()} tris`);
    }
    if (trianglesAfter > triangleBudget) {
      console.warn(`[optimize] ${target.id} is still over its triangle budget: ${trianglesAfter.toLocaleString()} > ${triangleBudget.toLocaleString()}`);
    }
  }

  const interior = target.kind === 'car' ? stripInterior(document, target.kind) : { removed: [], skipped: null };
  const flatDecals = target.kind === 'car' ? stripFlatDecals(document, target, target.kind) : [];
  if (flatDecals.length) {
    console.log(`[optimize] flat badge plaques removed (${flatDecals.length}): ${flatDecals.slice(0, 8).join(', ')}${flatDecals.length > 8 ? ', …' : ''}`);
  }
  if (interior.removed.length) {
    console.log(`[optimize] interior removed: ${interior.removed.join(', ')}`);
  } else if (interior.skipped) {
    console.log(`[optimize] interior kept (${interior.skipped})`);
  }

  const textureStats = await compressTextures(document, { textureSize, quality });
  const textureMemory = estimateTextureMemoryMB(document);
  await document.transform(prune());

  let terrain = null;
  if (target.kind === 'track') {
    // Terrain data must be measured before instancing: instanced foliage keeps
    // its transforms in EXT_mesh_gpu_instancing, which a plain walk cannot see.
    const bounds = sceneBounds(document);
    const { triangles, materials } = collectTriangles(document, { kind: target.kind });
    const grid = buildTerrainGrid({ triangles, materials, bounds, cellSize: 2 });
    terrain = { grid, road: extractRoadPath(grid), bounds };
    try {
      await document.transform(instance({ min: 4 }));
    } catch (error) {
      console.warn('[optimize] instancing skipped:', error.message);
    }
  }

  document.createExtension(EXTMeshoptCompression).setRequired(true).setEncoder?.(MeshoptEncoder);
  await document.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));

  return { document, strip, interior, flatDecals, textureStats, textureMemory, terrain, trianglesBefore, trianglesAfter, textureSize, quality };
}

async function writeHillshade(grid, filePath) {
  const { cols, rows, low } = grid;
  let min = Infinity;
  let max = -Infinity;
  for (const value of low) {
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const span = Math.max(0.001, max - min);
  const buffer = Buffer.alloc(cols * rows * 3);
  for (let iz = 0; iz < rows; iz += 1) {
    for (let ix = 0; ix < cols; ix += 1) {
      const value = low[iz * cols + ix];
      const normalized = Number.isFinite(value) ? (value - min) / span : 0.1;
      const east = Number.isFinite(low[iz * cols + Math.min(cols - 1, ix + 1)]) ? low[iz * cols + Math.min(cols - 1, ix + 1)] : value;
      const north = iz + 1 < rows && Number.isFinite(low[(iz + 1) * cols + ix]) ? low[(iz + 1) * cols + ix] : value;
      const shade = Math.max(0.15, Math.min(1, 0.55 + (value - east) * 0.35 + (value - north) * 0.35 + normalized * 0.4));
      const offset = ((rows - 1 - iz) * cols + ix) * 3;
      buffer[offset] = Math.round(232 * shade);
      buffer[offset + 1] = Math.round(224 * shade);
      buffer[offset + 2] = Math.round(210 * shade);
    }
  }
  await sharp(buffer, { raw: { width: cols, height: rows, channels: 3 } }).png().toFile(filePath);
}

async function buildCarManifest(document, target, id, { strip, interior, flatDecals, textureStats, textureMemory, trianglesBefore, trianglesAfter, textureSize, quality, bytes, attemptIndex }) {
  const bounds = sceneBounds(document);
  const placement = computeCarPlacement(document, target, bounds);
  const { wheelData } = placement;

  // Corner labels are re-derived in normalized space: after the yaw fix the
  // front of every car is -Z, so `front`/`rear` always mean the same thing.
  const wheels = wheelData.wheels.map((wheel) => {
    const position = placement.toNormalized(wheel.center);
    const corner = `${position[2] <= 0 ? 'front' : 'rear'}-${position[0] >= 0 ? 'right' : 'left'}`;
    return {
      corner,
      position: position.map((value) => Number(value.toFixed(3))),
      radius: Number((wheel.radius * placement.scale).toFixed(3)),
      width: Number((wheel.width * placement.scale).toFixed(3)),
      axleAxis: 'x',
      source: wheel.source,
      confidence: wheel.confidence,
      members: wheel.memberNames,
      memberPaths: wheel.members,
    };
  });
  const frontWheels = wheels.filter((wheel) => wheel.corner.startsWith('front'));
  const rearWheels = wheels.filter((wheel) => wheel.corner.startsWith('rear'));
  const average = (list, axis) => (list.length ? list.reduce((sum, wheel) => sum + wheel.position[axis], 0) / list.length : null);
  const wheelbase = frontWheels.length && rearWheels.length ? average(rearWheels, 2) - average(frontWheels, 2) : null;
  const trackSpan = wheels.length >= 2
    ? Math.max(...wheels.map((wheel) => wheel.position[0])) - Math.min(...wheels.map((wheel) => wheel.position[0]))
    : null;

  const bounds3 = (() => {
    const points = [];
    for (const node of document.getRoot().listNodes()) {
      if (!node.getMesh()) continue;
      const box = getBounds(node);
      for (const corner of [
        [box.min[0], box.min[1], box.min[2]], [box.max[0], box.min[1], box.min[2]],
        [box.min[0], box.max[1], box.min[2]], [box.max[0], box.max[1], box.min[2]],
        [box.min[0], box.min[1], box.max[2]], [box.max[0], box.min[1], box.max[2]],
        [box.min[0], box.max[1], box.max[2]], [box.max[0], box.max[1], box.max[2]],
      ]) points.push(placement.toNormalized(corner));
    }
    return {
      min: [0, 1, 2].map((axis) => Number(Math.min(...points.map((point) => point[axis])).toFixed(3))),
      max: [0, 1, 2].map((axis) => Number(Math.max(...points.map((point) => point[axis])).toFixed(3))),
    };
  })();

  return {
    id,
    kind: 'car',
    generatedAt: new Date().toISOString(),
    credits: CREDITS[id],
    units: 'meters',
    source: { file: `assets/raw/${target.source}`, triangles: trianglesBefore, bounds: { min: bounds.min.map((v) => Number(v.toFixed(3))), max: bounds.max.map((v) => Number(v.toFixed(3))) } },
    output: {
      file: target.output,
      bytes,
      triangles: trianglesAfter,
      attempts: attemptIndex + 1,
      textureSizePx: textureSize,
      textureQuality: quality,
      textureBytesBefore: textureStats.before,
      textureBytesAfter: textureStats.after,
      textureMemoryMB: Number((textureMemory ?? 0).toFixed(1)),
      triangleBudget: target.maxTriangles,
      overBudget: trianglesAfter > target.maxTriangles,
      sizeBudgetBytes: target.maxBytes,
    },
    transform: {
      yawRadians: Number(placement.yaw.toFixed(6)),
      yawDegrees: Number(((placement.yaw * 180) / Math.PI).toFixed(2)),
      scale: Number(placement.scale.toFixed(6)),
      position: placement.position.map((value) => Number(value.toFixed(4))),
      frontConfidence: placement.frontConfidence,
      sourceSize: bounds.size.map((value) => Number(value.toFixed(3))),
      longAxis: bounds.size[0] >= bounds.size[2] ? 'x' : 'z',
    },
    bounds: bounds3,
    size: [0, 1, 2].map((axis) => Number((bounds3.max[axis] - bounds3.min[axis]).toFixed(3))),
    wheels: {
      detected: wheels.length === 4,
      count: wheels.length,
      wheelbase: wheelbase === null ? null : Number(wheelbase.toFixed(3)),
      track: trackSpan === null ? null : Number(trackSpan.toFixed(3)),
      radius: wheels.length ? Number((wheels.reduce((sum, wheel) => sum + wheel.radius, 0) / wheels.length).toFixed(3)) : null,
      frontZ: frontWheels.length ? Number(average(frontWheels, 2).toFixed(3)) : null,
      rearZ: rearWheels.length ? Number(average(rearWheels, 2).toFixed(3)) : null,
      list: wheels,
    },
    strip: { ...strip, interiorRemoved: interior?.removed ?? [], interiorSkipped: interior?.skipped ?? null, flatDecalRemoved: flatDecals ?? [] },
    materials: document.getRoot().listMaterials().map((material) => ({
      name: material.getName(),
      alphaMode: material.getAlphaMode(),
      doubleSided: material.getDoubleSided(),
      emissive: material.getEmissiveFactor().some((value) => value > 0.01),
      baseColor: material.getBaseColorFactor().map((value) => Number(value.toFixed(3))),
      textures: [
        material.getBaseColorTexture() ? 'baseColor' : null,
        material.getNormalTexture() ? 'normal' : null,
        material.getMetallicRoughnessTexture() ? 'metalRough' : null,
        material.getEmissiveTexture() ? 'emissive' : null,
        material.getOcclusionTexture() ? 'occlusion' : null,
      ].filter(Boolean),
    })),
    stats: {
      nodes: document.getRoot().listNodes().length,
      meshes: document.getRoot().listMeshes().length,
      materials: document.getRoot().listMaterials().length,
      textures: document.getRoot().listTextures().length,
    },
  };
}

/**
 * Documents every texture that survives into the shipped file, together with
 * the materials that use it — the badge-removal check for the brief.
 */
async function writeShippedTextureReport(document, outPath, sheetPath) {
  const usage = new Map();
  for (const material of document.getRoot().listMaterials()) {
    const slots = [
      ['baseColor', material.getBaseColorTexture()],
      ['normal', material.getNormalTexture()],
      ['metalRough', material.getMetallicRoughnessTexture()],
      ['emissive', material.getEmissiveTexture()],
      ['occlusion', material.getOcclusionTexture()],
    ];
    for (const [slot, texture] of slots) {
      if (!texture) continue;
      if (!usage.has(texture)) usage.set(texture, new Map());
      usage.get(texture).set(material.getName(), slot);
    }
  }

  const entries = [];
  const textures = document.getRoot().listTextures();
  for (const [index, texture] of textures.entries()) {
    const materials = usage.get(texture) ?? new Map();
    const image = texture.getImage();
    let width = null;
    let height = null;
    if (image) {
      const metadata = await sharp(Buffer.from(image)).metadata().catch(() => null);
      width = metadata?.width ?? null;
      height = metadata?.height ?? null;
    }
    entries.push({
      index,
      mimeType: texture.getMimeType(),
      bytes: image?.byteLength ?? 0,
      width,
      height,
      used: materials.size > 0,
      materials: [...materials.keys()],
      slots: [...new Set([...materials.values()])],
    });
  }

  await writeFile(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), count: entries.length, textures: entries }, null, 2)}\n`);

  const tile = 220;
  const columns = Math.min(5, Math.max(1, entries.filter((entry) => entry.used).length));
  const used = entries.filter((entry) => entry.used);
  if (!used.length) return entries;
  const rows = Math.ceil(used.length / columns);
  const composites = [];
  const labels = [];
  for (const [position, entry] of used.entries()) {
    const texture = textures[entry.index];
    const image = texture.getImage();
    if (!image) continue;
    const buffer = await sharp(Buffer.from(image))
      .resize(tile, tile, { fit: 'inside', background: { r: 14, g: 18, b: 20 } })
      .flatten({ background: { r: 14, g: 18, b: 20 } })
      .png()
      .toBuffer();
    const size = await sharp(buffer).metadata();
    const left = (position % columns) * tile + Math.round((tile - size.width) / 2);
    const top = Math.floor(position / columns) * tile + Math.round((tile - size.height) / 2);
    composites.push({ input: buffer, left, top });
    const label = `#${entry.index} ${Math.max(entry.width ?? 0, entry.height ?? 0)}px ${Math.round(entry.bytes / 1024)}KB ${entry.materials.slice(0, 2).join(',')}`;
    labels.push(
      `<rect x="${(position % columns) * tile + 2}" y="${Math.floor(position / columns) * tile + 2}" width="${Math.min(tile - 4, label.length * 6.2 + 8)}" height="18" fill="rgba(8,10,12,0.8)"/>`
      + `<text x="${(position % columns) * tile + 6}" y="${Math.floor(position / columns) * tile + 15}" font-family="monospace" font-size="11" fill="#ffd9a0">${label.replace(/[<>&]/g, '')}</text>`,
    );
  }
  await sharp({ create: { width: columns * tile, height: Math.max(1, rows * tile), channels: 3, background: { r: 12, g: 16, b: 18 } } })
    .composite([...composites, { input: Buffer.from(`<svg width="${columns * tile}" height="${rows * tile}">${labels.join('')}</svg>`), top: 0, left: 0 }])
    .png()
    .toFile(sheetPath);
  return entries;
}

async function buildAsset(id, target) {
  const outputPath = target.output;
  await ensureDir(outputPath);
  let best = null;

  for (let attemptIndex = 0; attemptIndex < ATTEMPTS.length; attemptIndex += 1) {
    const attempt = ATTEMPTS[attemptIndex];
    const result = await optimizeOnce(target, attempt);
    const io = await getNodeIO();
    const bytes = Buffer.from(await io.writeBinary(result.document)).byteLength;
    const withinSize = bytes <= target.maxBytes;
    const withinTriangles = result.trianglesAfter <= target.maxTriangles + 2;
    const withinMemory = !target.maxTextureMemoryMB || result.textureMemory <= target.maxTextureMemoryMB;
    console.log(
      `[optimize] ${id} attempt ${attemptIndex + 1}: ${formatBytes(bytes)} (limit ${formatBytes(target.maxBytes)}) | ` +
        `tris ${result.trianglesAfter.toLocaleString()} (limit ${target.maxTriangles.toLocaleString()}) | ` +
        `textures ${formatBytes(result.textureStats.after)} @${result.textureSize}px q${result.quality} | ` +
        `GPU ${result.textureMemory.toFixed(0)} MB${target.maxTextureMemoryMB ? ` (limit ${target.maxTextureMemoryMB})` : ''}`,
    );
    if (!best || bytes < best.bytes) best = { ...result, bytes, attemptIndex };
    if (withinSize && withinTriangles && withinMemory) break;
    if (typeof result.document.dispose === 'function') result.document.dispose();
  }

  const { document, bytes } = best;
  const io = await getNodeIO();
  await io.write(outputPath, document);
  await ensureDir(target.manifest);

  const shippedTextures = await writeShippedTextureReport(
    document,
    path.join(REPORT_DIR, `${id}.textures.json`),
    path.join(REPORT_DIR, `${id}.shipped-textures.png`),
  );
  const unusedTextures = shippedTextures.filter((entry) => !entry.used).length;
  console.log(`[optimize] ${id} shipped textures: ${shippedTextures.length - unusedTextures} used, ${unusedTextures} unused`);

  let manifest;
  if (target.kind === 'car') {
    manifest = await buildCarManifest(document, target, id, best);
  } else {
    const { grid, road, bounds } = best.terrain;
    const pathY = road.path.filter(Boolean).map((point) => point[1]).sort((a, b) => a - b);
    const medianY = pathY.length ? pathY[Math.floor(pathY.length / 2)] : 0;
    const heightOffset = -medianY;
    const trail = serializeTrail(grid, { id, path: road.path, roadHalfWidth: road.roadHalfWidth, heightOffset });
    trail.bounds = {
      min: [Number((grid.min[0]).toFixed(3)), trail.stats.minHeight, Number((grid.min[1]).toFixed(3))],
      max: [
        Number((grid.min[0] + grid.cols * grid.cellSize).toFixed(3)),
        trail.stats.maxHeight,
        Number((grid.min[1] + grid.rows * grid.cellSize).toFixed(3)),
      ],
    };
    trail.roadCoverage = Number(road.coverage.toFixed(4));
    await writeFile(target.terrainData, `${JSON.stringify(trail)}\n`);
    await writeOccupancyArtifacts(grid, {
      asciiPath: path.join(REPORT_DIR, `${id}.map.txt`),
      pngPath: path.join(REPORT_DIR, `${id}.map.png`),
      label: `${id} (optimized)`,
      path: road.path,
    });
    await writeHillshade(grid, path.join(REPORT_DIR, `${id}.height.png`));

    console.log(
      `[optimize] ${id} terrain: road ${road.path.filter(Boolean).length} pts, half-width ${road.roadHalfWidth.toFixed(2)} m, ` +
        `coverage ${(road.coverage * 100).toFixed(2)}%, grid ${grid.cols}x${grid.rows} @ ${grid.cellSize.toFixed(2)} m, ` +
        `offset ${heightOffset.toFixed(2)}`,
    );

    manifest = {
      id,
      kind: 'track',
      generatedAt: new Date().toISOString(),
      credits: CREDITS[id],
      units: 'meters',
      source: { file: `assets/raw/${target.source}`, triangles: best.trianglesBefore },
      output: {
        file: target.output,
        bytes,
        triangles: best.trianglesAfter,
        attempts: best.attemptIndex + 1,
        textureSizePx: best.textureSize,
        textureQuality: best.quality,
        textureBytesBefore: best.textureStats.before,
        textureBytesAfter: best.textureStats.after,
      },
      transform: { yawRadians: 0, scale: 1, position: [0, 0, 0], note: 'track keeps source orientation; terrain JSON carries the vertical offset' },
      bounds: {
        min: bounds.min.map((value) => Number(value.toFixed(3))),
        max: bounds.max.map((value) => Number(value.toFixed(3))),
      },
      size: bounds.size.map((value) => Number(value.toFixed(3))),
      terrain: {
        file: target.terrainData,
        cellSize: trail.cellSize,
        cols: trail.cols,
        rows: trail.rows,
        heightOffset: trail.heightOffset,
        roadHalfWidth: trail.roadHalfWidth,
        roadPoints: trail.path.length,
        roadCoverage: trail.roadCoverage,
        heights: trail.stats,
      },
      strip: { ...best.strip, interiorRemoved: best.interior.removed, interiorSkipped: best.interior.skipped, flatDecalRemoved: best.flatDecals },
      stats: {
        nodes: document.getRoot().listNodes().length,
        meshes: document.getRoot().listMeshes().length,
        materials: document.getRoot().listMaterials().length,
        textures: document.getRoot().listTextures().length,
      },
    };
  }

  await writeFile(target.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  if (typeof document.dispose === 'function') document.dispose();

  const verify = await stat(outputPath);
  console.log(
    `[optimize] ${id} -> ${outputPath} ${formatBytes(verify.size)} | ${best.trianglesAfter.toLocaleString()} tris | ${JSON.stringify(manifest.wheels ?? manifest.terrain)}`,
  );
  return manifest;
}

async function main() {
  await mkdir(REPORT_DIR, { recursive: true });
  const manifests = [];
  for (const [id, baseTarget] of Object.entries(ASSET_TARGETS)) {
    if (only && id !== only) continue;
    const target = targetFor(id, baseTarget);
    try {
      await readFile(path.join(RAW_DIR, target.source));
    } catch {
      console.error(`[optimize] missing source ${path.join(RAW_DIR, target.source)} — run fetch-sources.mjs first`);
      process.exitCode = 1;
      continue;
    }
    const manifest = await buildAsset(id, target);
    manifests.push(manifest);
  }
  await writeFile(path.join(REPORT_DIR, 'optimized-manifests.json'), `${JSON.stringify(manifests, null, 2)}\n`);
  console.log(`[optimize] done: ${manifests.length} assets`);
}

main().catch((error) => {
  console.error('[optimize] FATAL:', error);
  process.exitCode = 1;
});
