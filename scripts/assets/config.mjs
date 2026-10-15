/**
 * MaxMotors asset pipeline configuration.
 *
 * Source GLBs are owner-supplied Sketchfab downloads. They live in the ignored
 * `assets/raw/` directory and are NEVER committed. Only the optimized output in
 * `public/` is committed.
 *
 * The owner's link list was ordered differently than the files it resolves to
 * (verified in assets/reports/pipeline.log: node names `Dirt road scene.fbx`,
 * `scorpio_n.fbx`, `Lambo T M`). The mapping below is the verified one.
 *
 * Credits / licenses: docs/ASSET_LICENSES.md
 */

// `MAXMOTORS_RAW_DIR` lets the dev fixtures run the pipeline locally, where the
// owner's file host is not reachable (see scripts/assets/dev-fixtures.mjs).
export const RAW_DIR = process.env.MAXMOTORS_RAW_DIR || 'assets/raw';
// `MAXMOTORS_REPORT_DIR` keeps local dry-runs (fixtures) from overwriting the
// real reports the CI pipeline commits.
export const REPORT_DIR = process.env.MAXMOTORS_REPORT_DIR || 'assets/reports';

/** Source downloads. */
export const SOURCE_MODELS = [
  {
    id: 'sikandar-suv',
    file: 'scorpio-n.glb',
    url: 'https://files.catbox.moe/88sc50.glb',
    label: '2022 Mahindra Scorpio-N (BHP3D / Modding Beast, CC BY 4.0)',
    note: 'Owner link 2. Scene root `scorpio_n.fbx`, 1.35M triangles.',
  },
  {
    id: 'forest-dirt-trail',
    file: 'forest-dirt-road.glb',
    url: 'https://files.catbox.moe/d9datv.glb',
    label: 'Dirt Road Through Forest (99.Miles, CC BY 4.0)',
    note: 'Owner link 1. Scene root `Dirt road scene.fbx`, ~550 m across.',
  },
  {
    id: 'aurora-v12',
    file: 'terzo-millennio.glb',
    url: 'https://files.catbox.moe/phz6v9.glb',
    label: 'Lamborghini Terzo Millennio (SDC PERFORMANCE / Oxo, CC BY-NC 4.0)',
    note: 'Owner link 3. Scene root `Lambo T M`, front faces +Z in the source.',
  },
];

/**
 * Per-model optimization targets (M2 brief):
 *   Scorpio  < 8 MB / ~100k triangles
 *   Terzo    < 4 MB / ~70k triangles
 *   Forest   < 20 MB / ~150k triangles
 * 4K textures are explicitly not required: cars top out at 2K.
 */
export const ASSET_TARGETS = {
  'sikandar-suv': {
    source: 'scorpio-n.glb',
    output: 'public/models/sikandar-suv.glb',
    manifest: 'public/models/sikandar-suv.manifest.json',
    kind: 'car',
    maxBytes: 8 * 1024 * 1024,
    maxTriangles: 100_000,
    textureSize: 2048,
    textureQuality: 80,
    baseColorQuality: 92,
    maxTextureBytes: 9 * 1024 * 1024,
    maxTextureMemoryMB: 128,
    simplifyError: 0.006,
    // Real-world Scorpio-N length; the model is already 4.67 m long.
    targetLengthMeters: 4.66,
    stripNodePatterns: ['badge', 'logo', 'emblem', 'mahindra', 'decal'],
    stripMaterialPatterns: ['badge', 'logo', 'emblem', 'mahindra', 'decal'],
  },
  'aurora-v12': {
    source: 'terzo-millennio.glb',
    output: 'public/models/aurora-v12.glb',
    manifest: 'public/models/aurora-v12.manifest.json',
    kind: 'car',
    maxBytes: 4 * 1024 * 1024,
    maxTriangles: 70_000,
    textureSize: 2048,
    textureQuality: 78,
    baseColorQuality: 92,
    // Documented above: the source front faces +Z. Its mesh nodes are all
    // `Object_N`, so naming alone cannot tell, and it shipped backwards.
    frontAxis: '+z',
    driverSide: 'left',
    maxTextureBytes: 5 * 1024 * 1024,
    maxTextureMemoryMB: 96,
    simplifyError: 0.004,
    // Source model is 3.56 m long; scale it up to the real 4.5 m supercar size.
    targetLengthMeters: 4.5,
    stripNodePatterns: ['badge', 'logo', 'emblem', 'lamborghini', 'decal'],
    stripMaterialPatterns: ['badge', 'logo', 'emblem', 'lamborghini', 'decal'],
  },
  'forest-dirt-trail': {
    source: 'forest-dirt-road.glb',
    output: 'public/tracks/forest-dirt-trail.glb',
    manifest: 'public/tracks/forest-dirt-trail.manifest.json',
    terrainData: 'public/tracks/forest-dirt-trail.terrain.json',
    kind: 'track',
    maxBytes: 20 * 1024 * 1024,
    maxTriangles: 150_000,
    // 70 source images (~50 MB) drive the budget here, and the mobile GPU
    // budget is ~150 MB of decoded texture memory: 512 px foliage lands near
    // 75 MB, 1K would blow straight past it.
    textureSize: 512,
    textureQuality: 76,
    maxTextureBytes: 14 * 1024 * 1024,
    maxTextureMemoryMB: 150,
    simplifyError: 0.01,
    stripNodePatterns: [],
    stripMaterialPatterns: [],
  },
};

/** Poly Haven CC0 environment textures. First slug that resolves wins. */
export const POLYHAVEN_TEXTURE_SLUGS = ['asphalt_02', 'asphalt_03', 'asphalt_04', 'asphalt_01'];
export const POLYHAVEN_TEXTURE_BASE = 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k';
export const TEXTURE_OUTPUT_DIR = 'public/textures';

/** Outdoor HDRI, fetched at runtime (PC 4K / mobile 1K) — see src/game/environment.js */
export const HDRI_URLS = {
  desktop: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/kloppenheim_06_puresky_4k.hdr',
  mobile: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/kloppenheim_06_puresky_1k.hdr',
  fallback: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/lot_01_2k.hdr',
};

/** Same sky as the game, for the source-vs-optimized material audit (render-compare.mjs). */
export const AUDIT_HDRI_URL = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/kloppenheim_06_puresky_2k.hdr';
