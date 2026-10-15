/**
 * Wheel clustering for imported GLB cars.
 *
 * Source models use wildly different naming (`wheel_rf_dummy` / `wheel_rf`,
 * `Object_26`, French accents), so we never trust names alone: candidate nodes
 * come from bounding-box shape (a disc: two similar large axes, one small one),
 * then rotate/spin pivots are derived per corner.
 *
 * Pure math over plain descriptors so `npm test` covers it and so the offline
 * asset pipeline and the runtime rig share exactly one implementation.
 *
 * Descriptor shape (all values in final, normalized car space):
 *   { name, min: [x,y,z], max: [x,y,z], center: [x,y,z], size: [x,y,z],
 *     radius, width, wheelish: boolean, ancestorIds?: Array<number|string> }
 */

const EPSILON = 1e-6;

export function descriptorFromBounds({ name = '', min, max, wheelish = false, id = name, ancestorIds = [] }) {
  const center = [0, 1, 2].map((axis) => (min[axis] + max[axis]) / 2);
  const size = [0, 1, 2].map((axis) => Math.max(0, max[axis] - min[axis]));
  const sorted = [...size].sort((a, b) => b - a);
  const [largest, middle, smallest] = sorted;
  const axleAxis = size.indexOf(smallest);
  const discLike = largest > EPSILON
    && smallest / largest < 0.66
    && Math.abs(largest - middle) / largest < 0.3;
  return {
    id,
    name,
    min,
    max,
    center,
    size,
    radius: Math.max(largest, middle) / 2,
    width: smallest,
    axleAxis,
    wheelish: Boolean(wheelish),
    discLike,
    ancestorIds,
  };
}

/**
 * Estimates the wheel radius as the tightest radius cluster among disc-shaped
 * candidates. Real wheels are the most-repeated disc size on a car (four of
 * them), which beats any single name heuristic: this model reuses wheel
 * *material* names on doors, so names alone are unreliable.
 */
export function estimateWheelRadius(candidates, modelWidth) {
  const pool = candidates
    .filter((candidate) => candidate.discLike
      && candidate.radius > Math.max(0.03, modelWidth * 0.02)
      && candidate.radius < modelWidth * 0.4
      && !overlapsCenterline(candidate, modelWidth))
    .map((candidate) => candidate.radius)
    .sort((a, b) => a - b);
  if (!pool.length) return null;

  let best = { count: 0, radius: null };
  for (const radius of pool) {
    const members = pool.filter((value) => Math.abs(value - radius) / radius <= 0.18);
    if (members.length > best.count) {
      best = { count: members.length, radius: members[Math.floor(members.length / 2)] };
    }
  }
  return best.radius === null ? null : { radius: best.radius, support: best.count, pool: pool.length };
}

function overlapsCenterline(candidate, modelWidth) {
  const span = candidate.max[0] - candidate.min[0];
  const tolerance = Math.max(0.02, modelWidth * 0.02);
  return candidate.min[0] < -tolerance && candidate.max[0] > tolerance && span > modelWidth * 0.25;
}

export function scoreWheelCandidate(candidate, { modelWidth = 0, expectedRadius = null, context = null } = {}) {
  let score = 0;
  if (candidate.wheelish) score += 3;
  if (candidate.discLike) score += 1.5;
  if (candidate.axleAxis === 0) score += 1;
  if (candidate.radius < 0.05 || candidate.radius > 0.9) return -Infinity;
  if (overlapsCenterline(candidate, modelWidth)) return -Infinity;
  if (expectedRadius) {
    const ratio = candidate.radius / expectedRadius;
    if (ratio < 0.45 || ratio > 2.4) return -Infinity;
    score += 2 - Math.abs(Math.log(ratio)) * 2;
  }
  if (context) {
    // Wheels live in a horizontal band near the bottom of the car.
    const relativeY = (candidate.center[1] - context.groundY) / Math.max(0.1, context.height);
    if (relativeY > 0.55) return -Infinity;
    score += 1 - relativeY;
    // ...and near the extreme X positions of the model.
    const lateral = Math.abs(candidate.center[0]) / Math.max(0.1, context.halfWidth);
    if (lateral < 0.45) score -= 1.5;
    else score += lateral;
  }
  return score;
}

/**
 * Groups candidates into up to four wheel corners.
 *
 * Wheels are the only parts of a car that exist as mirrored left/right pairs of
 * equal-size discs, so pairs are matched first: that survives the messy naming
 * and stray disc-like parts (brake glow meshes, exhaust tips, roof scoops) that
 * fooled the earlier per-quadrant clustering.
 */
export function clusterWheels(candidates, {
  modelWidth = 0,
  modelCenterX = 0,
  groundY = 0,
  height = 1,
  expectedRadius = null,
  axleAxis = 0,
} = {}) {
  const context = { groundY, height, halfWidth: Math.max(0.1, modelWidth / 2) };
  const estimate = expectedRadius ? { radius: expectedRadius, support: 0, pool: 0 } : estimateWheelRadius(candidates, modelWidth);
  const targetRadius = estimate?.radius ?? null;
  const scored = candidates
    .map((candidate) => ({ candidate, score: scoreWheelCandidate(candidate, { modelWidth, expectedRadius: targetRadius, context }) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score);

  // Only candidates close to the estimated wheel radius may form a wheel pair;
  // rims, brake discs and mud flaps are absorbed afterwards.
  const pairCandidates = targetRadius
    ? scored.filter((entry) => Math.abs(entry.candidate.radius - targetRadius) / targetRadius <= 0.35)
    : scored;

  const mirrorTolerance = Math.max(0.03, modelWidth * 0.06);
  const pairs = [];
  for (let left = 0; left < pairCandidates.length; left += 1) {
    for (let right = left + 1; right < pairCandidates.length; right += 1) {
      const a = pairCandidates[left].candidate;
      const b = pairCandidates[right].candidate;
      if (Math.sign(a.center[0] - modelCenterX) === Math.sign(b.center[0] - modelCenterX)) continue;
      const mirroredX = Math.abs((a.center[0] - modelCenterX) + (b.center[0] - modelCenterX));
      if (mirroredX > mirrorTolerance) continue;
      const radiusRatio = Math.max(a.radius, b.radius) / Math.max(1e-4, Math.min(a.radius, b.radius));
      if (radiusRatio > 1.18) continue;
      const zDelta = Math.abs(a.center[2] - b.center[2]);
      if (zDelta > Math.max(0.05, height * 0.25)) continue;
      pairs.push({
        a,
        b,
        score: pairCandidates[left].score + pairCandidates[right].score - mirroredX * 2 - (radiusRatio - 1) * 4 - zDelta,
        radius: Math.max(a.radius, b.radius),
        z: (a.center[2] + b.center[2]) / 2,
      });
    }
  }
  pairs.sort((left, right) => right.score - left.score);

  // Keep the best pair per end of the car, and never reuse a candidate.
  const used = new Set();
  const chosen = [];
  for (const pair of pairs) {
    if (used.has(pair.a.id) || used.has(pair.b.id)) continue;
    const end = pair.z <= 0 ? 'front' : 'rear';
    const sign = pair.a.center[0] - modelCenterX >= 0 ? 'right' : 'left';
    if (chosen.some((entry) => entry.end === end && entry.sign === sign)) continue;
    chosen.push({ ...pair, end, sign });
    used.add(pair.a.id);
    used.add(pair.b.id);
    if (chosen.length === 4) break;
  }

  // Fall back to per-quadrant clustering when the model has no clean pairs
  // (single-mesh cars, asymmetric imports).
  if (chosen.length < 2) {
    return clusterByQuadrant(scored, { modelWidth, modelCenterX, axleAxis });
  }

  const wheels = [];
  for (const entry of chosen) {
    const members = [entry.a, entry.b];
    // Absorb same-side duplicates that sit on the same hub (rim, tyre, brake
    // discs are separate meshes at nearly the same position).
    for (const { candidate } of scored) {
      if (used.has(candidate.id)) continue;
      if (candidate.radius < entry.radius * 0.3) continue;
      const sameSide = Math.sign(candidate.center[0] - modelCenterX) === Math.sign(entry.a.center[0] - modelCenterX);
      const sameHub = Math.abs(Math.abs(candidate.center[0]) - Math.abs(entry.a.center[0])) < mirrorTolerance * 2
        && Math.abs(candidate.center[2] - entry.z) < Math.max(0.06, height * 0.3);
      if (!sameSide || !sameHub) continue;
      members.push(candidate);
      used.add(candidate.id);
    }

    const ids = new Set(members.map((member) => member.id));
    const roots = members.filter((member) => !(member.ancestorIds ?? []).some((ancestor) => ids.has(ancestor)));
    const center = [0, 0, 0];
    let weightSum = 0;
    for (const member of members) {
      const weight = Math.max(member.radius * member.radius, 0.0001);
      weightSum += weight;
      for (let axis = 0; axis < 3; axis += 1) center[axis] += member.center[axis] * weight;
    }
    for (let axis = 0; axis < 3; axis += 1) center[axis] /= weightSum || 1;

    wheels.push({
      corner: `${entry.end}-${entry.sign}`,
      center,
      radius: Math.max(...members.map((member) => member.radius)),
      width: Math.max(...members.map((member) => member.width)),
      axleAxis,
      members: roots.map((member) => member.id),
      memberNames: roots.map((member) => member.name),
      allMemberCount: members.length,
      source: members.some((member) => member.wheelish) ? 'name+shape' : 'shape',
      confidence: Number(Math.min(1, members.length / 3).toFixed(2)),
    });
  }

  return summarizeWheels(wheels, estimate);
}

function clusterByQuadrant(scored, { modelWidth, modelCenterX, axleAxis }) {
  const corners = new Map([
    ['front-left', []],
    ['front-right', []],
    ['rear-left', []],
    ['rear-right', []],
  ]);
  for (const { candidate } of scored) {
    const side = candidate.center[0] - modelCenterX >= 0 ? 'right' : 'left';
    const end = candidate.center[2] <= 0 ? 'front' : 'rear';
    corners.get(`${end}-${side}`).push(candidate);
  }

  const wheels = [];
  for (const [corner, members] of corners) {
    if (!members.length) continue;
    const largest = Math.max(...members.map((member) => member.radius));
    const pool = members.filter((member) => member.radius >= largest * 0.6);
    const ids = new Set(pool.map((member) => member.id));
    const roots = pool.filter((member) => !(member.ancestorIds ?? []).some((ancestor) => ids.has(ancestor)));
    const center = [0, 0, 0];
    let weightSum = 0;
    for (const member of pool) {
      const weight = Math.max(member.radius * member.radius, 0.0001);
      weightSum += weight;
      for (let axis = 0; axis < 3; axis += 1) center[axis] += member.center[axis] * weight;
    }
    for (let axis = 0; axis < 3; axis += 1) center[axis] /= weightSum || 1;
    wheels.push({
      corner,
      center,
      radius: largest,
      width: Math.max(...pool.map((member) => member.width)),
      axleAxis,
      members: roots.map((member) => member.id),
      memberNames: roots.map((member) => member.name),
      allMemberCount: pool.length,
      source: pool.some((member) => member.wheelish) ? 'name+shape' : 'shape',
      confidence: Number(Math.min(1, pool.length / 2).toFixed(2)),
    });
  }
  return summarizeWheels(wheels);
}

function summarizeWheels(wheels, estimate = null) {
  wheels.sort((a, b) => (a.corner < b.corner ? -1 : 1));
  const front = wheels.filter((wheel) => wheel.corner.startsWith('front'));
  const rear = wheels.filter((wheel) => wheel.corner.startsWith('rear'));
  const average = (list, axis) => (list.length ? list.reduce((sum, wheel) => sum + wheel.center[axis], 0) / list.length : null);
  const wheelbase = front.length && rear.length ? average(rear, 2) - average(front, 2) : null;
  const track = wheels.length >= 2
    ? Math.max(...wheels.map((wheel) => wheel.center[0])) - Math.min(...wheels.map((wheel) => wheel.center[0]))
    : null;

  return {
    wheels,
    radiusEstimate: estimate ? { radius: Number(estimate.radius.toFixed(3)), support: estimate.support, pool: estimate.pool } : null,
    complete: wheels.length === 4,
    wheelbase: wheelbase === null ? null : Number(wheelbase.toFixed(3)),
    track: track === null ? null : Number(track.toFixed(3)),
    radius: wheels.length ? Number((wheels.reduce((sum, wheel) => sum + wheel.radius, 0) / wheels.length).toFixed(3)) : null,
    frontZ: front.length ? Number(average(front, 2).toFixed(3)) : null,
    rearZ: rear.length ? Number(average(rear, 2).toFixed(3)) : null,
  };
}
