# M2.5 "Simulator Feel Pass" — acceptance evidence

Screenshots were taken from the sandbox build (`npm run dev`) by driving the real UI with
keyboard, mouse and touch events in headless Chromium 153, WebGL 2 on SwiftShader (software
rendering, no GPU). Two consequences:

- **Sky:** Poly Haven is not reachable from the sandbox, so these frames use the game's own
  generated fallback sky, the same thing production shows if the CDN is down. Production loads the
  `kloppenheim_06_puresky` HDRI. The material audit (step 3) runs in GitHub Actions *with* that
  HDRI.
- **Frame rate:** about 3 fps on the test circuit and 0.2–0.5 fps in the forest, so the sim
  advances at most 0.1 s per frame. Drives are short and speeds are low.

## Step 1 — camera suite (C key / CAM touch button)

| | Aurora V12 | Sikandar SUV |
|---|---|---|
| Chase (lower and closer, speed FOV, lateral offset in turns) | ![](step1-aurora-v12-chase.jpg) | ![](step1-sikandar-suv-chase.jpg) |
| Orbit free-look (< 5 km/h, drag 360° + scroll / pinch) | ![](step1-aurora-v12-orbit.jpg) | ![](step1-sikandar-suv-orbit.jpg) ![](step1-sikandar-suv-orbit-top.jpg) |
| Cockpit (manifest driver-head anchor, wheel turned left) | ![](step1-aurora-v12-cockpit.jpg) procedural CC0 wheel at the estimated anchor (no wheel node) | ![](step1-sikandar-suv-cockpit.jpg) real `steering_dummy` node rotated (dash visible) |

## Step 2 — vehicle features

- **Horn (H / HORN):** ![](step2-horn.png) The game's horn analyser measured RMS **0.206**
  (Aurora) and **0.207** (Sikandar) while H was held. 0.7 s after release it read 0.0000 (Aurora)
  and 0.022, still decaying (Sikandar).
- **Headlights (L):** off ![](step2-aurora-v12-lights-off.jpg) → on
  ![](step2-aurora-v12-lights-on.jpg) and off ![](step2-sikandar-suv-lights-off.jpg) → on
  ![](step2-sikandar-suv-lights-on.jpg). The lamp emissive switches, two SpotLight beams are cast
  on desktop, and the strip shows "◐ LIGHTS".
- **Handbrake drift + skid marks:** ![](step2-aurora-v12-drift.jpg)
  ![](step2-aurora-v12-skidmarks.jpg) ![](step2-sikandar-suv-drift.jpg) The drift is also covered
  by `tests/physics.test.js`: 20–60° peak slip, the car never leaves the ground, more than 25 km/h
  is kept, and grip is restored on release.
- **Doors / boot (O / B):** ![](step2-aurora-v12-doors.jpg) shows the scissor doors.
  ![](step2-sikandar-suv-doors.jpg) shows door_lf/rf/lr/rr plus the boot. Neither source has a
  bonnet node, so bonnet opening is deferred in `src/game/car-openables.js`.

## Step 3 — material fidelity

The sheets are `assets/reports/aurora-v12.compare.png` and `assets/reports/sikandar-suv.compare.png`
(source | optimized | in-game, same HDRI). The numbers are in `*.compare.json`. The mean colour
delta inside the silhouette went from 34.9 / 28.3 / 21.0 to **20.9 / 16.1 / 14.3** for the
Sikandar (front / rear / side).

## Step 4 — forest presentation

| | before | after |
|---|---|---|
| Aurora | `assets/reports/forest-dirt-trail.chase-before-aurora-v12.png` | `assets/reports/forest-dirt-trail.chase-after-aurora-v12.png` |
| Sikandar | `assets/reports/forest-dirt-trail.chase-before-sikandar-suv.png` | `assets/reports/forest-dirt-trail.chase-after-sikandar-suv.png` |

**Before:** the car was launched (1,405 / 1,565 km/h) because the collider never matched the
terrain, and the camera stared into flat fog.

**After:** all four wheels are on the terrain, the visual tyres sit within 3 cm of the physics
contacts, and the scene uses sky-matched exponential fog with a terrain-aware chase camera. The
spawn sits under dense canopy, so with the fallback sky the frame is dark.

The canopy census is in `assets/reports/forest-dirt-trail.canopy.json`:

- There are 0 instanced nodes in both source and shipped.
- Every tree trunk survives: oak 961 → 961, birch 177 → 177.
- Tree-atlas cards keep 88%, bushes 71% and grass 38%. That loss comes from simplification under
  the 150k-triangle budget, not from instancing.

## Step 5 — Free Roam

Deferred to M4.5. See the comments in `src/main.js` (`TRACKS`) and
`src/game/tracks/forest-trail.js` (`update`).

## Step 6 — minimal HUD

| | setup | driving |
|---|---|---|
| desktop | ![](step6-desktop-setup.jpg) | ![](step6-desktop-driving.jpg) |
| phone | ![](step6-phone-setup.jpg) | ![](step6-phone-driving.jpg) |

When driving, the HUD is a slim telemetry strip, a SETUP pill and an icon reset button. The setup
panel auto-hides on input and is `display: none` with no backdrop-filter, so nothing repaints over
the view. Its chips are now clickable, which they were not before (`pointer-events`).
