#!/usr/bin/env node
/**
 * Material fidelity audit (M2.5 "simulator feel" step 3).
 *
 * Renders every car three ways, side by side, in a bare three.js viewer lit by
 * the same Poly Haven HDRI the game uses (kloppenheim_06_puresky, CC0):
 *
 *   source     the owner-supplied GLB from assets/raw/ (never committed)
 *   optimized  the shipped GLB from public/models/ (raw glTF materials)
 *   in-game    the shipped GLB after the game's runtime material treatment
 *              (src/game/cars/loader.js: clearcoat paint, glass, emissive)
 *
 * Outputs (committed by the pipeline):
 *   assets/reports/<id>.compare.png    3 views x 3 columns
 *   assets/reports/<id>.compare.json   silhouette IoU + colour delta per view,
 *                                      material inventories, renderer info
 *
 * Silhouette IoU catches geometry that went missing (a dropped wing, mirror or
 * badge plate); the colour delta inside the shared silhouette catches flat
 * paint, lost texture detail and wrong material splits.
 *
 * Needs a Chrome/Chromium binary: CHROME_PATH (or PUPPETEER_EXECUTABLE_PATH),
 * otherwise the usual system locations. WebGL runs on SwiftShader, so no GPU is
 * required.
 *
 * Usage: node scripts/assets/render-compare.mjs [--only <id>] [--out-dir public]
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ASSET_TARGETS, AUDIT_HDRI_URL, RAW_DIR, REPORT_DIR } from './config.mjs';

const args = process.argv.slice(2);
const onlyIndex = args.indexOf('--only');
const only = onlyIndex === -1 ? null : args[onlyIndex + 1];
const outIndex = args.indexOf('--out-dir');
const OUT_DIR = outIndex === -1 ? null : args[outIndex + 1].replace(/\/$/, '');

const CELL = { width: 512, height: 320 };
const GAP = 8;
const HEADER = 46;
const COLUMNS = [
  { id: 'source', label: 'SOURCE (assets/raw)' },
  { id: 'optimized', label: 'OPTIMIZED (public/models)' },
  { id: 'inGame', label: 'IN-GAME (runtime materials)' },
];
const VIEW_LABELS = { front34: 'front 3/4', rear34: 'rear 3/4', side: 'side' };
const ROOT = process.cwd();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
};

const reroot = (value) => (OUT_DIR && value ? value.replace(/^public\//, `${OUT_DIR}/`) : value);

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function fetchHdri() {
  if (process.env.MAXMOTORS_HDRI_FILE) return { file: process.env.MAXMOTORS_HDRI_FILE, url: 'local file' };
  const file = path.join(os.tmpdir(), path.basename(new URL(AUDIT_HDRI_URL).pathname));
  if (existsSync(file)) return { file, url: AUDIT_HDRI_URL };
  try {
    const response = await fetch(AUDIT_HDRI_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    return { file, url: AUDIT_HDRI_URL };
  } catch (error) {
    console.warn(`[compare] HDRI download failed (${error.message}); the viewer falls back to RoomEnvironment`);
    return { file: null, url: null };
  }
}

/** Tiny static server: only the folders the viewer needs, no traversal. */
function startServer({ hdriFile }) {
  const mounts = [
    ['/viewer/', path.join(ROOT, 'scripts/assets/viewer')],
    ['/node_modules/three/', path.join(ROOT, 'node_modules/three')],
    ['/node_modules/meshoptimizer/', path.join(ROOT, 'node_modules/meshoptimizer')],
    ['/src/game/', path.join(ROOT, 'src/game')],
    ['/raw/', path.resolve(ROOT, RAW_DIR)],
    ['/out/', path.resolve(ROOT, OUT_DIR ?? 'public')],
  ];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      let file = null;
      if (url.pathname === '/hdri.hdr' && hdriFile) file = hdriFile;
      for (const [prefix, directory] of mounts) {
        if (file || !url.pathname.startsWith(prefix)) continue;
        const candidate = path.resolve(directory, decodeURIComponent(url.pathname.slice(prefix.length)));
        if (candidate.startsWith(directory)) file = candidate;
      }
      if (!file) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end(String(error.message));
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function decodeDataUrl(dataUrl) {
  const buffer = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { buffer, data, info };
}

/** IoU of two coverage masks + mean RGB delta inside their intersection. */
function compareImages(maskA, maskB, imageA, imageB) {
  let union = 0;
  let intersection = 0;
  let delta = 0;
  let coverageA = 0;
  let coverageB = 0;
  for (let index = 0; index < maskA.data.length; index += 4) {
    const a = maskA.data[index + 3] > 127;
    const b = maskB.data[index + 3] > 127;
    if (a) coverageA += 1;
    if (b) coverageB += 1;
    if (a || b) union += 1;
    if (a && b) {
      intersection += 1;
      delta += (Math.abs(imageA.data[index] - imageB.data[index])
        + Math.abs(imageA.data[index + 1] - imageB.data[index + 1])
        + Math.abs(imageA.data[index + 2] - imageB.data[index + 2])) / 3;
    }
  }
  const pixels = maskA.data.length / 4;
  return {
    iou: Number((union ? intersection / union : 1).toFixed(4)),
    meanDelta: Number((intersection ? delta / intersection : 0).toFixed(2)),
    coverage: [Number((coverageA / pixels).toFixed(4)), Number((coverageB / pixels).toFixed(4))],
  };
}

function svgText(width, height, items) {
  const escape = (value) => String(value).replace(/[<>&]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[character]));
  const body = items.map(({ x, y, text, size = 15, color = '#e9ecdf', anchor = 'start', weight = 600 }) => (
    `<text x="${x}" y="${y}" font-family="DejaVu Sans Mono, monospace" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${escape(text)}</text>`
  )).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`);
}

async function composeSheet({ id, cells, metrics, file }) {
  const views = Object.keys(VIEW_LABELS);
  const width = COLUMNS.length * CELL.width + (COLUMNS.length + 1) * GAP;
  const height = HEADER + views.length * CELL.height + (views.length + 1) * GAP;
  const composites = [];
  const labels = COLUMNS.map((column, index) => ({
    x: GAP + index * (CELL.width + GAP) + CELL.width / 2,
    y: 30,
    text: `${column.label}`,
    anchor: 'middle',
  }));
  views.forEach((view, row) => {
    COLUMNS.forEach((column, columnIndex) => {
      const left = GAP + columnIndex * (CELL.width + GAP);
      const top = HEADER + GAP + row * (CELL.height + GAP);
      composites.push({ input: cells[view][column.id], left, top });
      const metric = column.id === 'source' ? null : metrics[view][column.id];
      labels.push({ x: left + 10, y: top + 22, text: `${id} · ${VIEW_LABELS[view]}`, size: 13, color: '#ffffff' });
      if (metric) {
        labels.push({
          x: left + CELL.width - 10,
          y: top + CELL.height - 12,
          text: `IoU ${metric.iou.toFixed(3)}  Δ ${metric.meanDelta.toFixed(1)}`,
          size: 13,
          anchor: 'end',
          color: metric.iou < 0.95 ? '#ffb27a' : '#bff0b0',
        });
      }
    });
  });
  composites.push({ input: svgText(width, height, labels), left: 0, top: 0 });
  await sharp({ create: { width, height, channels: 3, background: { r: 14, g: 18, b: 20 } } })
    .composite(composites)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(file);
}

async function auditCar(page, id, target) {
  const manifestPath = reroot(target.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const sourceUrl = `/raw/${target.source}`;
  const optimizedUrl = `/out/${path.relative(OUT_DIR ?? 'public', reroot(target.output))}`;
  const stats = {};
  await page.evaluate(() => window.__audit.unloadAll());
  stats.source = await page.evaluate((options) => window.__audit.load(options), { column: 'source', url: sourceUrl, manifest, carId: id });
  stats.optimized = await page.evaluate((options) => window.__audit.load(options), { column: 'optimized', url: optimizedUrl, manifest, carId: id });
  stats.inGame = await page.evaluate((options) => window.__audit.load(options), { column: 'inGame', url: optimizedUrl, manifest, carId: id, inGame: true });

  const cells = {};
  const metrics = {};
  for (const view of Object.keys(VIEW_LABELS)) {
    cells[view] = {};
    metrics[view] = {};
    const images = {};
    for (const column of COLUMNS) {
      const image = await page.evaluate((options) => window.__audit.render(options), { column: column.id, view });
      const mask = await page.evaluate((options) => window.__audit.render(options), { column: column.id, view, mask: true });
      images[column.id] = { image: await decodeDataUrl(image), mask: await decodeDataUrl(mask) };
      cells[view][column.id] = images[column.id].image.buffer;
    }
    for (const column of ['optimized', 'inGame']) {
      metrics[view][column] = compareImages(images.source.mask, images[column].mask, images.source.image, images[column].image);
    }
    console.log(`[compare] ${id} ${view}: optimized IoU ${metrics[view].optimized.iou} Δ ${metrics[view].optimized.meanDelta} | in-game IoU ${metrics[view].inGame.iou} Δ ${metrics[view].inGame.meanDelta}`);
  }

  await mkdir(REPORT_DIR, { recursive: true });
  const sheet = path.join(REPORT_DIR, `${id}.compare.png`);
  await composeSheet({ id, cells, metrics, file: sheet });
  const sourceMaterials = new Set(stats.source.materials);
  const optimizedMaterials = new Set(stats.optimized.materials);
  const report = {
    id,
    source: target.source,
    optimized: reroot(target.output),
    views: metrics,
    stats: {
      source: { meshes: stats.source.meshes, triangles: stats.source.triangles, materials: stats.source.materials.length },
      optimized: { meshes: stats.optimized.meshes, triangles: stats.optimized.triangles, materials: stats.optimized.materials.length },
      inGame: { meshes: stats.inGame.meshes, triangles: stats.inGame.triangles, materials: stats.inGame.materials.length },
    },
    materials: {
      droppedByOptimizer: [...sourceMaterials].filter((name) => !optimizedMaterials.has(name)),
      optimized: stats.optimized.materials,
    },
  };
  console.log(`[compare] ${id} -> ${sheet} | tris ${stats.source.triangles.toLocaleString()} -> ${stats.optimized.triangles.toLocaleString()} | materials ${stats.source.materials.length} -> ${stats.optimized.materials.length}`);
  return report;
}

async function main() {
  if (only && ASSET_TARGETS[only]?.kind !== 'car') {
    console.log(`[compare] --only ${only}: not a car, nothing to audit`);
    return;
  }
  const chrome = findChrome();
  if (!chrome) throw new Error('no Chrome/Chromium found (set CHROME_PATH)');
  const { default: puppeteer } = await import('puppeteer-core');
  const hdri = await fetchHdri();
  const server = await startServer({ hdriFile: hdri.file });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: process.env.CHROME_HEADLESS === 'shell' ? 'shell' : true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      `--window-size=${CELL.width},${CELL.height}`,
    ],
    defaultViewport: { width: CELL.width, height: CELL.height, deviceScaleFactor: 1 },
    protocolTimeout: 900_000,
  });
  const reports = [];
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(900_000);
    page.on('pageerror', (error) => console.warn(`[compare] page error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') console.warn(`[compare] page ${message.type()}: ${message.text().slice(0, 200)}`);
    });
    await page.goto(`${base}/viewer/compare.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__audit?.ready);
    const info = await page.evaluate((options) => window.__audit.setup(options), { ...CELL, hdri: hdri.file ? '/hdri.hdr' : null });
    console.log(`[compare] chrome ${await browser.version()} | ${info.gpu} | ${info.hdri}`);
    for (const [id, target] of Object.entries(ASSET_TARGETS)) {
      if (target.kind !== 'car' || (only && id !== only)) continue;
      if (!existsSync(path.join(RAW_DIR, target.source))) {
        console.warn(`[compare] ${id}: missing source ${path.join(RAW_DIR, target.source)} — skipped`);
        continue;
      }
      const report = await auditCar(page, id, target);
      report.environment = { hdri: hdri.url ?? 'RoomEnvironment fallback', viewer: info.hdri, chrome: await browser.version(), gpu: info.gpu };
      report.generatedAt = new Date().toISOString();
      await writeFile(path.join(REPORT_DIR, `${id}.compare.json`), `${JSON.stringify(report, null, 2)}\n`);
      reports.push(report);
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (!reports.length) throw new Error('no car was audited');
}

main().catch((error) => {
  console.error('[compare] FATAL:', error.message);
  process.exitCode = 1;
});
