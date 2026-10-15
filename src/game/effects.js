import * as THREE from 'three';

/**
 * Tyre effects: skid marks and dust.
 *
 * Both are pooled, so a long drift never allocates: skid marks are pre-built
 * quads written into a ring buffer, dust is a single THREE.Points with a fixed
 * particle count. The whole module can be switched off for low tiers.
 */

const SKID_VERTEX = `
  attribute float alpha;
  varying float vAlpha;
  void main() {
    vAlpha = alpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKID_FRAGMENT = `
  varying float vAlpha;
  uniform vec3 color;
  void main() {
    if (vAlpha <= 0.001) discard;
    gl_FragColor = vec4(color, vAlpha);
  }
`;

/** Ring-buffer skid pad strip. */
class SkidMarks {
  constructor({ scene, budget, quality = false }) {
    this.budget = Math.max(0, budget);
    this.alpha = 1;
    this.cursor = 0;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(this.budget * 6 * 3);
    const alphas = new Float32Array(this.budget * 6);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
    geometry.setDrawRange(0, 0);
    const material = new THREE.ShaderMaterial({
      vertexShader: SKID_VERTEX,
      fragmentShader: SKID_FRAGMENT,
      uniforms: { color: { value: new THREE.Color(0x1b1a17) } },
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'skid-marks';
    scene.add(this.mesh);
    this.geometry = geometry;
    this.material = material;
    void quality;
  }

  setOpacity(value) {
    this.alpha = value;
  }

  /** Adds one segment between two contact points (world space). */
  addSegment(left, right, { strength = 1, width = 0.24, color = null } = {}) {
    if (!this.budget) return;
    if (color) this.material.uniforms.color.value.set(color);
    const positions = this.geometry.getAttribute('position');
    const alphas = this.geometry.getAttribute('alpha');
    const index = this.cursor % this.budget;
    const base = index * 6;
    const half = width / 2;
    const lift = 0.012;
    const quad = [
      [left.x, left.y + lift, left.z],
      [right.x, right.y + lift, right.z],
    ];
    const along = new THREE.Vector3().subVectors(right, left).setY(0).normalize();
    const side = new THREE.Vector3(-along.z, 0, along.x).multiplyScalar(half).toArray();
    const corners = [
      [quad[0][0] - side[0], quad[0][1], quad[0][2] - side[2]],
      [quad[0][0] + side[0], quad[0][1], quad[0][2] + side[2]],
      [quad[1][0] - side[0], quad[1][1], quad[1][2] - side[2]],
      [quad[1][0] - side[0], quad[1][1], quad[1][2] - side[2]],
      [quad[0][0] + side[0], quad[0][1], quad[0][2] + side[2]],
      [quad[1][0] + side[0], quad[1][1], quad[1][2] + side[2]],
    ];
    for (const [corner, point] of corners.entries()) {
      positions.setXYZ(base + corner, point[0], point[1], point[2]);
    }
    const alpha = Math.min(1, Math.max(0.1, strength)) * this.alpha;
    for (let corner = 0; corner < 6; corner += 1) alphas.setX(base + corner, alpha);
    positions.needsUpdate = true;
    alphas.needsUpdate = true;
    this.cursor += 1;
    this.geometry.setDrawRange(0, Math.min(this.cursor, this.budget) * 6);
  }

  reset() {
    this.cursor = 0;
    this.geometry.setDrawRange(0, 0);
    this.geometry.getAttribute('alpha').array.fill(0);
    this.geometry.getAttribute('alpha').needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}

const DUST_VERTEX = `
  attribute float size;
  attribute float alpha;
  varying float vAlpha;
  void main() {
    vAlpha = alpha;
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (300.0 / max(1.0, -view.z));
    gl_Position = projectionMatrix * view;
  }
`;

const DUST_FRAGMENT = `
  varying float vAlpha;
  uniform vec3 color;
  uniform float softness;
  void main() {
    vec2 offset = gl_PointCoord - vec2(0.5);
    float distance = length(offset) * 2.0;
    float falloff = smoothstep(1.0, softness, distance);
    if (falloff <= 0.01 || vAlpha <= 0.001) discard;
    gl_FragColor = vec4(color, vAlpha * falloff * 0.55);
  }
`;

/** Single-draw-call dust plume behind the rear wheels. */
class DustParticles {
  constructor({ scene, count, color, softness = 0.25 }) {
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.sizes = new Float32Array(count);
    this.alphas = new Float32Array(count);
    this.velocities = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.cursor = 0;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1));
    this.geometry = geometry;
    this.material = new THREE.ShaderMaterial({
      vertexShader: DUST_VERTEX,
      fragmentShader: DUST_FRAGMENT,
      uniforms: { color: { value: new THREE.Color(color ?? '#a8895f') }, softness: { value: softness } },
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.name = 'tyre-dust';
    scene.add(this.points);
  }

  setColor(color) {
    this.material.uniforms.color.value.set(color);
  }

  emit(origin, velocity, { size = 1.4, life = 1.1, jitter = 0.35 } = {}) {
    const index = this.cursor % this.count;
    this.cursor += 1;
    const offset = index * 3;
    this.positions[offset] = origin.x + (Math.random() - 0.5) * jitter;
    this.positions[offset + 1] = origin.y + Math.random() * jitter * 0.5;
    this.positions[offset + 2] = origin.z + (Math.random() - 0.5) * jitter;
    this.velocities[offset] = velocity.x + (Math.random() - 0.5) * 1.2;
    this.velocities[offset + 1] = Math.abs(velocity.y) * 0.5 + 0.6 + Math.random() * 0.6;
    this.velocities[offset + 2] = velocity.z + (Math.random() - 0.5) * 1.2;
    this.sizes[index] = size * (0.7 + Math.random() * 0.6);
    this.alphas[index] = 0.9;
    this.life[index] = life * (0.7 + Math.random() * 0.6);
  }

  update(deltaTime) {
    const step = Math.min(deltaTime, 0.05);
    let alive = false;
    for (let index = 0; index < this.count; index += 1) {
      if (this.life[index] <= 0) {
        if (this.alphas[index] !== 0) {
          this.alphas[index] = 0;
          alive = true;
        }
        continue;
      }
      alive = true;
      this.life[index] -= step;
      const offset = index * 3;
      this.positions[offset] += this.velocities[offset] * step;
      this.positions[offset + 1] += this.velocities[offset + 1] * step;
      this.positions[offset + 2] += this.velocities[offset + 2] * step;
      this.velocities[offset] *= 1 - 1.4 * step;
      this.velocities[offset + 1] = this.velocities[offset + 1] * (1 - 0.6 * step) + 0.35 * step;
      this.velocities[offset + 2] *= 1 - 1.4 * step;
      this.sizes[index] += 2.6 * step;
      this.alphas[index] = Math.max(0, this.alphas[index] - step * 1.25);
      if (this.life[index] <= 0) this.alphas[index] = 0;
    }
    if (alive) {
      this.geometry.getAttribute('position').needsUpdate = true;
      this.geometry.getAttribute('size').needsUpdate = true;
      this.geometry.getAttribute('alpha').needsUpdate = true;
    }
  }

  reset() {
    this.life.fill(0);
    this.alphas.fill(0);
    this.geometry.getAttribute('alpha').needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.points.removeFromParent();
  }
}

/**
 * Drives both effects from vehicle telemetry. Off-track driving (dirt, grass)
 * throws dust and leaves marks even without a handbrake, which is what makes
 * the forest trail feel loose.
 */
export function createTyreEffects(scene, quality) {
  const skid = quality?.skidMarks === false ? null : new SkidMarks({ scene, budget: quality?.skidMarkBudget ?? 900 });
  const dust = quality?.dustParticles === false
    ? null
    : new DustParticles({ scene, count: quality?.dustParticleCount ?? 320, color: '#a8895f' });

  const previous = new Map();
  let accumulators = new Map();
  let dustAccumulator = 0;

  // Marks go where the tyre meets the ground: the wheel raycast hit point.
  // (They used to sit at the wheel *centre*, ~0.3 m above the road.) A wheel
  // in the air leaves no mark and breaks its strip.
  const contactPoints = (physics) => {
    const points = [];
    for (const [index, wheel] of physics.vehicle.wheelInfos.entries()) {
      const hit = wheel.raycastResult;
      const grounded = Boolean(hit?.hasHit) && (wheel.suspensionForce ?? 0) > 0;
      const source = grounded ? hit.hitPointWorld : wheel.worldTransform.position;
      points.push({
        index,
        grounded,
        position: new THREE.Vector3(source.x, source.y, source.z),
        slip: wheel.sliding ? 1 : 0,
        radius: wheel.radius ?? 0.35,
      });
    }
    return points;
  };

  return {
    skid,
    dust,
    /**
     * @param {object} params
     * @param {object} params.physics vehicle physics
     * @param {object} params.surface active surface preset
     * @param {boolean} params.onTrack whether the car is inside the track bounds
     * @param {object} params.input normalized input
     * @param {number} params.speedKmh
     * @param {number} params.deltaTime seconds
     * @param {number} params.slipAmount 0..1 lateral slip estimate
     */
    update({ physics, surface, onTrack = true, input = {}, speedKmh = 0, deltaTime = 1 / 60, slipAmount = 0 }) {
      const points = contactPoints(physics);
      const handbrake = Boolean(input.handbrake);
      const offTrack = !onTrack;

      // Mark strength: handbrake and lateral slip on tarmac, everything loose
      // on dirt.
      const baseStrength = handbrake
        ? 0.85
        : Math.min(0.75, slipAmount * 0.9 + (offTrack ? surface.offTrackSkid ?? 0.9 : surface.skid ?? 0.5) * 0.35);
      const markStrength = offTrack ? (surface.offTrackSkid ?? 1) * baseStrength : (surface.skid ?? 0.5) * baseStrength;

      if (skid) {
        skid.setOpacity(offTrack ? 0.75 : 1);
        for (const point of points) {
          const key = point.index;
          if (!point.grounded) {
            previous.delete(key);
            continue;
          }
          const last = previous.get(key);
          // The handbrake locks the rear axle: rear tyres mark, fronts only if sliding.
          const rear = point.index >= 2;
          const shouldMark = speedKmh > 6 && ((handbrake && rear) || point.slip || slipAmount > 0.28 || offTrack);
          if (shouldMark && last) {
            const distance = last.distanceTo(point.position);
            const accumulator = (accumulators.get(key) ?? 0) + distance;
            if (accumulator > 0.35) {
              accumulators.set(key, 0);
              skid.addSegment(last.clone(), point.position.clone(), { strength: Math.min(1, markStrength) });
            } else {
              accumulators.set(key, accumulator);
            }
          }
          previous.set(key, point.position.clone());
        }
      }

      if (dust) {
        dust.setColor(offTrack ? surface.offTrackDustColor ?? surface.dustColor : surface.dustColor);
        const dustRate = (offTrack ? (surface.offTrackDust ?? 1) : (surface.dust ?? 0.2)) * (0.4 + Math.min(1, slipAmount) * 1.6);
        dustAccumulator += deltaTime * dustRate * (speedKmh > 8 ? 1 : 0.2);
        const rearPoints = points.filter((point) => point.index >= 2);
        const body = physics.chassisBody;
        const backward = new THREE.Vector3(0, 0, 1)
          .applyQuaternion(new THREE.Quaternion(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w));
        while (dustAccumulator > 0.05) {
          dustAccumulator -= 0.05;
          for (const point of rearPoints) {
            dust.emit(point.position, backward.clone().multiplyScalar(1.2 + Math.random() * 1.6), {
              size: 1.1 + (surface.dust ?? 0.5) * 1.6,
              life: 0.9 + Math.random() * 0.6,
            });
          }
        }
        dust.update(deltaTime);
      }
    },
    reset() {
      previous.clear();
      accumulators = new Map();
      skid?.reset();
      dust?.reset();
    },
    dispose() {
      skid?.dispose();
      dust?.dispose();
    },
  };
}
