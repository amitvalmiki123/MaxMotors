import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

let cachedIO = null;

/**
 * NodeIO with every extension registered plus Draco/meshopt/KTX2 decoders so we
 * can read whatever the source downloads happen to use.
 */
export async function getNodeIO() {
  if (cachedIO) return cachedIO;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const dependencies = {};

  try {
    const draco3d = (await import('draco3dgltf')).default;
    dependencies['draco3d.decoder'] = await draco3d.createDecoderModule();
    dependencies['draco3d.encoder'] = await draco3d.createEncoderModule();
  } catch (error) {
    console.warn('[gltf-io] draco3d unavailable:', error.message);
  }

  try {
    const { MeshoptDecoder, MeshoptEncoder } = await import('meshoptimizer');
    await MeshoptDecoder.ready;
    await MeshoptEncoder.ready;
    dependencies['meshopt.decoder'] = MeshoptDecoder;
    dependencies['meshopt.encoder'] = MeshoptEncoder;
  } catch (error) {
    console.warn('[gltf-io] meshoptimizer unavailable:', error.message);
  }

  io.registerDependencies(dependencies);
  cachedIO = io;
  return io;
}

export async function ensureDir(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function countTriangles(document) {
  let triangles = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      const position = primitive.getAttribute('POSITION');
      if (indices) triangles += indices.getCount() / 3;
      else if (position) triangles += position.getCount() / 3;
    }
  }
  return Math.round(triangles);
}

export function countTextureBytes(document) {
  let bytes = 0;
  for (const texture of document.getRoot().listTextures()) {
    bytes += texture.getImage()?.byteLength ?? 0;
  }
  return bytes;
}

export function listTextureInfo(document) {
  return document.getRoot().listTextures().map((texture) => ({
    name: texture.getName() || '(unnamed)',
    mimeType: texture.getMimeType(),
    bytes: texture.getImage()?.byteLength ?? 0,
    uri: texture.getURI() || null,
  }));
}
