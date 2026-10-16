/**
 * Terrain height grid: decode, clean and sample.
 *
 * Shared by the asset pipeline (`scripts/assets/terrain.mjs`, which bakes the
 * grid) and the runtime (`tracks/forest-trail.js`, which drives on it) so both
 * sides apply **exactly the same** cleaning. That matters: the heightfield is a
 * physical surface, so a cell the pipeline thought was fine and the game
 * thought was a spike — or the other way round — is a ramp or a pit under the
 * car.
 *
 * Pure math, no three.js / cannon-es / DOM: unit-tested in
 * tests/forest-terrain.test.js.
 */

/**
 * Decodes the shipped payload (base64 int16 centimetres) into metres.
 *
 * @param {string|ArrayLike<number>} encoded base64 string, or an already decoded array
 * @param {number} expectedLength cols × rows
 * @returns {Float32Array}
 */
export function decodeHeights(encoded, expectedLength) {
  if (typeof encoded !== 'string') {
    // Already decoded (a fixture, or a second pass): copy into a Float32Array.
    const out = new Float32Array(expectedLength);
    for (let index = 0; index < expectedLength; index += 1) out[index] = Number(encoded?.[index] ?? 0);
    return out;
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const view = new Int16Array(bytes.buffer, bytes.byteOffset, Math.min(expectedLength, bytes.length / 2));
  const heights = new Float32Array(expectedLength);
  for (let index = 0; index < heights.length; index += 1) heights[index] = (view[index] ?? 0) / 100;
  return heights;
}

function median(sorted) {
  if (!sorted.length) return 0;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Removes single-cell spikes and holes from a height grid.
 *
 * A photogrammetry bake leaves both, and the shipped forest heightfield had 224
 * spikes and 223 holes in it: a trunk base sampled into one cell reads as a
 * 3–5 m spike, a cell covered only by canopy reads as a hole, and a grid corner
 * the bake never reached reads as a 96 m pit. Every one of them is a physical
 * feature — the car hits a spike and jumps, drops into a hole and flips.
 *
 * The discriminator is *relative*, which is what keeps real terrain: a genuine
 * cliff or road embankment has most of its neighbours spread across it too, so
 * their median absolute deviation is large and it survives; an isolated spike
 * has neighbours that agree with each other and disagree with it, so it is
 * replaced by their median.
 *
 * @param {ArrayLike<number>} values row-major grid (may contain NaN holes)
 * @param {number} cols
 * @param {number} rows
 * @param {object} [options]
 * @param {number} [options.minTolerance] metres a cell may differ by before it is suspect
 * @param {number} [options.spreadFactor] × the neighbours' robust spread, added to the tolerance
 * @param {number} [options.maxTolerance] ceiling on that allowance, so a cliff face cannot
 *        grant a neighbouring spike immunity
 * @param {number} [options.passes] filter passes (a spike pair needs two)
 * @param {number|null} [options.maxStep] slope limiter, in metres per cell: a
 *        second phase that clamps any cell more than this far from its
 *        neighbours' median. The outlier filter alone cannot catch the seam
 *        where the source's far-terrain sheet intersects the near grid — that
 *        is a *consistent* 38 m step, not a lone bad cell, so it survives every
 *        relative test. Over a 2 m cell, 6 m is a 71° face: still an obstacle,
 *        but no longer a launch ramp. `stepPasses` controls how far that
 *        smoothing propagates back from the seam (8 passes ≈ 16 m of ramp).
 * @param {number|null} [options.sentinel] a value meaning "never sampled", e.g. the
 *        bare `heightOffset` the old serializer wrote for unreachable cells; it is
 *        replaced from its neighbours before filtering so it cannot poison them
 * @returns {{values: Float32Array, spikes: number, holes: number, sentinelCells: number}}
 */
export function filterHeightOutliers(values, cols, rows, {
  minTolerance = 1.6,
  spreadFactor = 1.8,
  maxTolerance = 9,
  passes = 3,
  maxStep = 6,
  stepPasses = 8,
  sentinel = null,
} = {}) {
  let current = Float32Array.from(values instanceof Float32Array ? values : new Float32Array(values));

  // --- sentinel cells: "no data" stored as a real-looking number -------------
  let sentinelCells = 0;
  if (sentinel !== null && Number.isFinite(sentinel)) {
    const finite = [];
    for (let index = 0; index < current.length; index += 1) {
      if (Math.abs(current[index] - sentinel) < 0.02) {
        current[index] = Number.NaN;
        sentinelCells += 1;
      } else if (Number.isFinite(current[index])) {
        finite.push(current[index]);
      }
    }
    if (sentinelCells) {
      finite.sort((a, b) => a - b);
      const fallback = median(finite);
      // Propagate inwards from the sampled region so a cut-off corner becomes a
      // flat apron at its own edge height instead of a cliff to the median.
      for (let iteration = 0; iteration < 96; iteration += 1) {
        let patched = 0;
        for (let iz = 0; iz < rows; iz += 1) {
          for (let ix = 0; ix < cols; ix += 1) {
            const cell = iz * cols + ix;
            if (Number.isFinite(current[cell])) continue;
            let sum = 0;
            let count = 0;
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = ix + dx;
              const nz = iz + dz;
              if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
              const value = current[nz * cols + nx];
              if (Number.isFinite(value)) {
                sum += value;
                count += 1;
              }
            }
            if (count) {
              current[cell] = sum / count;
              patched += 1;
            }
          }
        }
        if (!patched) break;
      }
      for (let index = 0; index < current.length; index += 1) {
        if (!Number.isFinite(current[index])) current[index] = fallback;
      }
    }
  }

  // --- outlier passes -------------------------------------------------------
  let spikes = 0;
  let holes = 0;
  const neighbour = [];
  for (let pass = 0; pass < passes; pass += 1) {
    const next = Float32Array.from(current);
    let patched = 0;
    for (let iz = 1; iz < rows - 1; iz += 1) {
      for (let ix = 1; ix < cols - 1; ix += 1) {
        const cell = iz * cols + ix;
        const value = current[cell];
        if (!Number.isFinite(value)) continue;
        neighbour.length = 0;
        for (let dz = -1; dz <= 1; dz += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dz) continue;
            const candidate = current[(iz + dz) * cols + (ix + dx)];
            if (Number.isFinite(candidate)) neighbour.push(candidate);
          }
        }
        if (neighbour.length < 5) continue;
        neighbour.sort((a, b) => a - b);
        const centre = median(neighbour);
        // Robust spread: the median absolute deviation, scaled by 1.4826 so it
        // reads as a standard deviation on a normal sample. max-min would not
        // do — a spike and a hole sitting next to each other inflate it enough
        // to grant one another immunity, which is exactly the pair this filter
        // exists to remove. A real cliff, by contrast, has *most* of its
        // neighbours spread across it, so its MAD is large and it survives.
        const deviations = neighbour.map((candidate) => Math.abs(candidate - centre)).sort((a, b) => a - b);
        const spread = Math.min(maxTolerance / Math.max(0.1, spreadFactor), 1.4826 * median(deviations));
        const tolerance = Math.max(minTolerance, Math.min(maxTolerance, spreadFactor * spread));
        const delta = value - centre;
        if (Math.abs(delta) <= tolerance) continue;
        next[cell] = centre;
        patched += 1;
        // Only the first pass is counted, so the reported numbers describe the
        // grid that was shipped rather than the filter's own later corrections.
        if (pass === 0) {
          if (delta > 0) spikes += 1;
          else holes += 1;
        }
      }
    }
    current = next;
    if (!patched) break;
  }

  // --- slope limiter -------------------------------------------------------
  // Relative filtering keeps consistent terrain, which is right for cliffs and
  // wrong for a bake seam: where the far-terrain sheet crosses the near grid the
  // height jumps ~38 m in one cell and *every* neighbour agrees with the jump,
  // so no median test flags it. Clamping the per-cell step bounds the slope.
  let steepCells = 0;
  if (maxStep !== null && maxStep > 0) {
    for (let pass = 0; pass < (stepPasses ?? passes); pass += 1) {
      const next = Float32Array.from(current);
      let patched = 0;
      for (let iz = 1; iz < rows - 1; iz += 1) {
        for (let ix = 1; ix < cols - 1; ix += 1) {
          const cell = iz * cols + ix;
          const value = current[cell];
          if (!Number.isFinite(value)) continue;
          neighbour.length = 0;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const candidate = current[(iz + dz) * cols + (ix + dx)];
            if (Number.isFinite(candidate)) neighbour.push(candidate);
          }
          if (neighbour.length < 3) continue;
          neighbour.sort((a, b) => a - b);
          const centre = median(neighbour);
          const delta = value - centre;
          if (Math.abs(delta) <= maxStep) continue;
          next[cell] = centre + Math.sign(delta) * maxStep;
          patched += 1;
          if (pass === 0) steepCells += 1;
        }
      }
      current = next;
      if (!patched) break;
    }
  }

  return { values: current, spikes, holes, sentinelCells, steepCells };
}

/**
 * Bilinear sampler for a height grid, clamped to the grid edge.
 *
 * @param {{cols: number, rows: number, cellSize: number, origin: number[]}} terrain
 * @param {ArrayLike<number>} heights
 * @returns {(x: number, z: number) => number}
 */
export function createHeightSampler(terrain, heights) {
  const { cols, rows, cellSize, origin } = terrain;
  const at = (cx, cz) => heights[cz * cols + cx];
  return (x, z) => {
    const fx = (x - origin[0]) / cellSize;
    const fz = (z - origin[2]) / cellSize;
    const ix = Math.max(0, Math.min(cols - 2, Math.floor(fx)));
    const iz = Math.max(0, Math.min(rows - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - ix));
    const tz = Math.max(0, Math.min(1, fz - iz));
    return (at(ix, iz) * (1 - tx) + at(ix + 1, iz) * tx) * (1 - tz)
      + (at(ix, iz + 1) * (1 - tx) + at(ix + 1, iz + 1) * tx) * tz;
  };
}

/**
 * Row-major matrix for a cannon-es `Heightfield`, which lives in the local X/Y
 * plane with heights along +Z: `data[i][j]` maps to (x = i, y = j). Rotating the
 * body -90° about X turns local +Z into world +Y and local +Y into world -Z, so
 * the rows are flipped here.
 */
export function heightfieldMatrix(heights, cols, rows) {
  const matrix = [];
  for (let i = 0; i < cols; i += 1) {
    const column = new Array(rows);
    for (let j = 0; j < rows; j += 1) {
      column[j] = heights[(rows - 1 - j) * cols + i];
    }
    matrix.push(column);
  }
  return matrix;
}
