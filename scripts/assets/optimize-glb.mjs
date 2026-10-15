#!/usr/bin/env node
/**
 * MaxMotors GLB optimizer (gltf-transform).
 *
 * Reads the owner-supplied source GLBs from `assets/raw/` (never committed),
 * strips brand badges, simplifies to the triangle budget, resizes + re-encodes
 * textures to WebP, applies EXT_meshopt_compression, and writes the shipped
 * assets into `public/` together with a manifest the game reads at runtime.
 *
 * Usage: node scripts/assets/optimize-glb.mjs [--only <id>] [--out-dir public]
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getBounds, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { ASSET_TARGETS, RAW_DIR } from './config.mjs';
import { ensureDir, formatBytes, getNodeIO } from './gltf-io.mjs';

const args = process.argv.slice(2);
const onlyIndex = args.indexOf('--only');
const only = onlyIndex === -1 ? null : args[onlyIndex + 1];

const CREDITS = {
  'sikandar-suv': {
    inGameName: 'Sikandar SUV',
    title: '2022 Mahindra Scorpio-N',
    authors: ['Modding Beast (model, textures)', 'BHP3D (export, edits)'],
    source: 'https://sketchfab.com/3d-models/2022-mahindra-scorpio-n-538b10f2860f44e694dc3e9d3e223bf8',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    modified: 'Optimized for MaxMotors (simplified geometry, resized/re-encoded textures, brand badges and logos removed).',
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
    modified: 'Optimized for MaxMotors (simplified geometry, resized/re-encoded textures).',
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

function stripBrandAssets(document, target) {
  const removedNodes = [];
  const removedMaterials = [];
  const removedMeshes = [];

  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    const label = `${node.getName()} ${mesh?.getName() ?? ''}`;
    if (!matches(label, target.stripNodePatterns)) continue;
    // Never delete a node that carries real geometry we still need elsewhere.
    if (mesh && mesh.listPrimitives().reduce((sum, primitive) => {
      const indices = primitive.getIndices();
      return sum + (indices ? indices.getCount() : primitive.getAttribute('POSITION')?.getCount() ?? 0);
    }, 0) > 60_000) continue;
    removedNodes.push(node.getName() || mesh?.getName() || '(unnamed)');
    if (mesh) removedMeshes.push(mesh);
    node.dispose();
  }

  for (const material of document.getRoot().listMaterials()) {
    if (!matches(material.getName(), target.stripMaterialPatterns)) continue;
    removedMaterials.push(material.getName());
    material.dispose();
  }

  return { removedNodes, removedMaterials, removedMeshes };
}

function collectWorldVertices(document, limit = 400_000) {
  const points = [];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const world = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      if (!position) continue;
      const count = position.getCount();
      const stride = Math.max(1, Math.floor(count / Math.max(1, limit / 128)));
      for (let index = 0; index < count; index += stride) {
        const [x, y, z] = position.getElement(index, [0, 0, 0]);
        points.push([
          world[0] * x + world[4] * y + world[8] * z + world[12],
          world[1] * x + world[5] * y + world[9] * z + world[13],
          world[2] * x + world[6] * y + world[10] * z + world[14],
        ]);
      }
    }
  }
  return points;
}

function detectWheels(document) {
  const wheels = [];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const bounds = getBounds(node);
    const size = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
    const [largest, middle, smallest] = [...size].sort((a, b) => b - a);
    if (!largest || !smallest) continue;
    const discLike = smallest / largest < 0.66 && Math.abs(largest - middle) / largest < 0.3;
    const wheelish = /wheel|tyre|tire|rim|pneu|rueda/i.test(`${node.getName()} ${mesh.getName()}`);
    if (!discLike && !wheelish) continue;
    wheels.push({
      name: node.getName() || mesh.getName() || '(unnamed)',
      node,
      center: [
        (bounds.max[0] + bounds.min[0]) / 2,
        (bounds.max[1] + bounds.min[1]) / 2,
        (bounds.max[2] + bounds.min[2]) / 2,
      ],
      radius: Math.max(largest, middle) / 2,
      width: smallest,
      axleAxis: size.indexOf(smallest),
      wheelish,
      discLike,
    });
  }
  return wheels.sort((a, b) => Number(b.wheelish) - Number(a.wheelish)).slice(0, 8);
}

function computePlacement(document, target, wheels) {
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const node of document.getRoot().listNodes()) {
    if (!node.getMesh()) continue;
    const box = getBounds(node);
    for (let axis = 0; axis < 3; axis += 1) {
      bounds.min[axis] = Math.min(bounds.min[axis], box.min[axis]);
      bounds.max[axis] = Math.max(bounds.max[axis], box.max[axis]);
    }
  }
  const size = [0, 1, 2].map((axis) => bounds.max[axis] - bounds.min[axis]);
  const longAxis = size[0] >= size[2] ? 0 : 2;
  const length = size[longAxis] || 1;
  const scale = target.targetLengthMeters / length;

  // Front direction: trust head/front node naming first, otherwise assume -Z.
  const frontPattern = /head.?light|front.?light|front.?bumper|faros|hood|_fl|front/i;
  const rearPattern = /tail.?light|rear.?light|brake.?light|exhaust|_rl|rear|diff/i;
  let frontScore = 0;
  let rearScore = 0;
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const label = `${node.getName()} ${mesh.getName()}`;
    const box = getBounds(node);
    const center = [0, 1, 2].map((axis) => (box.min[axis] + box.max[axis]) / 2);
    const relative = center[longAxis] - (bounds.min[longAxis] + bounds.max[longAxis]) / 2;
    const sign = relative >= 0 ? 1 : -1;
    if (frontPattern.test(label)) frontScore += sign;
    else if (rearPattern.test(label)) rearScore += sign;
  }
  const frontSign = frontScore - rearScore >= 0 ? 1 : -1;

  const candidates = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  const frontDir = [0, 0, 0];
  frontDir[longAxis] = frontSign;
  const rotated = ([x, z], yaw) => [x * Math.cos(yaw) + z * Math.sin(yaw), -x * Math.sin(yaw) + z * Math.cos(yaw)];
  let yaw = 0;
  let best = -Infinity;
  for (const candidate of candidates) {
    const [x, z] = rotated([frontDir[0], frontDir[2]], candidate);
    const score = -z; // want the front to land on -Z
    if (score > best) {
      best = score;
      yaw = candidate;
    }
  }

  const pivotX = bounds.min[0] + size[0] / 2;
  const pivotZ = bounds.min[2] + size[2] / 2;
  const pivotY = wheels.length
    ? Math.min(...wheels.map((wheel) => wheel.center[1] - wheel.radius))
    : bounds.min[1];

  const toNormalized = (point) => {
    const [rx, rz] = rotated([point[0] - pivotX, point[2] - pivotZ], yaw);
    return [rx * scale, (point[1] - pivotY) * scale, rz * scale];
  };

  return {
    yaw,
    scale,
    pivot: [pivotX, pivotY, pivotZ],
    toNormalized,
    sourceBounds: bounds,
    sourceSize: size,
    longAxis: ['x', 'y', 'z'][longAxis],
    frontConfidence: frontScore !== 0 || rearScore !== 0 ? 'naming' : 'default',
  };
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
    const buffer = Buffer.from(image);
    try {
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

async function optimizeOnce(target, attempt) {
  const io = await getNodeIO();
  const document = await io.read(path.join(RAW_DIR, target.source));
  await document.transform(dedup(), weld());

  const strip = stripBrandAssets(document, target);
  const textureSize = Math.max(512, Math.round(target.textureSize * attempt.textureScale));
  const quality = Math.max(45, target.textureQuality + attempt.qualityDelta);
  const textureStats = await compressTextures(document, { textureSize, quality });

  const trianglesBefore = (() => {
    let total = 0;
    for (const mesh of document.getRoot().listMeshes()) {
      for (const primitive of mesh.listPrimitives()) {
        const indices = primitive.getIndices();
        total += indices ? indices.getCount() / 3 : (primitive.getAttribute('POSITION')?.getCount() ?? 0) / 3;
      }
    }
    return Math.round(total);
  })();

  let trianglesAfter = trianglesBefore;
  const triangleBudget = Math.round(target.maxTriangles * attempt.ratioScale);
  if (trianglesBefore > triangleBudget) {
    for (let round = 0; round < 3 && trianglesAfter > triangleBudget; round += 1) {
      const ratio = Math.max(0.02, Math.min(1, triangleBudget / trianglesAfter));
      await document.transform(
        simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.0016, lockBorder: false }),
      );
      let total = 0;
      for (const mesh of document.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
          const indices = primitive.getIndices();
          total += indices ? indices.getCount() / 3 : (primitive.getAttribute('POSITION')?.getCount() ?? 0) / 3;
        }
      }
      const next = Math.round(total);
      if (next >= trianglesAfter) break;
      trianglesAfter = next;
    }
  }

  await document.transform(prune());
  if (target.kind === 'track') {
    // Instanced foliage keeps draw calls low on mobile.
    try {
      const { instance } = await import('@gltf-transform/functions');
      await document.transform(instance({ min: 2 }));
    } catch (error) {
      console.warn('[optimize] instancing skipped:', error.message);
    }
  }
  document.createExtension(EXTMeshoptCompression).setRequired(true).setEncoder(MeshoptEncoder);
  await document.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));

  return { document, strip, textureStats, trianglesBefore, trianglesAfter, textureSize, quality };
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
    console.log(
      `[optimize] ${id} attempt ${attemptIndex + 1}: ${formatBytes(bytes)} (limit ${formatBytes(target.maxBytes)}), ` +
        `tris ${result.trianglesAfter.toLocaleString()} (limit ${target.maxTriangles.toLocaleString()}), ` +
        `textures ${formatBytes(result.textureStats.after)} @${result.textureSize}px q${result.quality}`,
    );
    if (!best || bytes < best.bytes) best = { ...result, bytes, attemptIndex };
    if (withinSize && withinTriangles) break;
    await result.document.dispose();
  }

  const { document, strip, textureStats, trianglesBefore, trianglesAfter, textureSize, quality, bytes, attemptIndex } = best;
  const placement = computePlacement(document, target, detectWheels(document));

  // Manifest (loaded by the game; describes the normalized model space).
  const wheels = detectWheels(document).map((wheel) => {
    const position = placement.toNormalized(wheel.center);
    return {
      name: wheel.name,
      position: position.map((value) => Number(value.toFixed(3))),
      radius: Number((wheel.radius * placement.scale).toFixed(3)),
      width: Number((wheel.width * placement.scale).toFixed(3)),
      axleAxis: ['x', 'y', 'z'][wheel.axleAxis],
      source: wheel.wheelish ? 'name' : 'shape',
    };
  });
  const frontWheels = wheels.filter((wheel) => wheel.position[2] < 0);
  const rearWheels = wheels.filter((wheel) => wheel.position[2] >= 0);
  const average = (list, axis) => (list.length ? list.reduce((sum, item) => sum + item.position[axis], 0) / list.length : null);
  const wheelbase = frontWheels.length && rearWheels.length ? (average(rearWheels, 2) - average(frontWheels, 2)) : null;
  const track = wheels.length >= 2
    ? Math.max(...wheels.map((wheel) => wheel.position[0])) - Math.min(...wheels.map((wheel) => wheel.position[0]))
    : null;

  const vertices = collectWorldVertices(document);
  const normalizedVertices = vertices.map(placement.toNormalized);
  const bounds = {
    min: [0, 1, 2].map((axis) => Number(Math.min(...normalizedVertices.map((point) => point[axis])).toFixed(3))),
    max: [0, 1, 2].map((axis) => Number(Math.max(...normalizedVertices.map((point) => point[axis])).toFixed(3))),
  };
  const materialSummary = document.getRoot().listMaterials().map((material) => ({
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
  }));

  const io = await getNodeIO();
  await io.write(outputPath, document);

  const manifestPath = target.manifest;
  await ensureDir(manifestPath);
  const manifest = {
    id,
    kind: target.kind,
    generatedAt: new Date().toISOString(),
    credits: CREDITS[id],
    units: 'meters',
    source: {
      file: `assets/raw/${target.source}`,
      triangles: trianglesBefore,
    },
    output: {
      file: outputPath,
      bytes,
      triangles: trianglesAfter,
      attempts: attemptIndex + 1,
      textureSizePx: textureSize,
      textureQuality: quality,
      textureBytesBefore: textureStats.before,
      textureBytesAfter: textureStats.after,
    },
    transform: {
      // Apply as: rotation.y = yaw, scale, position = -pivot * scale (rotated).
      yawDegrees: Number(((placement.yaw * 180) / Math.PI).toFixed(3)),
      yawRadians: Number(placement.yaw.toFixed(6)),
      scale: Number(placement.scale.toFixed(6)),
      pivot: placement.pivot.map((value) => Number(value.toFixed(3))),
      frontConfidence: placement.frontConfidence,
      sourceBounds: placement.sourceBounds,
      sourceSize: placement.sourceSize,
      longAxis: placement.longAxis,
    },
    bounds,
    size: [0, 1, 2].map((axis) => Number((bounds.max[axis] - bounds.min[axis]).toFixed(3))),
    wheels: {
      detected: wheels.length >= 4,
      wheelbase: wheelbase === null ? null : Number(wheelbase.toFixed(3)),
      track: track === null ? null : Number(track.toFixed(3)),
      radius: wheels.length ? Number((wheels.reduce((sum, wheel) => sum + wheel.radius, 0) / wheels.length).toFixed(3)) : null,
      list: wheels,
    },
    strip,
    materials: materialSummary,
    stats: {
      nodes: document.getRoot().listNodes().length,
      meshes: document.getRoot().listMeshes().length,
      materials: document.getRoot().listMaterials().length,
      textures: document.getRoot().listTextures().length,
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await document.dispose();

  const verify = await stat(outputPath);
  console.log(
    `[optimize] ${id} -> ${outputPath} ${formatBytes(verify.size)} | ${trianglesAfter.toLocaleString()} tris | ` +
      `wheels: ${manifest.wheels.detected ? 'detected' : 'NOT detected'} (wheelbase ${manifest.wheels.wheelbase}) | ` +
      `front: ${manifest.transform.frontConfidence} yaw=${manifest.transform.yawDegrees}°`,
  );
  return manifest;
}

async function main() {
  await mkdir('assets/reports', { recursive: true });
  const manifests = [];
  for (const [id, target] of Object.entries(ASSET_TARGETS)) {
    if (only && id !== only) continue;
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
  await writeFile('assets/reports/optimized-manifests.json', `${JSON.stringify(manifests, null, 2)}\n`);
  console.log(`[optimize] done: ${manifests.length} assets`);
}

main().catch((error) => {
  console.error('[optimize] FATAL:', error);
  process.exitCode = 1;
});
