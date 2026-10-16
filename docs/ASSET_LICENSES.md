# Asset License Records (M2)

MaxMotors M2 ships three licensed models plus CC0 textures, HDRI and audio. This file is the
authoritative record: it lists each file in the repository, where it came from, under which license,
who to credit, and exactly what the asset pipeline changed.

**The game is non-commercial while the Aurora V12 is included** (see the NonCommercial section
below).

## Shipped models

All three GLBs are optimized derivatives produced by `npm run assets:pipeline`
(`scripts/assets/optimize-glb.mjs`). Originals live in the git-ignored `assets/raw/` and are never
committed.

### Sikandar SUV — `public/models/sikandar-suv.glb`

| Field | Value |
| --- | --- |
| Source (Sketchfab) | [2022 Mahindra Scorpio-N](https://sketchfab.com/3d-models/2022-mahindra-scorpio-n-538b10f2860f44e694dc3e9d3e223bf8) |
| Source file | <https://files.catbox.moe/88sc50.glb> → `assets/raw/sikandar-suv.glb` |
| Authors | model and textures by **Modding Beast**, export and edits by **BHP3D** |
| License | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| In-game name | Sikandar SUV |

### Aurora V12 — `public/models/aurora-v12.glb`

| Field | Value |
| --- | --- |
| Source (Sketchfab) | [( FREE ) Lamborghini Terzo Millennio](https://sketchfab.com/3d-models/free-lamborghini-terzo-millennio-7ad3dffa9d344c3c978eafcc220cb709) |
| Source file | <https://files.catbox.moe/phz6v9.glb> → `assets/raw/aurora-v12.glb` |
| Authors | model by **SDC PERFORMANCE**, base interior by **Oxo** (listed as 0xo) |
| License | [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) |
| In-game name | Aurora V12 |

### Forest Dirt Trail — `public/tracks/forest-dirt-trail.glb`

| Field | Value |
| --- | --- |
| Source (Sketchfab) | *Dirt Road Through Forest* listing, recorded by the owner (the project does not re-derive listing URLs; the catbox link below is the source of truth for content) |
| Source file | <https://files.catbox.moe/d9datv.glb> → `assets/raw/forest-dirt-road.glb` |
| Author | **99.Miles** |
| License | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| In-game name | Forest Dirt Trail |

> **Filename note.** The owner's catbox links are the source of truth for content and are matched by
> link, not by filename: `d9datv` is the forest road, `88sc50` is the Scorpio-N and `phz6v9` is the
> Terzo Millennio. Each download was inspected (mesh names, textures, triangle counts) and stored
> under the matching `SOURCE_MODELS` entry in `scripts/assets/config.mjs`, so the mapping is
> recorded in code as well as here.

### Required attribution (shown in the credits screen and here)

- “2022 Mahindra Scorpio-N model by BHP3D; model and textures by Modding Beast; exported/edited by
  BHP3D; licensed CC BY 4.0. Modified for MaxMotors: optimized, geometry simplified, textures
  resized, badges/decals removed.”
- “Lamborghini Terzo Millennio model by SDC PERFORMANCE; base interior by Oxo; licensed CC BY-NC 4.0.
  Modified for MaxMotors: optimized, geometry simplified, textures resized, badges/decals removed.”
- “Dirt Road Through Forest by 99.Miles; licensed CC BY 4.0. Modified for MaxMotors: optimized,
  geometry simplified, textures resized to 512 px, road centreline sampled into a terrain
  heightfield.”

## Modification summary (what the pipeline did)

Every shipped model was processed by `gltf-transform` in CI:

1. **Geometry** — meshopt compression, welding, instance/dedup rewrite, simplification down to the
   per-asset triangle budget.
2. **Badges and logos** — flat plaque meshes were detected and removed (83 on the Aurora, 31 on the
   SUV) via the `stripFlatDecals` pass, and any material that only painted a logo decal was pruned.
   Real-world brand text is not present in the shipped car textures; the livery colour and
   clearcoat are preserved and re-tinted by the in-game paint options.
3. **Textures** — resized and re-encoded to the per-asset budget (2K for cars, 512 px for the forest
   foliage). No 4K textures ship in the car or track assets.
4. **Terrain** — the forest road's walkable corridor is baked to
   `public/tracks/forest-dirt-trail.terrain.json` (274×274 grid at 2 m, road half-width ≈ 12 m), used
   by the game for a cannon-es `Heightfield` and soft track walls.
5. Manifests (`*.manifest.json`) record triangle counts, texture memory, wheel pivots and the
   optimization parameters for each shipped asset.

## CC0 assets

| Asset | Files | Source | License |
| --- | --- | --- | --- |
| Asphalt PBR (diffuse / normal / AO-roughness-metalness, 2K) | `public/textures/asphalt_{diffuse,normal,arm}_2k.jpg`, `public/textures/asphalt.index.json` | Poly Haven, slug `asphalt_02` — <https://polyhaven.com/a/asphalt_02> (fetched from `dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/asphalt_02/`) | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Outdoor HDRI (4K desktop, 1K mobile) | fetched at runtime, `VITE_HDRI_URL_4K` / `VITE_HDRI_URL_1K` | Poly Haven `kloppenheim_06_puresky` (4K/1K) with a `lot_01_2k` fallback — see `HDRI_URLS` in `scripts/assets/config.mjs` and `src/game/environment.js` | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Engine loop beds — V12 for the Aurora, turbo-diesel for the Sikandar | `public/audio/aurora-v12-{low,mid,high}.wav`, `public/audio/sikandar-diesel-{low,mid,high}.wav`, `public/audio/engine.index.json` | **Original work**, synthesised from scratch by `scripts/assets/build-audio.mjs` (per-cylinder firing pulses summed over one 720° cycle, driven through exhaust resonators, plus induction and turbo noise), dedicated to the public domain | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Tyre scrub, skid and dust noise | synthesised at runtime (WebAudio buffers in `src/game/audio.js`, particles in `src/game/effects.js`) | Original work | Project-owned |

Each loop spans a whole number of firing cycles at its reference RPM, so it stays seamless when
pitched by `playbackRate = rpm / referenceRpm`; `engine.index.json` records the reference RPM,
firing frequency and loop length per layer, plus the engine spec the runtime synth needs
(cylinders, firing order, exhaust resonances, idle and redline). No third-party audio recordings
ship with the game. The HDRI is a runtime download (with a generated canvas-sky fallback), so it is
CC0 media loaded by the app rather than a file in this repository.

The beds are only part of the engine note: `src/game/audio.js` synthesises the live per-cylinder
pulse train, exhaust resonance and overrun/gear-shift behaviour at runtime from that same spec, so
the loops and the synth always describe the same engine. The Aurora's profile id is `aurora-v12`
(it was `aurora-v10` in M2/M2.5, when the car was described as a "V10-style" engine).

## Restrictions

- **NonCommercial:** the Aurora V12 (Lamborghini Terzo Millennio) is CC BY-NC 4.0. While it is part
  of the build, MaxMotors is a non-commercial project: no ads, paid builds, sponsorship or any other
  monetisation, and no NC-licensed art in commercial marketing material. Replace the model with a
  CC BY or original asset before monetising.
- **NoAI:** the source listings carry a NoAI clause (Sketchfab marks the models as
  `isAiGenerated: false` / no-AI-derivatives). Do not submit these models, their textures or any
  derivative as input to generative-AI systems, and do not use them to train or condition
  generative models. This also applies to the optimized GLBs committed in `public/`.
- **No redistribution as assets:** the pipeline output exists to run MaxMotors. Do not republish the
  GLBs as standalone asset downloads; share them only as part of the app, with the attribution
  above.
- **Provenance:** the Scorpio-N listing states the model was exported from a GTA San Andreas mod.
  The owner's record states commercial use is allowed; the chain of rights should be re-verified
  before any commercial release.

## Pipeline provenance

`scripts/assets/config.mjs` holds the `SOURCE_MODELS` table (catbox URL, raw filename, output file,
triangle/size/texture budgets). CI (`.github/workflows/assets-pipeline.yml`) downloads the raw files,
runs inspect + optimize + terrain + audio and commits the results under `public/`, so every shipped
byte in `public/models`, `public/tracks`, `public/textures` and `public/audio` is reproducible.
