# MaxMotors

**MaxMotors M2** is a local-only 3D driving prototype for desktop and mobile browsers. It uses Vite, Three.js, cannon-es `RaycastVehicle`, two licensed cars, two selectable tracks, procedural tyre/engine audio and an optional post-processing chain. M1 shipped the physics, controls and procedural M1 circuit; M2 adds the realism pass and the off-road trail. Multiplayer gameplay stays a future milestone (the dormant Colyseus server is unchanged).

## What M2 adds

- **Two cars, pick either before you drive.** *Aurora V12* (the concept car, V10-style petrol engine, three paint options) and *Sikandar SUV* (heavier diesel SUV preset — more torque, lower top speed, and a looser rear end, so it slides more easily).
- **Two tracks.** *Test Circuit 01* is the M1 asphalt circuit, now with Poly Haven CC0 asphalt PBR including the combined AO/roughness/metalness map. *Forest Dirt Trail* is a downloaded forest scene with a baked terrain heightfield, soft walls along the dirt road, a dirt grip modifier, extra suspension travel and wheel dust when the car slides.
- **Driving feel.** Wheel meshes are rigged to the physics wheels (visual steering and spin, per-corner pivots detected from the model), the chassis follows the road surface including off-road dips, brake lights and tyre skid marks respond to the handbrake.
- **Sound.** WebAudio engine beds pitched by RPM and gear — a V10-style layer for the Aurora and a turbo-diesel rumble for the Sikandar — plus tyre scrub. Audio starts on the first input (browser autoplay rules).
- **Graphics.** 4K outdoor HDRI on desktop (1K on mobile), ACES tone mapping, PC-only bloom + SSAO + vignette, contact shadow under the car, 2048 px shadow maps on desktop / 1024 on mobile, no cone trees.

## Quality tiers

`src/game/config.js` detects the device and can be overridden with `?quality=high` or `?quality=low`:

| | Desktop | Mobile |
| --- | --- | --- |
| Post-processing (bloom, SSAO, vignette) | on | **off** |
| Shadow map | 2048 | 1024 |
| HDRI | 4K | 1K |
| Dust particles | on | reduced |
| Texture budget | — | ≤ 150 MB decoded |

## Run locally

Requirements: Node.js 22 or newer and a WebGL-capable browser.

```sh
npm install
npm run dev
```

Open the Vite URL printed in the terminal. To run the M1 server in a second terminal:

```sh
npm --prefix server install
npm --prefix server start
```

The server exposes `GET /health` and an empty Colyseus `lobby` room. The M1 browser client does not connect to it.

## Controls

- **W / Arrow Up:** accelerate
- **S / Arrow Down:** brake, then reverse
- **A / Arrow Left** and **D / Arrow Right:** steer
- **Space:** handbrake
- **R** or **Reset Car:** return to the start line
- **M** or the mute button: toggle audio
- **Touch screens:** on-screen left/right steering and brake/throttle pedals
- **Car / paint / track pickers:** the garage panel above the start button (or the HUD, once driving)

The app uses a fixed 60 Hz physics step and caps device pixel ratio on mobile.

## Checks

```sh
npm test
npx vite build
```

## Asset pipeline

The licensed GLBs are **not** in this repository: `scripts/assets/fetch-sources.mjs` downloads the
owner's source files into the ignored `assets/raw/`, and `optimize-glb.mjs` writes the optimized
output into `public/`. Both run in the `Asset pipeline` GitHub workflow (manual dispatch, or a push
touching the pipeline, `src/game/**` or `docs/**`); the workflow commits the result and always
commits its log to `assets/reports/pipeline.log`.

```sh
npm run assets:pipeline      # fetch + inspect + optimize + terrain + textures + audio
```

Locally the source host is not always reachable, so the pipeline can be dry-run against the checked-in
fixtures and target any directory:

```sh
MAXMOTORS_RAW_DIR=assets/fixtures node scripts/assets/build-audio.mjs --out /tmp/out/audio
MAXMOTORS_RAW_DIR=assets/fixtures MAXMOTORS_REPORT_DIR=/tmp/out/reports \
  node scripts/assets/optimize-glb.mjs --out-dir /tmp/out
```

Set `MAXMOTORS_REPORT_DIR` (and `--out-dir`) outside the repository for dry runs, otherwise a local
run overwrites the committed reports and shipped manifests with fixture numbers.

Budgets (triangles, file size, texture size and decoded texture memory) live in
`scripts/assets/config.mjs`, and the results are recorded in each asset's `*.manifest.json`
(`output.triangles`, `output.triangleBudget`, `output.overBudget`).

**Meeting the triangle budget.** The Scorpio-N arrives as a UV-atlas bake: nearly every vertex is
split along a texture-island border, so `weld()` (bitwise-identical vertices only) is a no-op and
the simplifier sees a soup of disconnected fans — it returns the input unchanged at every error
level. `scripts/assets/weld-position.mjs` therefore rebuilds the index buffer on a position grid so
coincident vertices are shared, dropping the triangles that collapse to a line or point, which is
what finally lets `simplify` collapse the mesh. `optimize-glb.mjs` runs that as a graduated
fallback — exact weld first, then the grid coarsening to 1.6% of the model extent — re-simplifying
and re-checking the budget after each pass, and records `overBudget` so a miss is visible in the
committed reports (and in `assets/reports/pipeline.log`) instead of hiding in the Actions log.

## Render deployment

`render.yaml` defines a static Vite site and a separate Node/Colyseus web service. Create the Blueprint in Render from this repository; the server's `/health` endpoint is its health check. Render supplies `PORT`, and the server binds to `0.0.0.0`.

## Asset policy and credits

Source GLBs are owner-supplied Sketchfab downloads. They live in the ignored `assets/raw/` directory and are **never** committed; only pipeline output is committed under `public/`. Shipped car textures have real-world badges and logo decals stripped, and the in-game names are fictional. **While the Aurora V12 (CC BY-NC) is part of the build, MaxMotors stays non-commercial.**

- **Sikandar SUV** — Sketchfab [2022 Mahindra Scorpio-N](https://sketchfab.com/3d-models/2022-mahindra-scorpio-n-538b10f2860f44e694dc3e9d3e223bf8) by **BHP3D**; model and textures by **Modding Beast**, export and edits by **BHP3D**. [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The source listing notes a GTA San Andreas mod export; preserve this provenance and verify the chain of rights before release.
- **Aurora V12** — Sketchfab [( FREE ) Lamborghini Terzo Millennio](https://sketchfab.com/3d-models/free-lamborghini-terzo-millennio-7ad3dffa9d344c3c978eafcc220cb709) by **SDC PERFORMANCE**; base interior by **Oxo**. [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). The game must remain non-commercial while this car is included; replace it before monetization.
- **Both models:** manually downloaded by the owner; respect the NoAI clause (do not provide the models or textures as generative-AI inputs). Editing and optimization are allowed; attribute changes and remove real-world badges/logos from shipped textures. Fictional in-game names are **Sikandar SUV** and **Aurora V12**.
- **Forest Dirt Trail** — Sketchfab *Dirt Road Through Forest* by **99.Miles**, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Optimized, foliage instanced, road centreline baked into `public/tracks/forest-dirt-trail.terrain.json`.
- **Asphalt PBR** — Poly Haven [`asphalt_02`](https://polyhaven.com/a/asphalt_02), [CC0](https://creativecommons.org/publicdomain/zero/1.0/). Diffuse, normal and the combined AO/roughness/metalness map at 2K.
- **Sky** — Poly Haven `kloppenheim_06_puresky` HDRI, [CC0](https://creativecommons.org/publicdomain/zero/1.0/). 4K on desktop, 1K on mobile, generated canvas sky if the CDN is unreachable.
- **Engine and tyre audio** — original work synthesised by `scripts/assets/build-audio.mjs`, dedicated to the public domain (CC0 1.0). No third-party recordings ship with the game.

The credits screen in the game repeats the car and track attributions with links. Full records,
including the NoAI note, the modification summary and the link-to-file mapping: [`docs/ASSET_LICENSES.md`](docs/ASSET_LICENSES.md). The M1 planning notes remain in [`docs/CAR_LICENSES.md`](docs/CAR_LICENSES.md).
