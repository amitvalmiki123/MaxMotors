#!/usr/bin/env node
/**
 * Source-asset inspector.
 *
 * Produces small, reviewable reports so the shipped GLBs can be verified before
 * they are committed:
 *   assets/reports/<id>.report.json  structured stats, node tree, wheel candidates
 *   assets/reports/<id>.tree.txt     indented node hierarchy with world bounds
 *   assets/reports/<id>.side.png     CPU-rasterized side silhouette (+wheel markers)
 *   assets/reports/<id>.top.png      CPU-rasterized top silhouette (+wheel markers)
 *   assets/reports/<id>.textures.png contact sheet of every embedded texture
 *   assets/reports/<id>.map.txt|png  tracks: material/height occupancy grid
 *   assets/reports/SUMMARY.md        everything above in one page
 *
 * Usage: node scripts/assets/inspect-glb.mjs [--out assets/reports]
 */
import { isWheelName } from '../../src/game/cars/names.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getBounds } from '@gltf-transform/core';
import sharp from 'sharp';
import { ASSET_TARGETS, RAW_DIR, REPORT_DIR } from './config.mjs';
import { buildTerrainGrid, classifyMaterial, collectTriangles, extractRoadPath, writeOccupancyArtifacts } from './terrain.mjs';
import { clusterWheels, descriptorFromBounds } from '../../src/game/cars/wheel-clusters.js';
import { ensureDir, formatBytes, getNodeIO } from './gltf-io.mjs';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const OUTPUT_DIR = outIndex === -1 ? REPORT_DIR : args[outIndex + 1];

function boundsOf(node) {
  const box = getBounds(node);
  return {
    min: [box.min[0], box.min[1], box.min[2]],
    max: [box.max[0], box.max[1], box.max[2]],
    center: [0, 1, 2].map((axis) => (box.min[axis] + box.max[axis]) / 2),
    size: [0, 1, 2].map((axis) => box.max[axis] - box.min[axis]),
  };
}

function meshTriangles(mesh) {
  if (!mesh) return 0;
  let total = 0;
  for (const primitive of mesh.listPrimitives()) {
    const indices = primitive.getIndices();
    total += (indices ? indices.getCount() : primitive.getAttribute('POSITION')?.getCount() ?? 0) / 3;
  }
  return Math.round(total);
}

/** Flattens nodes and collects wheel candidates in one pass. */
function walkScene(document) {
  const nodes = [];
  const candidates = [];
  const treeLines = [];
  let nextId = 0;

  const walk = (node, depth, ancestors, parentPath, siblingIndex = 0) => {
    const id = nextId++;
    const name = node.getName() || '(unnamed)';
    const mesh = node.getMesh();
    const box = boundsOf(node);
    const nodePath = `${parentPath}/${name}#${siblingIndex}`;
    const label = `${name} ${mesh?.getName() ?? ''}`;
    let triangles = 0;
    const materialNames = [];
    if (mesh) {
      triangles = meshTriangles(mesh);
      for (const primitive of mesh.listPrimitives()) {
        const material = primitive.getMaterial();
        if (material && !materialNames.includes(material.getName())) materialNames.push(material.getName());
      }
      candidates.push(descriptorFromBounds({
        id: nodePath,
        name,
        min: box.min,
        max: box.max,
        // Node name only: mesh names can carry reusable material names.
        wheelish: isWheelName(name),
        ancestorIds: ancestors,
      }));
    }
    nodes.push({
      path: nodePath,
      name,
      mesh: mesh?.getName() ?? null,
      triangles,
      center: box.center.map((value) => Number(value.toFixed(3))),
      size: box.size.map((value) => Number(value.toFixed(3))),
      min: box.min.map((value) => Number(value.toFixed(3))),
      max: box.max.map((value) => Number(value.toFixed(3))),
      materialNames,
      childCount: node.listChildren().length,
    });
    treeLines.push(
      `${'  '.repeat(depth)}- ${name}${mesh ? ` [mesh: ${mesh.getName() || '(unnamed)'}, tris: ${triangles}]` : ''}` +
        ` size=(${box.size.map((value) => value.toFixed(2)).join(', ')})` +
        ` center=(${box.center.map((value) => value.toFixed(2)).join(', ')})`,
    );
    const counters = new Map();
    for (const child of node.listChildren()) {
      const childName = child.getName() || child.getMesh()?.getName() || '(unnamed)';
      const occurrence = counters.get(childName) ?? 0;
      counters.set(childName, occurrence + 1);
      walk(child, depth + 1, [...ancestors, nodePath], nodePath, occurrence);
    }
  };

  for (const scene of document.getRoot().listScenes()) {
    const counters = new Map();
    for (const node of scene.listChildren()) {
      const name = node.getName() || node.getMesh()?.getName() || '(unnamed)';
      const occurrence = counters.get(name) ?? 0;
      counters.set(name, occurrence + 1);
      walk(node, 0, [], '', occurrence);
    }
  }
  return { nodes, candidates, treeLines };
}

function rasterizeSilhouette(points, markers, project, filePath) {
  const projected = points.map(project);
  if (!projected.length) return Promise.resolve(null);
  // Explicit loops: a photogrammetry scene has far more points than a spread
  // call can pass as arguments.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of projected) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const width = 360;
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const height = Math.max(60, Math.round((spanY / spanX) * width));
  const buffer = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < buffer.length; offset += 4) {
    buffer[offset] = 10;
    buffer[offset + 1] = 14;
    buffer[offset + 2] = 18;
    buffer[offset + 3] = 255;
  }
  const put = (x, y, color, size = 1) => {
    const px = Math.round(((x - minX) / spanX) * (width - 1));
    const py = height - 1 - Math.round(((y - minY) / spanY) * (height - 1));
    for (let dy = -size + 1; dy < size; dy += 1) {
      for (let dx = -size + 1; dx < size; dx += 1) {
        const tx = px + dx;
        const ty = py + dy;
        if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
        const offset = (ty * width + tx) * 4;
        buffer[offset] = color[0];
        buffer[offset + 1] = color[1];
        buffer[offset + 2] = color[2];
      }
    }
  };
  for (const point of projected) put(point[0], point[1], [150, 168, 172]);
  for (const marker of markers) {
    const [x, y] = project(marker.center);
    put(x, y, marker.color, marker.size ?? 3);
  }
  return sharp(buffer, { raw: { width, height, channels: 4 } }).png().toFile(filePath);
}

/** Contact sheet of every embedded texture, labelled with its index. */
async function writeTextureSheet(document, filePath, { tile = 256, columns = 5 } = {}) {
  const textures = document.getRoot().listTextures();
  const tiles = [];
  for (const [index, texture] of textures.entries()) {
    const image = texture.getImage();
    if (!image) continue;
    try {
      const metadata = await sharp(Buffer.from(image)).metadata();
      const buffer = await sharp(Buffer.from(image))
        .resize(tile, tile, { fit: 'inside', background: { r: 16, g: 20, b: 22 } })
        .flatten({ background: { r: 16, g: 20, b: 22 } })
        .png()
        .toBuffer();
      const size = await sharp(buffer).metadata();
      tiles.push({
        index,
        name: texture.getName() || '(unnamed)',
        mimeType: texture.getMimeType(),
        bytes: image.byteLength,
        width: metadata.width,
        height: metadata.height,
        buffer,
        tileWidth: size.width,
        tileHeight: size.height,
      });
    } catch (error) {
      console.warn(`[inspect] texture ${index} could not be decoded: ${error.message}`);
    }
  }
  if (!tiles.length) return null;
  const rows = Math.ceil(tiles.length / columns);
  const composites = tiles.map((entry, position) => ({
    input: entry.buffer,
    left: (position % columns) * tile + Math.round((tile - entry.tileWidth) / 2),
    top: Math.floor(position / columns) * tile + Math.round((tile - entry.tileHeight) / 2),
  }));
  const labels = tiles
    .map((entry, position) => {
      const left = (position % columns) * tile + 6;
      const top = Math.floor(position / columns) * tile + 6;
      return `<rect x="${left - 4}" y="${top - 4}" width="${Math.max(28, String(entry.index).length * 12 + 16)}" height="24" fill="rgba(8,10,12,0.75)"/>`
        + `<text x="${left + 2}" y="${top + 14}" font-family="monospace" font-size="16" fill="#ffd9a0">#${entry.index}</text>`;
    })
    .join('');
  await sharp({
    create: { width: columns * tile, height: rows * tile, channels: 3, background: { r: 12, g: 16, b: 18 } },
  })
    .composite([...composites, { input: Buffer.from(`<svg width="${columns * tile}" height="${rows * tile}">${labels}</svg>`), top: 0, left: 0 }])
    .png()
    .toFile(filePath);

  return tiles.map(({ buffer, tileWidth, tileHeight, ...rest }) => rest);
}

async function inspectAsset(id, target) {
  const sourcePath = path.join(RAW_DIR, target.source);
  const io = await getNodeIO();
  const document = await io.read(sourcePath);

  for (const node of document.getRoot().listNodes().reverse()) {
    if (node.getMesh()) getBounds(node);
  }

  const { nodes, candidates, treeLines } = walkScene(document);
  const { triangles, materials } = collectTriangles(document, { kind: target.kind });
  const sceneBounds = (() => {
    const withMesh = nodes.filter((node) => node.mesh);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const node of withMesh) {
      for (let axis = 0; axis < 3; axis += 1) {
        if (Number.isFinite(node.min[axis])) min[axis] = Math.min(min[axis], node.min[axis]);
        if (Number.isFinite(node.max[axis])) max[axis] = Math.max(max[axis], node.max[axis]);
      }
    }
    for (let axis = 0; axis < 3; axis += 1) {
      if (!Number.isFinite(min[axis])) min[axis] = 0;
      if (!Number.isFinite(max[axis])) max[axis] = 0;
    }
    return { min, max, size: [0, 1, 2].map((axis) => max[axis] - min[axis]) };
  })();

  const wheels = clusterWheels(candidates, {
    modelWidth: sceneBounds.size[0],
    modelCenterX: (sceneBounds.min[0] + sceneBounds.max[0]) / 2,
    groundY: sceneBounds.min[1],
    height: sceneBounds.size[1],
    halfLength: sceneBounds.size[2] / 2,
    expectedRadius: Math.max(0.12, Math.max(sceneBounds.size[0], sceneBounds.size[2]) * 0.07),
  });

  const materialInfo = document.getRoot().listMaterials().map((material) => ({
    name: material.getName(),
    class: classifyMaterial(material, { kind: target.kind }),
    alphaMode: material.getAlphaMode(),
    doubleSided: material.getDoubleSided(),
    emissive: material.getEmissiveFactor().map((value) => Number(value.toFixed(3))),
    baseColor: material.getBaseColorFactor().map((value) => Number(value.toFixed(3))),
  }));

  const textures = await writeTextureSheet(document, path.join(OUTPUT_DIR, `${id}.textures.png`));

  const points = [];
  const MESH_POINT_BUDGET = 900;
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const world = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      if (!position) continue;
      const stride = Math.max(1, Math.floor(position.getCount() / MESH_POINT_BUDGET));
      for (let index = 0; index < position.getCount(); index += stride) {
        const [x, y, z] = position.getElement(index, [0, 0, 0]);
        points.push([
          world[0] * x + world[4] * y + world[8] * z + world[12],
          world[1] * x + world[5] * y + world[9] * z + world[13],
          world[2] * x + world[6] * y + world[10] * z + world[14],
        ]);
      }
    }
  }

  const markers = wheels.wheels.map((wheel, index) => ({
    center: wheel.center,
    color: index % 2 === 0 ? [230, 110, 70] : [110, 200, 230],
  }));

  await ensureDir(path.join(OUTPUT_DIR, 'x'));
  const longAxis = sceneBounds.size[0] >= sceneBounds.size[2] ? 0 : 2;
  await rasterizeSilhouette(points, markers, ([x, y, z]) => (longAxis === 0 ? [x, y] : [z, y]), path.join(OUTPUT_DIR, `${id}.side.png`));
  await rasterizeSilhouette(points, markers, ([x, y]) => [x, y], path.join(OUTPUT_DIR, `${id}.top.png`));

  const report = {
    id,
    source: sourcePath,
    kind: target.kind,
    generatedAt: new Date().toISOString(),
    stats: {
      nodes: nodes.length,
      meshes: document.getRoot().listMeshes().length,
      triangles: triangles.length,
      materials: materials.length,
      textures: document.getRoot().listTextures().length,
      textureBytes: document.getRoot().listTextures().reduce((sum, texture) => sum + (texture.getImage()?.byteLength ?? 0), 0),
      animations: document.getRoot().listAnimations().length,
      extensions: document.getRoot().listExtensionsUsed().map((extension) => extension.extensionName),
    },
    sceneBounds: {
      min: sceneBounds.min.map((value) => Number(value.toFixed(3))),
      max: sceneBounds.max.map((value) => Number(value.toFixed(3))),
      size: sceneBounds.size.map((value) => Number(value.toFixed(3))),
    },
    longAxis: ['x', 'y', 'z'][longAxis],
    // Copy before sorting: `triangles[].m` indexes the original array order.
    materials: [...materials].sort((a, b) => b.triangles - a.triangles).map((material) => ({
      ...material,
      detail: materialInfo.find((entry) => entry.name === material.name) ?? null,
    })),
    textures,
    wheelClusters: wheels,
    nodes: nodes.sort((a, b) => b.triangles - a.triangles).slice(0, 120),
  };

  if (target.kind === 'track') {
    const grid = buildTerrainGrid({ triangles, materials, bounds: sceneBounds, cellSize: 2 });
    const road = extractRoadPath(grid);
    await writeOccupancyArtifacts(grid, {
      asciiPath: path.join(OUTPUT_DIR, `${id}.map.txt`),
      pngPath: path.join(OUTPUT_DIR, `${id}.map.png`),
      label: id,
      path: road.path,
    });
    report.terrain = {
      cellSize: grid.cellSize,
      cols: grid.cols,
      rows: grid.rows,
      roadHalfWidth: Number(road.roadHalfWidth.toFixed(3)),
      roadCoverage: Number(road.coverage.toFixed(4)),
      roadPoints: road.path.filter(Boolean).length,
      pathPreview: road.path.filter(Boolean).slice(0, 20).map((point) => point.map((value) => Number(value.toFixed(2)))),
    };
  }

  await writeFile(path.join(OUTPUT_DIR, `${id}.tree.txt`), `${treeLines.join('\n')}\n`);
  await writeFile(path.join(OUTPUT_DIR, `${id}.report.json`), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const reports = [];
  for (const [id, target] of Object.entries(ASSET_TARGETS)) {
    try {
      const report = await inspectAsset(id, target);
      reports.push(report);
      console.log(
        `[inspect] ${id}: tris=${report.stats.triangles.toLocaleString()} nodes=${report.stats.nodes} ` +
          `materials=${report.stats.materials} textures=${report.stats.textures} (${formatBytes(report.stats.textureBytes)}) ` +
          `bounds=${report.sceneBounds.size.join(' x ')}`,
      );
      console.log(`          wheel clusters: ${report.wheelClusters.wheels.map((wheel) => `${wheel.corner}@${wheel.center.map((value) => value.toFixed(2)).join('/')} r=${wheel.radius.toFixed(2)}`).join(' | ') || 'none'}`);
      if (report.terrain) {
        console.log(`          terrain: ${report.terrain.cols}x${report.terrain.rows} @ ${report.terrain.cellSize.toFixed(2)}m, road half-width ${report.terrain.roadHalfWidth} m, coverage ${(report.terrain.roadCoverage * 100).toFixed(2)}%`);
      }
    } catch (error) {
      console.error(`[inspect] ${id} FAILED: ${error.stack ?? error.message}`);
      process.exitCode = 1;
    }
  }

  const lines = ['# Source asset inspection', '', `Generated ${new Date().toISOString()}`, ''];
  for (const report of reports) {
    lines.push(`## ${report.id}`, '');
    lines.push(`- source: \`${report.source}\``);
    lines.push(`- triangles: **${report.stats.triangles.toLocaleString()}**`);
    lines.push(`- nodes/meshes/materials: ${report.stats.nodes} / ${report.stats.meshes} / ${report.stats.materials}`);
    lines.push(`- textures: ${report.stats.textures} (${formatBytes(report.stats.textureBytes)})`);
    lines.push(`- bounds: ${report.sceneBounds.size.join(' x ')} @ min ${report.sceneBounds.min.join(', ')} (long axis ${report.longAxis})`);
    lines.push(`- wheels: ${report.wheelClusters.wheels.map((wheel) => `${wheel.corner} r=${wheel.radius.toFixed(2)} @ ${wheel.center.map((value) => value.toFixed(2)).join('/')} (${wheel.memberNames.length} members, ${wheel.source})`).join('; ') || 'none detected'}`);
    if (report.wheelClusters.wheels.length) {
      lines.push(`- wheelbase ${report.wheelClusters.wheelbase} m, track ${report.wheelClusters.track} m`);
    }
    if (report.terrain) {
      lines.push(`- terrain grid: ${report.terrain.cols}x${report.terrain.rows} @ ${report.terrain.cellSize.toFixed(2)} m, road half-width ${report.terrain.roadHalfWidth} m, coverage ${(report.terrain.roadCoverage * 100).toFixed(2)}%, ${report.terrain.roadPoints} centreline points`);
    }
    lines.push(`- materials: ${report.materials.slice(0, 12).map((material) => `${material.name}[${material.class}${material.detail?.alphaMode === 'BLEND' ? ',blend' : ''}]`).join(', ')}`);
    lines.push('');
  }
  await writeFile(path.join(OUTPUT_DIR, 'SUMMARY.md'), `${lines.join('\n')}\n`);
  console.log(`[inspect] reports written to ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error('[inspect] FATAL:', error);
  process.exitCode = 1;
});
