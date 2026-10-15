#!/usr/bin/env node
/**
 * Downloads the Poly Haven CC0 asphalt PBR set (2K) used by Test Circuit 01 and
 * writes a small index the game reads at runtime. Poly Haven assets are CC0, so
 * committing them under public/textures is fine; credits live in
 * docs/ASSET_LICENSES.md and the in-game credits screen.
 *
 * Usage: node scripts/assets/fetch-environment.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { POLYHAVEN_TEXTURE_BASE, POLYHAVEN_TEXTURE_SLUGS, TEXTURE_OUTPUT_DIR } from './config.mjs';
import { formatBytes } from './gltf-io.mjs';

const MAPS = [
  { slot: 'diffuse', suffix: 'diff_2k.jpg', base: POLYHAVEN_TEXTURE_BASE },
  { slot: 'normal', suffix: 'nor_gl_2k.jpg', base: POLYHAVEN_TEXTURE_BASE },
  { slot: 'arm', suffix: 'arm_2k.jpg', base: POLYHAVEN_TEXTURE_BASE },
];

async function tryDownload(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength < 20_000) return null;
  return buffer;
}

async function main() {
  await mkdir(TEXTURE_OUTPUT_DIR, { recursive: true });
  let chosen = null;
  const files = [];

  for (const slug of POLYHAVEN_TEXTURE_SLUGS) {
    const probe = await tryDownload(`${POLYHAVEN_TEXTURE_BASE}/${slug}/${slug}_diff_2k.jpg`);
    if (!probe) {
      console.log(`[env] ${slug}: not available`);
      continue;
    }
    chosen = slug;
    for (const map of MAPS) {
      const url = `${map.base}/${slug}/${slug}_${map.suffix}`;
      const buffer = map.slot === 'diffuse' ? probe : await tryDownload(url);
      if (!buffer) {
        console.log(`[env] ${slug}: ${map.slot} missing (${url})`);
        continue;
      }
      const file = path.join(TEXTURE_OUTPUT_DIR, `asphalt_${map.slot}_2k.${map.suffix.split('.').pop()}`);
      await writeFile(file, buffer);
      let metadata = null;
      try {
        metadata = await sharp(buffer).metadata();
      } catch {
        /* sharp metadata is best-effort */
      }
      files.push({
        slot: map.slot,
        file: `/${path.relative('public', file).replaceAll('\\', '/')}`,
        bytes: buffer.byteLength,
        width: metadata?.width ?? null,
        height: metadata?.height ?? null,
        sourceUrl: url,
      });
      console.log(`[env] ${slug}: ${map.slot} -> ${file} (${formatBytes(buffer.byteLength)}${metadata ? `, ${metadata.width}x${metadata.height}` : ''})`);
    }
    break;
  }

  if (!chosen) {
    console.error('[env] no Poly Haven asphalt texture could be downloaded');
    process.exitCode = 1;
    return;
  }

  const index = {
    generatedAt: new Date().toISOString(),
    title: 'Asphalt',
    slug: chosen,
    source: `https://polyhaven.com/a/${chosen}`,
    license: 'CC0 1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    files,
  };
  await writeFile(path.join(TEXTURE_OUTPUT_DIR, 'asphalt.index.json'), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`[env] wrote ${path.join(TEXTURE_OUTPUT_DIR, 'asphalt.index.json')} (${files.length} maps)`);
}

main().catch((error) => {
  console.error('[env] FATAL:', error.message);
  process.exitCode = 1;
});
