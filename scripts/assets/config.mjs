/**
 * MaxMotors asset pipeline configuration.
 *
 * Source GLBs are owner-supplied Sketchfab downloads. They live in the ignored
 * `assets/raw/` directory and are NEVER committed. Only the optimized output in
 * `public/` is committed.
 *
 * Credits / licenses: docs/ASSET_LICENSES.md
 */

export const RAW_DIR = 'assets/raw';
export const REPORT_DIR = 'assets/reports';

/** Source downloads. Order matters only for documentation. */
export const SOURCE_MODELS = [
  {
    id: 'sikandar-suv',
    file: 'scorpio-n.glb',
    url: 'https://files.catbox.moe/d9datv.glb',
    label: '2022 Mahindra Scorpio-N (BHP3D / Modding Beast, CC BY 4.0)',
  },
  {
    id: 'forest-dirt-trail',
    file: 'forest-dirt-road.glb',
    url: 'https://files.catbox.moe/88sc50.glb',
    label: 'Dirt Road Through Forest (99.Miles, CC BY 4.0)',
  },
  {
    id: 'aurora-v12',
    file: 'terzo-millennio.glb',
    url: 'https://files.catbox.moe/phz6v9.glb',
    label: 'Lamborghini Terzo Millennio (SDC PERFORMANCE / Oxo, CC BY-NC 4.0)',
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
    maxTextureBytes: 9 * 1024 * 1024,
    // Real-world Scorpio-N length, used to scale the visual onto the physics box.
    targetLengthMeters: 4.66,
    // Node names that must be dropped from the shipped asset (brand badges/decals).
    stripNodePatterns: ['badge', 'logo', 'emblem', 'mahindra', 'decal', 'plate'],
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
    maxTextureBytes: 5 * 1024 * 1024,
    targetLengthMeters: 4.5,
    stripNodePatterns: ['badge', 'logo', 'emblem', 'lamborghini', 'decal', 'plate'],
    stripMaterialPatterns: ['badge', 'logo', 'emblem', 'lamborghini', 'decal'],
  },
  'forest-dirt-trail': {
    source: 'forest-dirt-road.glb',
    output: 'public/tracks/forest-dirt-trail.glb',
    manifest: 'public/tracks/forest-dirt-trail.manifest.json',
    kind: 'track',
    maxBytes: 20 * 1024 * 1024,
    maxTriangles: 150_000,
    textureSize: 2048,
    textureQuality: 78,
    maxTextureBytes: 16 * 1024 * 1024,
    targetLengthMeters: 180,
    stripNodePatterns: [],
    stripMaterialPatterns: [],
  },
};

/** Poly Haven CC0 environment textures. First slug that resolves wins. */
export const POLYHAVEN_TEXTURE_SLUGS = ['asphalt_02', 'asphalt_03', 'asphalt_04', 'asphalt_01'];
export const POLYHAVEN_TEXTURE_MAPS = [
  { slot: 'diffuse', suffix: 'diff_2k.jpg', extension: 'jpg' },
  { slot: 'normal', suffix: 'nor_gl_2k.jpg', extension: 'jpg' },
  { slot: 'roughness', suffix: 'rough_2k.jpg', extension: 'jpg' },
  { slot: 'arm', suffix: 'arm_2k.jpg', extension: 'jpg' },
  { slot: 'displacement', suffix: 'disp_2k.png', extension: 'png' },
];
export const POLYHAVEN_TEXTURE_BASE = 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k';
export const TEXTURE_OUTPUT_DIR = 'public/textures';

/** Outdoor HDRIs are fetched at runtime from the Poly Haven CDN (see game.js). */
export const HDRI_CANDIDATES = [
  'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/lot_01_4k.hdr',
  'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/lot_01_2k.hdr',
];
