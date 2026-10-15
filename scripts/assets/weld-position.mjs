/**
 * Position-based welding: merges vertices that sit at the same point even when
 * their other attributes differ.
 *
 * Mod and photogrammetry exports (the owner's Scorpio-N is one) bake a texture
 * atlas, so nearly every vertex is split along UV island borders. `weld()` from
 * gltf-transform only merges *bitwise identical* vertices, which leaves those
 * meshes as a soup of disconnected fans — meshopt's simplifier can then barely
 * collapse anything, and the model misses its triangle budget no matter how far
 * the error is raised.
 *
 * This pass rebuilds the index buffer so that coincident positions share one
 * vertex, keeping the attributes of the first occurrence. That lets the
 * simplifier work; the price is a slightly stretched texel band along the
 * island seams, which is the normal trade for a LOD-grade shipped asset.
 */
import { Primitive } from '@gltf-transform/core';

const DEFAULT_TOLERANCE = 1e-4;

function bucket(value, tolerance) {
  return Math.round(value / tolerance);
}

/**
 * Rebuilds one primitive over position-welded vertices.
 * Returns the number of vertices merged away (0 when nothing changed).
 */
function weldPrimitiveByPosition(document, primitive, tolerance) {
  if (primitive.getMode() !== Primitive.Mode.TRIANGLES) return null;
  const position = primitive.getAttribute('POSITION');
  const indices = primitive.getIndices();
  if (!position || !indices) return null;

  const positionArray = position.getArray();
  const indexArray = indices.getArray();
  const vertexCount = position.getCount();
  const writeMap = new Uint32Array(vertexCount).fill(0xffffffff);
  const lookup = new Map();
  let nextVertex = 0;

  for (let index = 0; index < indexArray.length; index += 1) {
    const vertex = indexArray[index];
    if (writeMap[vertex] !== 0xffffffff) continue;
    const key = `${bucket(positionArray[vertex * 3], tolerance)}:`
      + `${bucket(positionArray[vertex * 3 + 1], tolerance)}:`
      + `${bucket(positionArray[vertex * 3 + 2], tolerance)}`;
    const existing = lookup.get(key);
    if (existing === undefined) {
      lookup.set(key, vertex);
      writeMap[vertex] = nextVertex;
      nextVertex += 1;
    } else {
      writeMap[vertex] = writeMap[existing];
    }
  }
  if (nextVertex === vertexCount) return null;

  const buffer = document.getRoot().listBuffers()[0];
  for (const semantic of primitive.listSemantics()) {
    const attribute = primitive.getAttribute(semantic);
    if (!attribute) continue;
    const source = attribute.getArray();
    const itemSize = attribute.getElementSize();
    const merged = new source.constructor(nextVertex * itemSize);
    const written = new Uint8Array(nextVertex);
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const target = writeMap[vertex];
      // The first vertex at a merged position wins; later duplicates must not
      // overwrite it with their own (differing) attributes.
      if (target === 0xffffffff || written[target]) continue;
      written[target] = 1;
      for (let component = 0; component < itemSize; component += 1) {
        merged[target * itemSize + component] = source[vertex * itemSize + component];
      }
    }
    // `setArray` infers the component type from the typed array, which is the
    // same one the source attribute used.
    primitive.setAttribute(semantic, document
      .createAccessor(`${attribute.getName() || semantic}-welded`)
      .setType(attribute.getType())
      .setNormalized(attribute.getNormalized())
      .setArray(merged)
      .setBuffer(buffer));
    // Shared streams are left alone; only drop what this primitive owned.
    if (attribute.listParents().length <= 1) attribute.dispose();
  }

  // Rebuild the index buffer, dropping the triangles that collapse to a line or a
  // point once coincident vertices are shared. meshopt refuses to touch a
  // primitive that contains degenerate triangles, so this step is what actually
  // unblocks the simplifier (pole fans and seam slivers are the usual suspects).
  const mergedIndices = [];
  for (let index = 0; index < indexArray.length; index += 3) {
    const a = writeMap[indexArray[index]];
    const b = writeMap[indexArray[index + 1]];
    const c = writeMap[indexArray[index + 2]];
    if (a === b || b === c || a === c) continue;
    mergedIndices.push(a, b, c);
  }
  primitive.setIndices(document
    .createAccessor(`${indices.getName() || 'indices'}-welded`)
    .setType('SCALAR')
    .setArray(new Uint32Array(mergedIndices))
    .setBuffer(buffer));
  if (indices.listParents().length <= 1) indices.dispose();

  return { merged: vertexCount - nextVertex, dropped: (indexArray.length - mergedIndices.length) / 3 };
}

/**
 * Welds every triangle primitive of the document by position and returns how
 * many vertices were merged away.
 */
export function weldByPosition(document, { tolerance = DEFAULT_TOLERANCE } = {}) {
  let merged = 0;
  let dropped = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      try {
        const result = weldPrimitiveByPosition(document, primitive, tolerance);
        if (!result) continue;
        merged += result.merged;
        dropped += result.dropped;
      } catch (error) {
        document.getLogger().warn(`weldByPosition: skipped a primitive (${error.message})`);
      }
    }
  }
  return { merged, dropped };
}
