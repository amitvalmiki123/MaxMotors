# MaxMotors

**MaxMotors M1** is a local-only 3D driving prototype for desktop and mobile browsers. It uses Vite, Three.js, cannon-es `RaycastVehicle`, a procedural closed test circuit, and a clean procedural sample car. Multiplayer gameplay and the licensed Car Pack are future milestones; no licensed car GLBs are part of M1.

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
- **Touch screens:** on-screen left/right steering and brake/throttle pedals

The app uses a fixed 60 Hz physics step, caps device pixel ratio at 1.5 on mobile, and has no post-processing.

## Checks

```sh
npm test
npx vite build
```

## Render deployment

`render.yaml` defines a static Vite site and a separate Node/Colyseus web service. Create the Blueprint in Render from this repository; the server's `/health` endpoint is its health check. Render supplies `PORT`, and the server binds to `0.0.0.0`.

## Asset policy and credits

Original, owner-supplied GLBs belong in the ignored `assets/raw/` directory and must never be committed. Future Car Pack models must be optimized Draco GLBs under 8 MB in `public/cars/`, with real-world badges/logos removed. M1 uses only procedural geometry.

- **Sikandar SUV** — Sketchfab [2022 Mahindra Scorpio-N](https://sketchfab.com/3d-models/2022-mahindra-scorpio-n-538b10f2860f44e694dc3e9d3e223bf8) by **BHP3D**; model and textures by **Modding Beast**, export and edits by **BHP3D**. [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The source listing notes a GTA San Andreas mod export; preserve this provenance and verify the chain of rights before release.
- **Aurora V12** — Sketchfab [( FREE ) Lamborghini Terzo Millennio](https://sketchfab.com/3d-models/free-lamborghini-terzo-millennio-7ad3dffa9d344c3c978eafcc220cb709) by **SDC PERFORMANCE**; base interior by **Oxo**. [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). The game must remain non-commercial while this car is included; replace it before monetization.
- **Both models:** manually downloaded by the owner; respect the NoAI clause (do not provide the models or textures as generative-AI inputs). Editing and optimization are allowed; attribute changes and remove real-world badges/logos from shipped textures. Fictional in-game names are **Sikandar SUV** and **Aurora V12**.
- **M1 environment:** [Lot 01 HDRI](https://polyhaven.com/a/lot_01) by Philip Modin, [Poly Haven](https://polyhaven.com/), [CC0](https://creativecommons.org/publicdomain/zero/1.0/). Loaded at 1K via `RGBELoader`; generated fallback is used if the remote file is unavailable.

Full records and asset-handling rules: [`docs/CAR_LICENSES.md`](docs/CAR_LICENSES.md).
