#!/usr/bin/env node
/**
 * Downloads the owner-supplied source GLBs into the ignored `assets/raw/`
 * directory and prints a container-level summary so the link order can be
 * verified before the expensive optimization pass runs.
 *
 * Usage: node scripts/assets/fetch-sources.mjs [--only <id>] [--force]
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RAW_DIR, SOURCE_MODELS } from './config.mjs';
import { summarizeGlbFile } from './glb-summary.mjs';
import { formatBytes } from './gltf-io.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex === -1 ? null : args[onlyIndex + 1];

async function fileSize(filePath) {
  try {
    const info = await stat(filePath);
    return info.size;
  } catch {
    return 0;
  }
}

async function download(url, destination) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      // Some file hosts reject requests without a browser-like UA.
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      accept: '*/*',
    },
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 300).replaceAll('\n', ' ');
    throw new Error(`download failed (${response.status} ${response.statusText}) for ${url} :: ${body}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const head = buffer.subarray(0, 16).toString('utf8').trim();
  if (!buffer.subarray(0, 4).equals(Buffer.from('glTF'))) {
    throw new Error(`downloaded file is not a GLB (starts with "${head.slice(0, 40)}")`);
  }
  await writeFile(destination, buffer);
  return buffer.length;
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });
  const report = [];

  for (const model of SOURCE_MODELS) {
    if (only && model.id !== only) continue;
    const destination = path.join(RAW_DIR, model.file);
    let bytes = await fileSize(destination);

    if (!bytes || force) {
      process.stdout.write(`[fetch] ${model.id} <- ${model.url}\n`);
      bytes = await download(model.url, destination);
    } else {
      process.stdout.write(`[fetch] ${model.id} already present (${formatBytes(bytes)})\n`);
    }

    const summary = await summarizeGlbFile(destination);
    report.push({ id: model.id, file: model.file, url: model.url, ...summary });

    console.log(
      `[fetch] ${model.id}: ${formatBytes(bytes)} | nodes=${summary.summary.nodes} meshes=${summary.summary.meshes} ` +
        `tris=${summary.summary.triangles.toLocaleString()} materials=${summary.summary.materials} images=${summary.summary.images.length}`,
    );
    console.log(`        nodes: ${summary.summary.nodeNames.slice(0, 12).join(' | ') || '(unnamed)'}`);
    console.log(`        materials: ${summary.summary.materialNames.slice(0, 12).join(' | ') || '(none)'}`);
  }

  await mkdir('assets', { recursive: true });
  await writeFile('assets/reports/source-summary.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[fetch] wrote assets/source-summary.json (${report.length} entries)`);
}

main().catch((error) => {
  console.error('[fetch] FATAL:', error.message);
  process.exitCode = 1;
});
