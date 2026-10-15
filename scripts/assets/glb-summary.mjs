import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const JSON_CHUNK = 0x4e4f534a; // 'JSON'
const BIN_CHUNK = 0x004e4942; // 'BIN'

/**
 * Minimal, dependency-free GLB container reader. Used to sanity-check the
 * downloaded source files before the (slower) gltf-transform pass runs.
 */
export function readGlbContainer(buffer) {
  if (buffer.length < 20) throw new Error('file is too small to be a GLB');
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error('missing glTF magic (not a binary .glb file)');
  }
  const version = buffer.readUInt32LE(4);
  const declaredLength = buffer.readUInt32LE(8);
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + chunkLength;
    chunks.push({ type: chunkType, start, end });
    offset = end;
  }
  const jsonChunk = chunks.find((chunk) => chunk.type === JSON_CHUNK);
  if (!jsonChunk) throw new Error('GLB has no JSON chunk');
  const json = JSON.parse(buffer.subarray(jsonChunk.start, jsonChunk.end).toString('utf8'));
  const binChunk = chunks.find((chunk) => chunk.type === BIN_CHUNK);
  return {
    version,
    declaredLength,
    actualLength: buffer.length,
    json,
    binBytes: binChunk ? binChunk.end - binChunk.start : 0,
    chunkCount: chunks.length,
  };
}

export function summarizeGlbJson(json) {
  const accessors = json.accessors ?? [];
  const meshes = json.meshes ?? [];
  let triangles = 0;
  let primitives = 0;
  let vertices = 0;
  for (const mesh of meshes) {
    for (const primitive of mesh.primitives ?? []) {
      primitives += 1;
      const position = accessors[primitive.attributes?.POSITION ?? -1];
      if (position) vertices += position.count ?? 0;
      const indices = accessors[primitive.indices ?? -1];
      if (indices) {
        const count = indices.count ?? 0;
        triangles += primitive.mode === 4 || primitive.mode === undefined ? count / 3 : count / 3;
      } else if (position) {
        triangles += (position.count ?? 0) / 3;
      }
    }
  }
  const images = (json.images ?? []).map((image, index) => {
    const view = json.bufferViews?.[image.bufferView ?? -1];
    return {
      index,
      name: image.name ?? null,
      mimeType: image.mimeType ?? null,
      bytes: view?.byteLength ?? null,
      uri: image.uri ? 'external' : null,
    };
  });

  return {
    nodes: (json.nodes ?? []).length,
    meshes: meshes.length,
    primitives,
    vertices: Math.round(vertices),
    triangles: Math.round(triangles),
    materials: (json.materials ?? []).length,
    textures: (json.textures ?? []).length,
    images,
    animations: (json.animations ?? []).length,
    skins: (json.skins ?? []).length,
    extensionsUsed: json.extensionsUsed ?? [],
    nodeNames: (json.nodes ?? []).map((node) => node.name).filter(Boolean).slice(0, 60),
    meshNames: meshes.map((mesh) => mesh.name).filter(Boolean).slice(0, 60),
    materialNames: (json.materials ?? []).map((material) => material.name).filter(Boolean).slice(0, 60),
  };
}

export async function summarizeGlbFile(path) {
  const buffer = await readFile(path);
  const container = readGlbContainer(buffer);
  return {
    bytes: buffer.length,
    version: container.version,
    summary: summarizeGlbJson(container.json),
  };
}
