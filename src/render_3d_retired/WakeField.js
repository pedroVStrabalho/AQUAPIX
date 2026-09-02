/**
 * Dynamic wake and disturbance field.
 *
 * Section 10.5 separates *gameplay water* from *visual water*. This is the bridge
 * between them: a CPU-side height/energy field covering the pool, splatted from
 * the real simulation state (swimmer position, speed, elevation effort, ball
 * impacts, splashes) and uploaded to the GPU each frame as a texture.
 *
 * The water shader reads it for surface displacement, normal perturbation and
 * foam, so every wake on screen is produced by an athlete who actually swam there
 * and every foam patch marks real turbulence - never decoration painted over poor
 * contact resolution (anti-goal, section 5).
 *
 * Two channels:
 *   R - signed surface displacement (waves, wakes, splash craters)
 *   G - turbulence energy (drives foam and spray density)
 */

import * as THREE from 'three';

export class WakeField {
  /**
   * @param {number} width  pool width in metres (x)
   * @param {number} length pool length in metres (z)
   * @param {number} res    texture resolution per axis
   */
  constructor(width, length, res = 160) {
    this.width = width + 4;
    this.length = length + 4;
    this.res = res;
    this.size = res * res;

    this.height = new Float32Array(this.size);
    this.prev = new Float32Array(this.size);
    this.energy = new Float32Array(this.size);
    this.data = new Float32Array(this.size * 4);

    this.texture = new THREE.DataTexture(this.data, res, res, THREE.RGBAFormat, THREE.FloatType);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;

    this._acc = 0;
  }

  /** World (x,z) to texel coordinates. */
  toTexel(x, z) {
    return {
      i: (x / this.width + 0.5) * (this.res - 1),
      j: (z / this.length + 0.5) * (this.res - 1),
    };
  }

  /** Add a gaussian disturbance. `h` displaces the surface, `e` adds turbulence. */
  splat(x, z, radius, h, e) {
    const { i: ci, j: cj } = this.toTexel(x, z);
    const rTex = Math.max(1, (radius / this.width) * this.res);
    const r2 = rTex * rTex;
    const i0 = Math.max(0, Math.floor(ci - rTex * 2));
    const i1 = Math.min(this.res - 1, Math.ceil(ci + rTex * 2));
    const j0 = Math.max(0, Math.floor(cj - rTex * 2));
    const j1 = Math.min(this.res - 1, Math.ceil(cj + rTex * 2));

    for (let j = j0; j <= j1; j++) {
      const dj = j - cj;
      for (let i = i0; i <= i1; i++) {
        const di = i - ci;
        const d2 = di * di + dj * dj;
        if (d2 > r2 * 4) continue;
        const g = Math.exp(-d2 / r2);
        const idx = j * this.res + i;
        this.height[idx] += h * g;
        this.energy[idx] += e * g;
      }
    }
  }

  /**
   * Advance the field. A damped wave equation spreads the disturbances outward,
   * which is what turns a swimmer's stroke into an expanding ring and a sprint
   * into a trailing wake. Fixed 60 Hz substeps keep it stable at any frame rate.
   */
  update(dt) {
    this._acc += Math.min(dt, 0.1);
    const step = 1 / 60;
    let iterations = 0;
    while (this._acc >= step && iterations < 4) {
      this._acc -= step;
      iterations++;
      this._wave();
    }
    if (iterations) this._upload();
  }

  _wave() {
    const { res, height, prev, energy } = this;
    const damping = 0.972;
    const next = prev; // reuse the previous buffer as scratch
    for (let j = 1; j < res - 1; j++) {
      const row = j * res;
      for (let i = 1; i < res - 1; i++) {
        const idx = row + i;
        const sum =
          height[idx - 1] + height[idx + 1] +
          height[idx - res] + height[idx + res];
        next[idx] = (sum * 0.5 - next[idx]) * damping;
      }
    }
    // Clamp the border so the pool walls reflect rather than leak.
    for (let i = 0; i < res; i++) {
      next[i] = next[res + i] * 0.6;
      next[(res - 1) * res + i] = next[(res - 2) * res + i] * 0.6;
      next[i * res] = next[i * res + 1] * 0.6;
      next[i * res + res - 1] = next[i * res + res - 2] * 0.6;
    }
    this.prev = height;
    this.height = next;

    for (let k = 0; k < this.size; k++) energy[k] *= 0.955;
  }

  _upload() {
    const { data, height, energy, size } = this;
    for (let k = 0; k < size; k++) {
      const o = k * 4;
      data[o] = height[k];
      data[o + 1] = energy[k];
      data[o + 2] = 0;
      data[o + 3] = 1;
    }
    this.texture.needsUpdate = true;
  }

  clear() {
    this.height.fill(0);
    this.prev.fill(0);
    this.energy.fill(0);
    this._upload();
  }
}
