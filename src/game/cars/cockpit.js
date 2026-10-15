/**
 * Cockpit geometry, shared by the asset pipeline (which bakes it into the car
 * manifest as `cockpit`) and the runtime (which falls back to the same estimate
 * for manifests written before the field existed). Pure math, no three.js.
 *
 * Game space: metres, origin on the road under the car, front = -Z, up = +Y.
 */

/** Eigen-decomposition of a symmetric 3x3 matrix (cyclic Jacobi). */
function jacobiEigen(matrix) {
  const a = matrix.map((row) => row.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep += 1) {
    let off = 0;
    for (let p = 0; p < 3; p += 1) for (let q = p + 1; q < 3; q += 1) off += a[p][q] ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < 3; p += 1) {
      for (let q = p + 1; q < 3; q += 1) {
        if (Math.abs(a[p][q]) < 1e-20) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k += 1) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k += 1) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k += 1) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return [0, 1, 2]
    .map((index) => ({ value: a[index][index], vector: [v[0][index], v[1][index], v[2][index]] }))
    .sort((left, right) => left.value - right.value);
}

/**
 * Steering column axis from the steering wheel's vertices: the rim is a disc,
 * so its normal is the direction of least variance. Oriented towards the driver
 * (+Z, behind the wheel) so a positive rotation about it turns the rim left.
 */
export function steeringColumnAxis(points) {
  if (!points?.length) return null;
  const mean = [0, 0, 0];
  for (const point of points) for (let axis = 0; axis < 3; axis += 1) mean[axis] += point[axis] / points.length;
  const covariance = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const point of points) {
    const d = [point[0] - mean[0], point[1] - mean[1], point[2] - mean[2]];
    for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) covariance[row][column] += d[row] * d[column];
  }
  const [smallest] = jacobiEigen(covariance);
  let axis = smallest.vector;
  if (axis[2] < 0) axis = axis.map((value) => -value);
  const length = Math.hypot(...axis) || 1;
  return { center: mean, axis: axis.map((value) => value / length) };
}

const round = (values) => values.map((value) => Number(value.toFixed(3)));
/** A typical column rake: ~22° up from horizontal, pointing back at the driver. */
const DEFAULT_COLUMN = [0, Math.sin((22 * Math.PI) / 180), Math.cos((22 * Math.PI) / 180)];

/**
 * Driver-head anchor (camera eye point) and steering wheel anchor.
 *
 * With a real steering wheel node, the head sits ~0.44 m back along the column
 * and a little above it — the wheel's own position decides LHD vs RHD. Without
 * one, both are estimated from the body: driver on `driverSide`, eyes ~84% of
 * the roof height, cabin at ~43% of the length from the nose.
 */
export function computeCockpit({ bounds, steering = null, driverSide = 'left' }) {
  const min = bounds.min;
  const max = bounds.max;
  const width = max[0] - min[0];
  const height = max[1] - min[1];
  const length = max[2] - min[2];
  if (steering?.center && steering?.axis) {
    const { center, axis } = steering;
    const head = [
      center[0] + axis[0] * 0.44,
      Math.min(max[1] - 0.1, center[1] + axis[1] * 0.44 + 0.1),
      center[2] + axis[2] * 0.44,
    ];
    return {
      source: 'steering-node',
      driverSide: center[0] >= 0 ? 'right' : 'left',
      head: round(head),
      steeringWheel: { center: round(center), axis: round(axis), radius: 0.18 },
    };
  }
  const side = driverSide === 'right' ? 1 : -1;
  const head = [side * width * 0.18, min[1] + height * 0.84, min[2] + length * 0.43];
  const center = [head[0], head[1] - 0.2, head[2] - 0.42];
  return {
    source: 'estimate',
    driverSide: side > 0 ? 'right' : 'left',
    head: round(head),
    steeringWheel: { center: round(center), axis: round(DEFAULT_COLUMN), radius: 0.17 },
  };
}
