# Car Asset License Records

This file records the owner-provided license and attribution details for the future MaxMotors Car Pack. **Neither licensed model is included in or loaded by the M1 build**; M1 uses a clean procedural prototype car. In-game names will be fictional, and shipped car textures must not retain real-world badges or logos.

## Sikandar SUV

- **Planned in-game name:** Sikandar SUV
- **Source asset:** [2022 Mahindra Scorpio-N](https://sketchfab.com/3d-models/2022-mahindra-scorpio-n-538b10f2860f44e694dc3e9d3e223bf8) by [BHP3D](https://sketchfab.com/BHP3D) on Sketchfab
- **License:** [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)
- **Required attribution:** Model and textures by **Modding Beast**; export and edits by **BHP3D**.
- **Provenance note:** The Sketchfab description says the model was exported from a GTA San Andreas mod. The project owner's supplied record states commercial use is allowed. Preserve this provenance and verify the full chain of rights before release.
- **Allowed project use:** Commercial use and adaptation are permitted under the listed CC BY license, subject to its attribution and license-notice requirements. Any optimization/edit must be identified as a change in the published attribution.

Suggested credit: “2022 Mahindra Scorpio-N model by BHP3D; model and textures by Modding Beast; exported/edited by BHP3D; licensed under CC BY 4.0. Modified for MaxMotors (optimized and badges/logos removed).”

## Aurora V12

- **Planned in-game name:** Aurora V12
- **Source asset:** [( FREE ) Lamborghini Terzo Millennio](https://sketchfab.com/3d-models/free-lamborghini-terzo-millennio-7ad3dffa9d344c3c978eafcc220cb709) by [SDC PERFORMANCE](https://sketchfab.com/Lambo_SC04) on Sketchfab
- **License:** [Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/)
- **Required attribution:** Model by **SDC PERFORMANCE**; base interior by **Oxo** (also credited on the source listing as 0xo).
- **Commercial-use restriction:** While this model is included in the game, the game must remain non-commercial. Replace this model before monetizing the game or any related distribution.
- **Allowed project use:** Adaptation and optimization are allowed under the listed license, subject to attribution and the NonCommercial restriction. Any changes must be identified in the published attribution.

Suggested credit: “Lamborghini Terzo Millennio model by SDC PERFORMANCE; base interior by Oxo; licensed under CC BY-NC 4.0. Modified for MaxMotors (optimized and badges/logos removed).”

## Shared handling and asset pipeline

- The owner manually downloaded both source files. Do not obtain alternate copies on the project's behalf.
- Respect the source listings' **NoAI** clause: do not submit either model, its textures, or derivatives as input to generative-AI systems or use them to train or condition generative models.
- There is no NoDerivatives restriction in either recorded license, so ordinary optimization, editing, and logo/badge removal are permitted, subject to attribution and (for Aurora V12) NonCommercial terms.
- Keep original GLBs in the ignored `assets/raw/` directory. **Never commit original source GLBs.**
- Commit only optimized, Draco-compressed GLBs in `public/cars/`, each under 8 MB. Include attribution in this document, the README, and the in-game credits screen when a model ships.
- Keep the fictional in-game names **Sikandar SUV** and **Aurora V12**. Remove manufacturer badges/logos from textures and avoid presenting the assets as official manufacturer products.

## Lighting asset

The M1 scene loads the 1K **Lot 01** HDRI by Philip Modin from [Poly Haven](https://polyhaven.com/a/lot_01). It is released under [CC0](https://creativecommons.org/publicdomain/zero/1.0/). The HDRI is fetched at runtime rather than stored in this repository; the scene has a generated fallback for offline use.
