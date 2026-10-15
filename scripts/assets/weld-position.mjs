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
export function weldByPosition(document, { tolerance = DEFAULT_TOLERANCE, filter = null } = {}) {
  let merged = 0;
  let dropped = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (filter && !filter(primitive)) continue;
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

/**
 * Seam-preserving alternative to `weldByPosition`: snaps vertices that sit
 * within `tolerance` of each other onto one bitwise-identical position, but
 * keeps every vertex (and its UV / normal) separate.
 *
 * meshopt's simplifier recognises coincident positions with different
 * attributes as *seams* and collapses along them while keeping both sides'
 * UVs and normals intact — so the mesh can be simplified without the stretched
 * texel bands and broken shading that merging the vertices causes. A follow-up
 * `weld()` then merges only the vertices that became fully identical.
 *
 * Returns the number of vertices moved onto a neighbour.
 */
export function snapPositions(document, { tolerance = DEFAULT_TOLERANCE, filter = null } = {}) {
  let snapped = 0;
  const done = new Set();
  const toleranceSq = tolerance * tolerance;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (filter && !filter(primitive)) continue;
      const position = primitive.getAttribute('POSITION');
      if (!position || done.has(position)) continue;
      done.add(position);
      const array = position.getArray();
      const cells = new Map();
      const count = position.getCount();
      for (let vertex = 0; vertex < count; vertex += 1) {
        const x = array[vertex * 3];
        const y = array[vertex * 3 + 1];
        const z = array[vertex * 3 + 2];
        const cx = bucket(x, tolerance);
        const cy = bucket(y, tolerance);
        const cz = bucket(z, tolerance);
        let match = -1;
        for (let dx = -1; dx <= 1 && match < 0; dx += 1) {
          for (let dy = -1; dy <= 1 && match < 0; dy += 1) {
            for (let dz = -1; dz <= 1 && match < 0; dz += 1) {
              const list = cells.get(`${cx + dx}:${cy + dy}:${cz + dz}`);
              if (!list) continue;
              for (const candidate of list) {
                const ex = array[candidate * 3] - x;
                const ey = array[candidate * 3 + 1] - y;
                const ez = array[candidate * 3 + 2] - z;
                if (ex * ex + ey * ey + ez * ez <= toleranceSq) {
                  match = candidate;
                  break;
                }
              }
            }
          }
        }
        if (match >= 0) {
          if (array[match * 3] !== x || array[match * 3 + 1] !== y || array[match * 3 + 2] !== z) {
            array[vertex * 3] = array[match * 3];
            array[vertex * 3 + 1] = array[match * 3 + 1];
            array[vertex * 3 + 2] = array[match * 3 + 2];
            snapped += 1;
          }
        } else {
          const key = `${cx}:${cy}:${cz}`;
          const list = cells.get(key);
          if (list) list.push(vertex);
          else cells.set(key, [vertex]);
        }
      }
      position.setArray(array);
    }
  }
  return snapped;
}
