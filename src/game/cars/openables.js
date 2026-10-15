/**
 * Hinge plans for openable body panels (doors, bonnet, boot), shared by the
 * asset pipeline (baked into the manifest as `openables`) and the runtime
 * fallback. Only panels that exist as separate named nodes in the source GLB
 * are ever opened — see OPENABLE_PATTERNS in names.js.
 *
 * Game space: front = -Z, left = -X, up = +Y. Bounds are the panel's box.
 */

const DEG = Math.PI / 180;

/**
 * @param {object} part
 * @param {'door'|'bonnet'|'boot'} part.kind
 * @param {string} part.name   node name (decides swing vs scissor doors)
 * @param {number[]} part.min  panel bounds, game space
 * @param {number[]} part.max
 * @returns {{ hinge: number[], axis: 'x'|'y', angle: number, style: string }}
 */
export function planOpenable({ kind, name = '', min, max }) {
  const centerX = (min[0] + max[0]) / 2;
  const left = centerX < 0;
  const round = (values) => values.map((value) => Number(value.toFixed(3)));
  if (kind === 'door') {
    if (/^detach_door/i.test(name)) {
      // Lamborghini-style scissor door: hinged at the front-lower corner of the
      // panel, swinging up about the car's lateral axis.
      return { style: 'scissor', axis: 'x', angle: -68 * DEG, hinge: round([centerX, min[1] + (max[1] - min[1]) * 0.35, min[2]]) };
    }
    // Conventional door: vertical hinge on the front edge, outer face.
    return {
      style: 'swing',
      axis: 'y',
      angle: (left ? -1 : 1) * 62 * DEG,
      hinge: round([left ? min[0] : max[0], (min[1] + max[1]) / 2, min[2]]),
    };
  }
  if (kind === 'bonnet') {
    // Hinged at the rear edge, by the windscreen; the front edge lifts.
    return { style: 'bonnet', axis: 'x', angle: 55 * DEG, hinge: round([centerX, max[1], max[2]]) };
  }
  // Boot / tailgate / engine cover: hinged at the front-top edge; the rear lifts.
  return { style: 'boot', axis: 'x', angle: -72 * DEG, hinge: round([centerX, max[1], min[2]]) };
}
