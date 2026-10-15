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
 * Groups candidates into up to four wheel corners and returns pivot/radius data.
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
  const scored = candidates
    .map((candidate) => ({ candidate, score: scoreWheelCandidate(candidate, { modelWidth, expectedRadius, context }) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score);

  const corners = new Map([
    ['front-left', []],
    ['front-right', []],
    ['rear-left', []],
    ['rear-right', []],
  ]);

  for (const entry of scored) {
    const { candidate } = entry;
    const side = candidate.center[0] - modelCenterX >= 0 ? 'right' : 'left';
    const end = candidate.center[2] <= 0 ? 'front' : 'rear';
    corners.get(`${end}-${side}`).push(candidate);
  }

  const wheels = [];
  for (const [corner, members] of corners) {
    if (!members.length) continue;
    const radii = members.map((member) => member.radius);
    const targetRadius = expectedRadius ?? radii[0];
    // Prefer the largest member that is close to a real wheel radius: it is the
    // one that carries the tread.
    const wheelMembers = members.filter((member) => member.radius >= targetRadius * 0.55);
    const pool = wheelMembers.length ? wheelMembers : members;

    let weightSum = 0;
    const center = [0, 0, 0];
    let radius = 0;
    let width = 0;
    for (const member of pool) {
      const weight = Math.max(member.radius * member.radius, 0.0001);
      weightSum += weight;
      for (let axis = 0; axis < 3; axis += 1) center[axis] += member.center[axis] * weight;
      radius = Math.max(radius, member.radius);
      width = Math.max(width, member.width);
    }
    for (let axis = 0; axis < 3; axis += 1) center[axis] /= weightSum || 1;

    // Drop members that are ancestors of other members: attaching a parent and
    // its child to the same pivot would double-transform the child.
    const ids = new Set(pool.map((member) => member.id));
    const roots = pool.filter((member) => !(member.ancestorIds ?? []).some((ancestor) => ids.has(ancestor)));

    wheels.push({
      corner,
      center,
      radius,
      width,
      axleAxis,
      members: roots.map((member) => member.id),
      memberNames: roots.map((member) => member.name),
      allMemberCount: pool.length,
      source: pool.some((member) => member.wheelish) ? 'name+shape' : 'shape',
      confidence: Number(Math.min(1, pool.length / 2).toFixed(2)),
    });
  }

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
    complete: wheels.length === 4,
    wheelbase: wheelbase === null ? null : Number(wheelbase.toFixed(3)),
    track: track === null ? null : Number(track.toFixed(3)),
    radius: wheels.length ? Number((wheels.reduce((sum, wheel) => sum + wheel.radius, 0) / wheels.length).toFixed(3)) : null,
    frontZ: front.length ? Number(average(front, 2).toFixed(3)) : null,
    rearZ: rear.length ? Number(average(rear, 2).toFixed(3)) : null,
  };
}
