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
 *   assets/reports/<id>.map.txt      occupancy grid (tracks: height + material per cell)
 *   assets/reports/<id>.map.png      colorized occupancy grid
 *   assets/reports/SUMMARY.md        everything above in one page
 *
 * Usage: node scripts/assets/inspect-glb.mjs [--out assets/reports]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getBounds } from '@gltf-transform/core';
import sharp from 'sharp';
import { ASSET_TARGETS, RAW_DIR, REPORT_DIR } from './config.mjs';
import { countTextureBytes, ensureDir, formatBytes, getNodeIO, listTextureInfo } from './gltf-io.mjs';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const OUTPUT_DIR = outIndex === -1 ? REPORT_DIR : args[outIndex + 1];

const UP = [0, 1, 0];
const HORIZONTAL_AXES = { x: 0, y: 1, z: 2 };

function classify(material) {
  const name = (material?.getName?.() ?? '').toLowerCase();
  const alpha = material?.getAlphaMode?.() ?? 'OPAQUE';
  let cls = 'body';
  if (/wheel|tyre|tire|rim|pneu|rims/.test(name)) cls = 'wheel';
  else if (/glass|window|wind|transparent|screen/.test(name) || alpha === 'BLEND') cls = 'glass';
  else if (/light|lamp|led|beam|emissive/.test(name)) cls = 'light';
  else if (/interior|seat|cabin|dash|steer/.test(name)) cls = 'interior';
  else if (/body|paint|shell|exterior|car/.test(name)) cls = 'body';
  else if (/chrome|metal|trim|grill|bumper|door|hood/.test(name)) cls = 'trim';
  else if (/badge|logo|emblem|decal|plate/.test(name)) cls = 'badge';
  else if (/road|dirt|path|ground|terrain|soil|mud|gravel|sand|grass|grassland|forest|leaf|tree|trunk|rock/.test(name)) cls = 'terrain';
  else if (alpha === 'MASK') cls = 'cutout';
  return cls;
}

function transformPoint(matrix, point) {
  const [x, y, z] = point;
  const m = matrix;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Flattens world-space triangle soup, bucketed on a coarse XZ grid for fast vertical ray queries. */
function collectTriangles(document) {
  const triangles = [];
  const materials = [];
  const materialIndex = new Map();

  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const world = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      if (!position) continue;
      const material = primitive.getMaterial();
      const materialName = material?.getName?.() ?? '(none)';
      if (!materialIndex.has(materialName)) {
        materialIndex.set(materialName, materials.length);
        materials.push({ name: materialName, class: classify(material), triangles: 0, primitives: 0 });
      }
      const entry = materials[materialIndex.get(materialName)];
      entry.primitives += 1;

      const indices = primitive.getIndices();
      const count = indices ? indices.getCount() : position.getCount();
      const read = (index) => {
        const array = position.getElement(index, [0, 0, 0]);
        return transformPoint(world, array);
      };
      for (let i = 0; i + 2 < count; i += 3) {
        const ia = indices ? indices.getScalar(i) : i;
        const ib = indices ? indices.getScalar(i + 1) : i + 1;
        const ic = indices ? indices.getScalar(i + 2) : i + 2;
        triangles.push({ a: read(ia), b: read(ib), c: read(ic), m: materialIndex.get(materialName) });
        entry.triangles += 1;
      }
    }
  }

  return { triangles, materials };
}

function gridToPng(rows, palette, filePath) {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const buffer = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const code = rows[y][x];
      const color = palette[code] ?? [12, 16, 18];
      const offset = (y * width + x) * 4;
      buffer[offset] = color[0];
      buffer[offset + 1] = color[1];
      buffer[offset + 2] = color[2];
      buffer[offset + 3] = 255;
    }
  }
  return sharp(buffer, { raw: { width, height, channels: 4 } }).png().toFile(filePath);
}

function rasterizeSilhouette(points, markers, project, filePath, { scale = 1 } = {}) {
  const projected = points.map(project);
  if (!projected.length) return Promise.resolve();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of projected) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const width = 360;
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const height = Math.max(60, Math.round((spanY / spanX) * width));
  const buffer = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buffer.length; i += 4) {
    buffer[i] = 10;
    buffer[i + 1] = 14;
    buffer[i + 2] = 18;
    buffer[i + 3] = 255;
  }
  const toPixel = (x, y) => {
    const px = Math.round(((x - minX) / spanX) * (width - 1));
    const py = Math.round(((y - minY) / spanY) * (height - 1));
    return [px, height - 1 - py];
  };
  const put = ([px, py], color, size = 1) => {
    for (let dy = -size + 1; dy < size; dy += 1) {
      for (let dx = -size + 1; dx < size; dx += 1) {
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const offset = (y * width + x) * 4;
        buffer[offset] = color[0];
        buffer[offset + 1] = color[1];
        buffer[offset + 2] = color[2];
        buffer[offset + 3] = 255;
      }
    }
  };
  for (const point of projected) put(toPixel(point[0], point[1]), [150, 168, 172]);
  for (const marker of markers) {
    const [x, y] = project(marker.center);
    put(toPixel(x, y), marker.color, marker.size ?? 2);
  }
  return sharp(buffer, { raw: { width, height, channels: 4 } }).png().toFile(filePath);
}

function analyzeWheels(nodes) {
  const candidates = [];
  for (const node of nodes) {
    if (!node.mesh) continue;
    const size = node.size;
    const sorted = [...size].sort((a, b) => b - a);
    const [largest, middle, smallest] = sorted;
    if (!largest) continue;
    const discLike = smallest / largest < 0.66 && Math.abs(largest - middle) / largest < 0.3;
    const wheelish = /wheel|tyre|tire|rim|pneu|rueda|rad|felge/i.test(node.name) || /wheel|tyre|tire|rim/i.test(node.mesh);
    if (!discLike && !wheelish) continue;
    const axleAxis = size.indexOf(smallest);
    candidates.push({
      name: node.name,
      mesh: node.mesh,
      triangles: node.triangles,
      center: node.center,
      size: [Number(size[0].toFixed(3)), Number(size[1].toFixed(3)), Number(size[2].toFixed(3))],
      axleAxis: ['x', 'y', 'z'][axleAxis],
      radiusEstimate: Number((Math.max(largest, middle) / 2).toFixed(3)),
      widthEstimate: Number(smallest.toFixed(3)),
      discLike,
      wheelish,
      score: Number(((wheelish ? 2 : 0) + (discLike ? 1 : 0) + (axleAxis === 0 ? 0.5 : 0)).toFixed(2)),
    });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 40);
}

function analyzeFrontSignals(nodes, materials) {
  const signals = [];
  const pattern = (tags) => new RegExp(tags.join('|'), 'i');
  const front = pattern(['head.?light', 'headlamp', 'front.?light', 'faros', 'front.?grill', 'front.?bumper', 'hood', '_fl', 'wheel_fl', 'front']);
  const rear = pattern(['tail.?light', 'rear.?light', 'back.?light', 'brake.?light', 'exhaust', 'rear.?bumper', 'spoiler', 'diff', 'trunk', '_rl', 'rear']);

  for (const node of nodes) {
    const label = `${node.name} ${node.mesh ?? ''} ${node.materialNames.join(' ')}`;
    if (front.test(label)) signals.push({ node: node.name, kind: 'front', center: node.center });
    else if (rear.test(label)) signals.push({ node: node.name, kind: 'rear', center: node.center });
  }
  for (const material of materials) {
    if (front.test(material.name)) signals.push({ material: material.name, kind: 'front' });
    else if (rear.test(material.name)) signals.push({ material: material.name, kind: 'rear' });
  }
  return signals.slice(0, 60);
}

async function buildOccupancyMap(triangles, materials, bounds, { cellSize = 2.5 } = {}) {
  const min = bounds.min;
  const max = bounds.max;
  const extentX = max[0] - min[0];
  const extentZ = max[2] - min[2];
  const cells = Math.max(24, Math.min(180, Math.ceil(Math.max(extentX, extentZ) / cellSize)));
  const stepX = extentX / cells;
  const stepZ = extentZ / cells;

  const buckets = new Map();
  const key = (ix, iz) => `${ix}:${iz}`;
  for (let i = 0; i < triangles.length; i += 1) {
    const tri = triangles[i];
    const x0 = Math.min(tri.a[0], tri.b[0], tri.c[0]);
    const x1 = Math.max(tri.a[0], tri.b[0], tri.c[0]);
    const z0 = Math.min(tri.a[2], tri.b[2], tri.c[2]);
    const z1 = Math.max(tri.a[2], tri.b[2], tri.c[2]);
    const ix0 = Math.max(0, Math.floor((x0 - min[0]) / stepX));
    const ix1 = Math.min(cells - 1, Math.floor((x1 - min[0]) / stepX));
    const iz0 = Math.max(0, Math.floor((z0 - min[2]) / stepZ));
    const iz1 = Math.min(cells - 1, Math.floor((z1 - min[2]) / stepZ));
    if ((ix1 - ix0 + 1) * (iz1 - iz0 + 1) > 900) {
      // Enormous (usually a backdrop plane): index by centroid only.
      buckets.set(key(Math.floor((x0 + x1) / 2 - min[0]) / stepX | 0, 0), buckets.get('') ?? []);
    }
    for (let ix = ix0; ix <= ix1; ix += 1) {
      for (let iz = iz0; iz <= iz1; iz += 1) {
        const bucket = buckets.get(key(ix, iz));
        if (bucket) bucket.push(i);
        else buckets.set(key(ix, iz), [i]);
      }
    }
  }

  const heightGrid = [];
  const materialGrid = [];
  const heightStats = [];
  for (let iz = 0; iz < cells; iz += 1) {
    const heightRow = [];
    const materialRow = [];
    for (let ix = 0; ix < cells; ix += 1) {
      const x = min[0] + (ix + 0.5) * stepX;
      const z = min[2] + (iz + 0.5) * stepZ;
      const bucket = buckets.get(key(ix, iz));
      let bestY = -Infinity;
      let bestMaterial = -1;
      if (bucket) {
        for (const index of bucket) {
          const tri = triangles[index];
          const { a, b, c } = tri;
          const v0x = b[0] - a[0];
          const v0z = b[2] - a[2];
          const v1x = c[0] - a[0];
          const v1z = c[2] - a[2];
          const det = v0x * v1z - v1x * v0z;
          if (Math.abs(det) < 1e-12) continue;
          const px = x - a[0];
          const pz = z - a[2];
          const u = (px * v1z - v1x * pz) / det;
          const v = (v0x * pz - px * v0z) / det;
          if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
          const y = a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]);
          if (y > bestY) {
            bestY = y;
            bestMaterial = tri.m;
          }
        }
      }
      heightRow.push(Number.isFinite(bestY) ? Number(bestY.toFixed(2)) : null);
      materialRow.push(bestMaterial);
      if (Number.isFinite(bestY)) heightStats.push(bestY);
    }
    heightGrid.push(heightRow);
    materialGrid.push(materialRow);
  }

  // ASCII map + palette, ordered by how often each material wins a cell.
  const usage = new Map();
  for (const row of materialGrid) for (const value of row) usage.set(value, (usage.get(value) ?? 0) + 1);
  const ordered = [...usage.entries()]
    .filter(([value]) => value >= 0)
    .sort((a, b) => b[1] - a[1])
    .map(([value]) => value);
  const glyphs = '#*+oxABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@%&=?!';
  const legend = new Map();
  ordered.forEach((value, index) => legend.set(value, glyphs[index] ?? '.'));

  const asciiRows = materialGrid.map((row) => row.map((value) => (value < 0 ? ' ' : legend.get(value))).join(''));
  const palette = [];
  const colors = [
    [196, 140, 84], [92, 138, 74], [86, 96, 104], [128, 190, 220], [180, 96, 88],
    [214, 200, 120], [140, 110, 190], [90, 200, 150], [220, 220, 220], [120, 120, 200],
  ];
  for (let i = 0; i < 256; i += 1) {
    const value = ordered[i];
    if (value === undefined) {
      palette[i] = [14, 18, 20];
      continue;
    }
    palette[i] = colors[i % colors.length];
  }
  const codedRows = materialGrid.map((row) => row.map((value) => {
    const index = ordered.indexOf(value);
    return index === -1 ? 0 : index;
  }));

  return {
    cellSize: Number(Math.max(stepX, stepZ).toFixed(2)),
    cells,
    min: [Number(min[0].toFixed(2)), Number(min[2].toFixed(2))],
    max: [Number(max[0].toFixed(2)), Number(max[2].toFixed(2))],
    legend: ordered.map((value, index) => ({
      glyph: glyphs[index] ?? '.',
      material: materials[value]?.name ?? '(none)',
      class: materials[value]?.class ?? 'unknown',
      cells: usage.get(value) ?? 0,
      triangles: materials[value]?.triangles ?? 0,
    })),
    ascii: asciiRows.join('\n'),
    heightGrid,
    codedRows,
    palette,
    heightRange: heightStats.length
      ? [Number(Math.min(...heightStats).toFixed(2)), Number(Math.max(...heightStats).toFixed(2))]
      : null,
  };
}

function samplePoints(document, limit = 240_000) {
  const points = [];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const world = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      if (!position) continue;
      const count = position.getCount();
      const stride = Math.max(1, Math.floor(count / (limit / 64)));
      for (let i = 0; i < count; i += stride) {
        points.push(transformPoint(world, position.getElement(i, [0, 0, 0])));
      }
    }
  }
  return points;
}

async function inspectAsset(id, target) {
  const sourcePath = path.join(RAW_DIR, target.source);
  const io = await getNodeIO();
  const document = await io.read(sourcePath);

  // Recompute world bounds bottom-up so nested nodes report correct extents.
  for (const node of document.getRoot().listNodes().reverse()) {
    if (node.getMesh()) getBounds(node);
  }

  const nodes = [];
  const walk = (node, depth, parentPath) => {
    const name = node.getName() || '(unnamed)';
    const mesh = node.getMesh();
    const bounds = getBounds(node);
    const size = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
    const center = [
      (bounds.max[0] + bounds.min[0]) / 2,
      (bounds.max[1] + bounds.min[1]) / 2,
      (bounds.max[2] + bounds.min[2]) / 2,
    ];
    let triangles = 0;
    const materialNames = [];
    if (mesh) {
      for (const primitive of mesh.listPrimitives()) {
        const indices = primitive.getIndices();
        const position = primitive.getAttribute('POSITION');
        triangles += indices ? indices.getCount() / 3 : (position?.getCount() ?? 0) / 3;
        const material = primitive.getMaterial();
        if (material && !materialNames.includes(material.getName())) materialNames.push(material.getName());
      }
    }
    const entry = {
      path: `${parentPath}/${name}`,
      depth,
      name,
      mesh: mesh?.getName() ?? null,
      triangles: Math.round(triangles),
      center: center.map((value) => Number(value.toFixed(3))),
      size: size.map((value) => Number(value.toFixed(3))),
      min: bounds.min.map((value) => Number(value.toFixed(3))),
      max: bounds.max.map((value) => Number(value.toFixed(3))),
      materialNames,
      children: node.listChildren().length,
      hasTransform: Boolean(node.getMatrix() || node.getTranslation().some((v, i) => v !== [0, 0, 0][i]) || node.getRotation().some((v, i) => v !== [0, 0, 0, 1][i]) || node.getScale().some((v) => v !== 1)),
    };
    nodes.push(entry);
    for (const child of node.listChildren()) walk(child, depth + 1, entry.path);
  };

  for (const scene of document.getRoot().listScenes()) {
    for (const node of scene.listChildren()) walk(node, 0, '');
  }

  const sceneBounds = (() => {
    const boxes = nodes.map((node) => node);
    if (!boxes.length) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const box of boxes) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], box.min[axis]);
        max[axis] = Math.max(max[axis], box.max[axis]);
      }
    }
    return {
      min: min.map((value) => Number(value.toFixed(3))),
      max: max.map((value) => Number(value.toFixed(3))),
      size: [0, 1, 2].map((axis) => Number((max[axis] - min[axis]).toFixed(3))),
    };
  })();

  const { triangles, materials } = collectTriangles(document);
  const wheelCandidates = analyzeWheels(nodes);
  const frontSignals = analyzeFrontSignals(nodes, materials);
  const textures = listTextureInfo(document);

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
      textures: textures.length,
      textureBytes: countTextureBytes(document),
      animations: document.getRoot().listAnimations().length,
      skins: document.getRoot().listSkins().length,
      extensions: document.getRoot().listExtensionsUsed().map((extension) => extension.extensionName),
    },
    sceneBounds,
    materials: materials.sort((a, b) => b.triangles - a.triangles),
    textures,
    wheelCandidates,
    frontSignals,
    nodes: nodes.sort((a, b) => b.triangles - a.triangles).slice(0, 250),
  };

  const treeLines = [];
  const walkTree = (node, depth) => {
    const name = node.getName() || '(unnamed)';
    const mesh = node.getMesh();
    const bounds = getBounds(node);
    const size = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
    let triangles = 0;
    if (mesh) {
      for (const primitive of mesh.listPrimitives()) {
        const indices = primitive.getIndices();
        triangles += indices ? indices.getCount() / 3 : (primitive.getAttribute('POSITION')?.getCount() ?? 0) / 3;
      }
    }
    treeLines.push(
      `${'  '.repeat(depth)}- ${name}${mesh ? ` [mesh: ${mesh.getName() || '(unnamed)'}, tris: ${Math.round(triangles)}]` : ''}` +
        ` size=(${size.map((value) => value.toFixed(2)).join(', ')})` +
        ` center=(${bounds.min.map((v, i) => ((v + bounds.max[i]) / 2).toFixed(2)).join(', ')})`,
    );
    for (const child of node.listChildren()) walkTree(child, depth + 1);
  };
  for (const scene of document.getRoot().listScenes()) {
    for (const node of scene.listChildren()) walkTree(node, 0);
  }

  await ensureDir(path.join(OUTPUT_DIR, 'x'));
  await writeFile(path.join(OUTPUT_DIR, `${id}.report.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(OUTPUT_DIR, `${id}.tree.txt`), `${treeLines.join('\n')}\n`);

  // Silhouette renders (cars: side + top view with wheel markers).
  const points = samplePoints(document);
  const markers = wheelCandidates.slice(0, 8).map((candidate, index) => ({
    center: candidate.center,
    color: index < 4 ? [230, 110, 70] : [110, 200, 230],
    size: 3,
  }));
  const aux = {};
  if (points.length) {
    const longAxis = sceneBounds.size[0] >= sceneBounds.size[2] ? 0 : 2;
    await rasterizeSilhouette(points, markers, ([x, y, z]) => (longAxis === 0 ? [x, y] : [z, y]), path.join(OUTPUT_DIR, `${id}.side.png`));
    await rasterizeSilhouette(points, markers, ([x, y, z]) => [x, z], path.join(OUTPUT_DIR, `${id}.top.png`));
    aux.longAxis = ['x', 'y', 'z'][longAxis];
  }

  if (target.kind === 'track') {
    const map = await buildOccupancyMap(triangles, materials, sceneBounds);
    await writeFile(
      path.join(OUTPUT_DIR, `${id}.map.txt`),
      [
        `# ${id} occupancy map (cell ${map.cellSize} m)`,
        `# x: ${map.min[0]} .. ${map.max[0]}   z: ${map.min[1]} .. ${map.max[1]}`,
        `# height range: ${map.heightRange?.join(' .. ')}`,
        '# legend:',
        ...map.legend.map((entry) => `#   ${entry.glyph}  ${entry.material} [${entry.class}] cells=${entry.cells} tris=${entry.triangles}`),
        '# rows top -> bottom are +Z -> -Z',
        map.ascii,
      ].join('\n') + '\n',
    );
    await gridToPng(map.codedRows, map.palette, path.join(OUTPUT_DIR, `${id}.map.png`));
    report.occupancy = {
      cellSize: map.cellSize,
      cells: map.cells,
      bounds: { min: map.min, max: map.max },
      heightRange: map.heightRange,
      legend: map.legend,
    };
    await writeFile(path.join(OUTPUT_DIR, `${id}.report.json`), `${JSON.stringify(report, null, 2)}\n`);
    aux.occupancyCells = map.cells;
  }

  report.aux = aux;
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
      console.log(`          wheel candidates: ${report.wheelCandidates.length}, front signals: ${report.frontSignals.length}`);
    } catch (error) {
      console.error(`[inspect] ${id} FAILED: ${error.message}`);
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
    lines.push(`- bounds: ${report.sceneBounds.size.join(' x ')} @ min ${report.sceneBounds.min.join(', ')}`);
    lines.push(`- wheel candidates: ${report.wheelCandidates.slice(0, 8).map((c) => `${c.name || '(unnamed)'} r≈${c.radiusEstimate}`).join(', ') || 'none'}`);
    lines.push(`- front signals: ${report.frontSignals.slice(0, 8).map((s) => `${s.node ?? s.material}:${s.kind}`).join(', ') || 'none'}`);
    lines.push(`- materials: ${report.materials.slice(0, 10).map((m) => `${m.name}[${m.class}]`).join(', ')}`);
    lines.push('');
  }
  await writeFile(path.join(OUTPUT_DIR, 'SUMMARY.md'), `${lines.join('\n')}\n`);
  console.log(`[inspect] reports written to ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error('[inspect] FATAL:', error);
  process.exitCode = 1;
});
