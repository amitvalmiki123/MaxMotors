#!/usr/bin/env node
/**
 * Canopy check for the Forest Dirt Trail (M2.5 step 4).
 *
 * The source scene merges every tree of a kind into one mesh, so "how many
 * trees" means counting connected islands: each trunk and each foliage card is
 * its own island. This counts islands (and triangles) per canopy material in
 * the source GLB and in the shipped GLB, including EXT_mesh_gpu_instancing
 * copies, and writes assets/reports/forest-dirt-trail.canopy.json — so it is
 * visible whether instancing or simplification thinned the canopy.
 *
 * Usage: node scripts/assets/forest-canopy.mjs [--only <id>]
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ASSET_TARGETS, RAW_DIR, REPORT_DIR } from './config.mjs';
import { getNodeIO } from './gltf-io.mjs';

const ID = 'forest-dirt-trail';
const CANOPY = /tree|trunk|bush|leaves|foliage|grass_vegetation/i;

function find(parent, index) {
  let root = index;
  while (parent[root] !== root) root = parent[root];
  while (parent[index] !== root) {
    const next = parent[index];
    parent[index] = root;
    index = next;
  }
  return root;
}

/** Islands of one primitive, with coincident positions treated as connected. */
function countIslands(primitive) {
  const position = primitive.getAttribute('POSITION');
  const indices = primitive.getIndices();
  if (!position) return { islands: 0, triangles: 0 };
  const count = position.getCount();
  const element = [];
  const canonical = new Uint32Array(count);
  const seen = new Map();
  for (let vertex = 0; vertex < count; vertex += 1) {
    const [x, y, z] = position.getElement(vertex, element);
    const key = `${Math.round(x * 1e4)}:${Math.round(y * 1e4)}:${Math.round(z * 1e4)}`;
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, vertex);
      canonical[vertex] = vertex;
    } else {
      canonical[vertex] = existing;
    }
  }
  const parent = Uint32Array.from({ length: count }, (_, index) => index);
  const list = indices ? indices.getArray() : Uint32Array.from({ length: count }, (_, index) => index);
  for (let corner = 0; corner + 2 < list.length; corner += 3) {
    const a = find(parent, canonical[list[corner]]);
    const b = find(parent, canonical[list[corner + 1]]);
    const c = find(parent, canonical[list[corner + 2]]);
    parent[b] = a;
    parent[find(parent, c)] = a;
  }
  const roots = new Set();
  for (let corner = 0; corner < list.length; corner += 1) roots.add(find(parent, canonical[list[corner]]));
  return { islands: roots.size, triangles: list.length / 3 };
}

export async function canopyCensus(file) {
  const document = await (await getNodeIO()).read(file);
  const materials = {};
  let instancedNodes = 0;
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const instancing = node.getExtension('EXT_mesh_gpu_instancing');
    const copies = instancing ? (instancing.listAttributes()[0]?.getCount() ?? 1) : 1;
    if (instancing) instancedNodes += 1;
    for (const primitive of mesh.listPrimitives()) {
      const name = primitive.getMaterial()?.getName() ?? '';
      if (!CANOPY.test(name)) continue;
      const { islands, triangles } = countIslands(primitive);
      const entry = materials[name] ?? { islands: 0, triangles: 0 };
      entry.islands += islands * copies;
      entry.triangles += triangles * copies;
      materials[name] = entry;
    }
  }
  return { file, instancedNodes, materials };
}

async function main() {
  const onlyIndex = process.argv.indexOf('--only');
  const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];
  if (only && only !== ID) return;
  const target = ASSET_TARGETS[ID];
  const shipped = await canopyCensus(target.output);
  const sourceFile = path.join(RAW_DIR, target.source);
  const source = existsSync(sourceFile) ? await canopyCensus(sourceFile) : null;
  const retention = {};
  for (const [name, entry] of Object.entries(shipped.materials)) {
    const before = source?.materials?.[name];
    retention[name] = before ? {
      islands: Number((entry.islands / Math.max(1, before.islands)).toFixed(3)),
      triangles: Number((entry.triangles / Math.max(1, before.triangles)).toFixed(3)),
    } : null;
  }
  const report = { id: ID, generatedAt: new Date().toISOString(), source, shipped, retention };
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(path.join(REPORT_DIR, `${ID}.canopy.json`), `${JSON.stringify(report, null, 2)}\n`);
  for (const [name, entry] of Object.entries(shipped.materials)) {
    const before = source?.materials?.[name];
    console.log(`[canopy] ${name}: islands ${before ? `${before.islands} -> ` : ''}${entry.islands} | tris ${before ? `${before.triangles} -> ` : ''}${entry.triangles}`);
  }
  console.log(`[canopy] instanced nodes in shipped GLB: ${shipped.instancedNodes}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('[canopy] FATAL:', error.message);
    process.exitCode = 1;
  });
}
