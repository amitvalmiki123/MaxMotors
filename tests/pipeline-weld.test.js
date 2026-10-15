import assert from 'node:assert/strict';
import test from 'node:test';
import { Document, Primitive } from '@gltf-transform/core';
import { weldByPosition } from '../scripts/assets/weld-position.mjs';

function vertexCount(document) {
  let total = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      total += primitive.getAttribute('POSITION').getCount();
    }
  }
  return total;
}

/**
 * Two triangles that share an edge in space but not in the vertex buffer, with
 * different UVs — the shape every UV island border has in a baked export.
 */
function splitQuadDocument() {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    1, 1, 0,
    0, 0, 0,
    1, 1, 0,
    0, 1, 0,
  ]);
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0.5, 0.5,
    0.6, 0.6,
    0.5, 1,
  ]);
  const primitive = document.createPrimitive()
    .setMode(Primitive.Mode.TRIANGLES)
    .setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', document.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer))
    .setIndices(document.createAccessor().setType('SCALAR').setArray(new Uint32Array([0, 1, 2, 3, 4, 5])).setBuffer(buffer));
  const mesh = document.createMesh('quad').addPrimitive(primitive);
  document.createScene().addChild(document.createNode('quad').setMesh(mesh));
  return document;
}

test('welding by position merges split vertices and keeps the triangle count', () => {
  const document = splitQuadDocument();
  const primitive = document.getRoot().listMeshes()[0].listPrimitives()[0];

  assert.equal(vertexCount(document), 6, 'fixture starts fully split');

  const { merged } = weldByPosition(document);

  assert.equal(merged, 2, 'the two duplicated positions should merge');
  assert.equal(vertexCount(document), 4);
  assert.equal(primitive.getIndices().getCount(), 6, 'topology is unchanged');
  assert.equal(primitive.getAttribute('TEXCOORD_0').getCount(), 4);
  assert.ok(primitive.getAttribute('POSITION').getArray() instanceof Float32Array);
  assert.ok(primitive.getAttribute('TEXCOORD_0').getArray() instanceof Float32Array);
  // The first occurrence keeps its UV, the duplicate is dropped.
  const uvs = primitive.getAttribute('TEXCOORD_0').getArray();
  assert.deepEqual([...uvs.slice(0, 2)], [0, 0]);
  // Vertex 3 is the top-left corner, which only the second triangle introduces.
  assert.deepEqual([...uvs.slice(6, 8)], [0.5, 1]);
});

test('an already welded mesh is left untouched', () => {
  const document = new Document();
  const buffer = document.createBuffer();
  const primitive = document.createPrimitive()
    .setMode(Primitive.Mode.TRIANGLES)
    .setAttribute('POSITION', document.createAccessor().setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0])).setBuffer(buffer))
    .setIndices(document.createAccessor().setType('SCALAR')
      .setArray(new Uint32Array([0, 1, 2])).setBuffer(buffer));
  document.createScene().addChild(document.createNode('tri').setMesh(document.createMesh('tri').addPrimitive(primitive)));

  const before = primitive.getAttribute('POSITION');
  const { merged } = weldByPosition(document);

  assert.equal(merged, 0);
  assert.equal(primitive.getAttribute('POSITION'), before, 'no accessor churn when there is nothing to do');
});

test('non-triangle primitives are skipped', () => {
  const document = new Document();
  const buffer = document.createBuffer();
  const primitive = document.createPrimitive()
    .setMode(Primitive.Mode.POINTS)
    .setAttribute('POSITION', document.createAccessor().setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 0, 0, 0])).setBuffer(buffer));
  document.createScene().addChild(document.createNode('points').setMesh(document.createMesh('points').addPrimitive(primitive)));

  const { merged } = weldByPosition(document);
  assert.equal(merged, 0);
  assert.equal(primitive.getAttribute('POSITION').getCount(), 2);
});

test('snapPositions aligns seam vertices but keeps their UVs (no merge)', async () => {
  const { Document } = await import('@gltf-transform/core');
  const { snapPositions } = await import('../scripts/assets/weld-position.mjs');
  const document = new Document();
  const buffer = document.createBuffer();
  // Two triangles sharing an edge, split along a UV seam with a 0.03 mm gap.
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1.00003, 0, 0, 0.00002, 1, 0, 1, 1, 0]);
  const uvs = new Float32Array([0, 0, 0.5, 0, 0, 0.5, 0.6, 0, 0.1, 0.5, 0.6, 0.5]);
  const primitive = document.createPrimitive()
    .setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', document.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer))
    .setIndices(document.createAccessor().setType('SCALAR').setArray(new Uint32Array([0, 1, 2, 3, 5, 4])).setBuffer(buffer));
  document.createMesh().addPrimitive(primitive);
  const moved = snapPositions(document, { tolerance: 1e-4 });
  const out = primitive.getAttribute('POSITION').getArray();
  assert.equal(moved, 2);
  assert.equal(primitive.getAttribute('POSITION').getCount(), 6, 'no vertex is merged away');
  assert.deepEqual([...out.slice(9, 12)], [...out.slice(3, 6)], 'seam vertex snapped onto its twin');
  assert.deepEqual([...primitive.getAttribute('TEXCOORD_0').getArray()], [...uvs], 'UVs untouched');
});
