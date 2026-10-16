# MaxMotors

**MaxMotors M2.6** is a local-only 3D driving prototype for desktop and mobile browsers. It uses Vite, Three.js, cannon-es `RaycastVehicle`, two licensed cars, three selectable track modes, a synthesised engine model and an optional post-processing chain. M1 shipped the physics, controls and procedural M1 circuit; M2 added the realism pass and the off-road trail; **M2.6 is the fix pass from live play-testing** — fog, load order, engine audio, driving feel, a P/R/N/D gate, drift mode, forest collision and cameras. Multiplayer gameplay stays a future milestone (the dormant Colyseus server is unchanged).

## What M2 adds

- **Two cars, pick either before you drive.** *Aurora V12* (the concept car, V10-style petrol engine, three paint options) and *Sikandar SUV* (heavier diesel SUV preset — more torque, lower top speed, and a looser rear end, so it slides more easily).
- **Two tracks** (three modes since M2.6). *Test Circuit 01* is the M1 asphalt circuit, now with Poly Haven CC0 asphalt PBR including the combined AO/roughness/metalness map. *Forest Dirt Trail* is a downloaded forest scene with a baked terrain heightfield, soft walls along the dirt road, a dirt grip modifier, extra suspension travel and wheel dust when the car slides — and *Forest Free Roam* is the same scene with the corridor walls replaced by a soft outer edge at the map boundary.
- **Driving feel.** Wheel meshes are rigged to the physics wheels (visual steering and spin, per-corner pivots detected from the model), the chassis follows the road surface including off-road dips, brake lights and tyre skid marks respond to the handbrake.
- **Sound.** WebAudio engine beds pitched by RPM and gear, plus tyre scrub. Audio starts on the first input (browser autoplay rules). M2.6 replaces this with a per-cylinder engine model — see below.
- **Graphics.** 4K outdoor HDRI on desktop (1K on mobile), ACES tone mapping, PC-only bloom + SSAO + vignette, contact shadow under the car, 2048 px shadow maps on desktop / 1024 on mobile, no cone trees.

## What M2.6 fixes

Eight issues found by driving the M2.5 build, each with the fix and where it lives:

1. **White, blooming haze.** The fog colour is measured from the horizon band of the sky, and the
   plain mean included the sun: a handful of pixels at 10^4-10^6 nits outvoted ~10^5 sky pixels, so
   the estimate came back near-white *and* above the bloom threshold (0.82) — the whole distance
   hazed out and then glowed. `src/game/fog.js` now uses a **trimmed, sun-rejecting** estimator
   (median luminance -> drop anything above 1.6x it -> trim 12% off both ends -> mean) and caps the
   result by *scaling* it down, which keeps the sky's hue instead of clamping it towards white. The
   cap is per track (`TRACK_TINT[...].fogCap`), because an open circuit should haze towards bright
   sky while the forest must never go milky.
2. **The car loaded last.** The 2K/4K HDRI — the largest single asset on the desktop path — was
   requested in the same tick as the car model and won the race. `createEnvironment({ defer: true })`
   now waits, and `game.init()` loads **the selected car first**, then the track, then calls
   `environment.start()`. The generated canvas sky lights the scene in the meantime, so nothing looks
   unlit while it waits. The SUV's texture quality also moves from q80 to q85
   (`scripts/assets/config.mjs`) — though the pipeline run that applied it proved the knob is a no-op
   for this model: every texture it ships is *already* a WebP at ≤ 1024 px, so a re-encode comes out
   larger than the source and is discarded. Its 1.5 MB of a 9 MB budget is a source-resolution limit,
   not an encode-quality one (`docs/acceptance/m2.6/README.md`, *What landed via CI*).
3. **The SUV was silent, and both engines sounded the same.** `audio.setCar()` tore the layers down
   and set `started = false`, but only `unlock()` — a user-gesture-only entry point — ever rebuilt
   them, so switching cars left the game permanently mute. It now rebuilds the engine itself.
   `src/game/audio.js` is a new engine model driven by the spec in `public/audio/engine.index.json`:
   **one oscillator per cylinder**, each running a `PeriodicWave` of a single cylinder's pressure
   curve at the four-stroke rate, staggered by its position in the **firing order** (the stagger is
   baked into the wave's Fourier phase, because a `start()` offset is a fixed number of seconds and
   would drift out of phase as the RPM changed); the summed pulse train drives **exhaust resonators**
   tuned to each engine's own pipe frequencies; **low/mid/high loop beds** crossfade on RPM; a
   high-shelf plus waveshaper drive gives the **on-throttle** tone and an overrun oscillator plus
   burble LFO the **off-throttle** one; and a gear change triggers a short clutch-out/clutch-in
   **dip**. A V12 and a four-cylinder turbo-diesel now share no numbers.
4. **Twitchy steering, instant brakes, flips.** `src/game/physics.js` now models the *actuator*
   between the driver and the wheel instead of feeding raw key state into a rigid body: a
   rate-limited, speed-sensitive steering rack (self-centring faster than turn-in), a throttle plate
   that opens over ~0.3 s, and progressive disc brakes with a 60/40 front/rear split and a per-wheel
   **anti-lock loop** reading cannon's own `wheel.slipInfo` (`> 1` means the tyre has run out of grip
   and is locking). The service brake also had a units bug: cannon reads `wheel.brake` as a per-step
   **impulse cap in N*s**, so passing raw newtons was 60x too strong — one frame of `S` from 60 km/h
   stopped the car dead, dove the nose and unloaded the rear. It is now `force x dt`, as the
   handbrake always was. A **rollover guard** clamps roll and pitch rates in the chassis frame (yaw
   is left completely alone, so a drift still spins freely) and applies a righting torque past ~29
   degrees of tilt, committing to one roll direction once the car is actually on its roof so it
   cannot balance there.
5. **P / R / N / D.** A real transmission gate (`src/game/input.js` `SELECTORS`, `physics.js`
   `setSelector`, `drivetrain.js` `shift({ selector })`, and the on-screen gate in `index.html`).
   Keys **1-4** select P/R/N/D, with **P** and **N** as mnemonic aliases — `R` stays Reset and `D`
   stays steer-right, both long documented. **`S` in D now only ever brakes**: reverse needs the R
   position, so the automatic can no longer select it just because the car is rolling backwards.
   P applies a rear-biased park brake and delivers no torque; N free-revs to a limiter.
6. **Drift.** A held **handbrake/DRIFT** touch button (`data-control="handbrake"`) — phones had no
   way to pull one, so drifting was keyboard-only — plus a latched **drift mode** (key **T**, or the
   MODE button) that loosens the rear axle, adds a little lock, cuts yaw damping and holds drive
   torque through the slide.
7. **The forest threw the car around.** The baked heightfield was measured from *every* material the
   scene called terrain — which, in a forest whose atlas is named `Background_Tree_Atlas`, was all
   26 of them, including the 105 m canopy, the 70k-triangle trunk atlas and standing grass cards.
   Taking the lowest hit per cell turned that into **224 spikes and 223 holes**, plus a 7x7 corner of
   cells the bake never reached (written as a bare 0, read back as a 96 m pit). Two layers fix it:
   `scripts/assets/terrain.mjs` now classifies ground / vegetation / trunk / prop / backdrop and
   builds the grid from **ground materials only**, and `src/game/tracks/terrain-grid.js` — shared by
   the pipeline and the runtime, so both sides clean identically — filters single-cell outliers with
   a *relative* test (median absolute deviation of the 8 neighbours, which keeps real cliffs and
   removes isolated spikes) and slope-limits the seam where the far-terrain sheet crosses the grid.
   On the M2.5 payload that took cells deviating more than 8 m from their neighbourhood from
   **150 to 3**; the pipeline has since **re-baked** the grid, so what ships now has 0 sentinel pits
   and 0 spikes, and the runtime pass touches 6 of 72,062 cells. Tree trunks are baked into the
   payload (**1333** of them) and become cylinder colliders grouped into ~24 m tiles — 1292 usable
   trunks in 134 static bodies, covering 361 m × 295 m of the map against a trail that runs
   162 m × 38 m — so a tree stops the car anywhere in the forest, not just beside the road. The trail corridor widens from a
   9.5 m clamp to the traced road's real ~12 m, and **Forest Free Roam** opens the whole map with a
   soft outer edge at the heightfield boundary instead of corridor walls — the same scene and the
   same collider, so switching between the two is instant.
8. **Cameras.** Orbit was a parked-car camera: it refused to engage above 5 km/h and handed control
   back the moment the car rolled. It now works at **any speed**, and the chosen angle is **locked to
   the car** — the drag sets an angle *relative to the car's heading*, so a three-quarter front view
   stays a three-quarter front view through a corner instead of the car driving out of frame. In the
   Aurora's cockpit the head position was in the driver's lap, the wheel was a bus-sized 17 cm rim,
   and looking up showed sky through the canopy: `preset.cockpit` in `src/game/cars/catalog.js`
   declares per-car corrections (eye point +85 mm, a 142 mm rim tucked lower under the dash) and a
   **dark cabin shell** rendered from the inside and shown only in the cockpit camera, so it closes
   the roof without changing how the car looks from outside.

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
- **S / Arrow Down:** brake (reverse needs the **R** gate position — in D it only ever brakes)
- **A / Arrow Left** and **D / Arrow Right:** steer
- **1 / 2 / 3 / 4** or **P / N:** the transmission gate — Park, Reverse, Neutral, Drive
- **Space:** handbrake
- **T:** drift mode (a loose rear axle, latched until switched off)
- **C:** camera — chase, orbit, cockpit. Drag or scroll to orbit, at any speed
- **H:** horn, **L:** headlights, **O:** doors, **B:** bonnet / boot
- **R** or **Reset Car:** return to the start line
- **M** or the mute button: toggle audio
- **Touch screens:** on-screen steering, brake/throttle pedals, a held **DRIFT** (handbrake) button,
  a **MODE** (drift) toggle, and a tappable **P R N D** gate
- **Car / paint / track pickers:** the garage panel above the start button (or the HUD, once driving)

The app uses a fixed 60 Hz physics step and caps device pixel ratio on mobile.

## Checks

```sh
npm test          # 106 unit tests: fog estimator, drivetrain, physics feel, audio model, terrain
npx vite build
```

The suite covers the pure models headlessly (no WebGL): the sun-rejecting fog estimator and its cap,
the P/R/N/D gearbox, the steering/throttle/brake/ABS/anti-flip actuator chain, the per-cylinder
pulse-wave maths and RPM crossfade, the heightfield cleaner against the *shipped* forest payload,
trunk recovery from a synthetic scene, and the heading-locked orbit camera.

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

The pipeline also writes the two data files the game cannot synthesise at runtime:

- `public/tracks/*.terrain.json` — the height grid, the traced road centreline, and since M2.6 the
  **tree-trunk colliders** and the cleaning report (`stats.spikes`, `stats.holes`, `stats.filled`,
  `stats.unreachable`, `stats.trunks`, plus `groundMaterials` / `excludedMaterials`). The grid is
  built from ground materials only and filtered before it is written. The runtime applies the *same*
  filter (`src/game/tracks/terrain-grid.js`, imported by both sides) to whatever payload it is given,
  so a stale bake is still drivable — and re-running the pipeline removes the need for it, which the
  `Asset pipeline` run for M2.6 did (run `38798486879` → commit `ad7ae39` on this branch).
- `public/audio/engine.index.json` — per engine: cylinders, firing order, exhaust resonances, idle
  and redline, and the low/mid/high beds with their reference RPMs. `src/game/audio.js` builds its
  live per-cylinder synth from those numbers, so the beds and the synth cannot drift apart.

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
- **Forest Dirt Trail** (and **Forest Free Roam**, the same scene with the corridor walls removed) — Sketchfab *Dirt Road Through Forest* by **99.Miles**, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Optimized, foliage instanced, road centreline and trunk colliders baked into `public/tracks/forest-dirt-trail.terrain.json`.
- **Asphalt PBR** — Poly Haven [`asphalt_02`](https://polyhaven.com/a/asphalt_02), [CC0](https://creativecommons.org/publicdomain/zero/1.0/). Diffuse, normal and the combined AO/roughness/metalness map at 2K.
- **Sky** — Poly Haven `kloppenheim_06_puresky` HDRI, [CC0](https://creativecommons.org/publicdomain/zero/1.0/). 4K on desktop, 1K on mobile, generated canvas sky if the CDN is unreachable.
- **Engine and tyre audio** — original work synthesised by `scripts/assets/build-audio.mjs`, dedicated to the public domain (CC0 1.0). No third-party recordings ship with the game. The live engine note is synthesised at runtime by `src/game/audio.js`.

The credits screen in the game repeats the car and track attributions with links. Full records,
including the NoAI note, the modification summary and the link-to-file mapping: [`docs/ASSET_LICENSES.md`](docs/ASSET_LICENSES.md). The M1 planning notes remain in [`docs/CAR_LICENSES.md`](docs/CAR_LICENSES.md).
