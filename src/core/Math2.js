/**
 * Small deterministic maths helpers shared by the simulation.
 *
 * The simulation is 2.5D: athletes live on the water plane (x, z) plus a vertical
 * elevation channel driven by the eggbeater. The ball is fully three dimensional.
 * Keeping the athlete maths in a tiny 2-vector avoids allocating THREE.Vector3s
 * sixteen times per frame per player.
 */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : clamp01((v - a) / (b - a)));
export const smoothstep = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
export const TAU = Math.PI * 2;

/** Shortest signed angular difference from a to b, in (-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Rotate `from` toward `to` by at most `maxStep` radians. */
export function turnToward(from, to, maxStep) {
  const d = angleDelta(from, to);
  if (Math.abs(d) <= maxStep) return to;
  return from + Math.sign(d) * maxStep;
}

/** Exponential smoothing that is stable regardless of frame time. */
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export class Vec2 {
  constructor(x = 0, z = 0) {
    this.x = x;
    this.z = z;
  }
  set(x, z) { this.x = x; this.z = z; return this; }
  copy(v) { this.x = v.x; this.z = v.z; return this; }
  clone() { return new Vec2(this.x, this.z); }
  add(v) { this.x += v.x; this.z += v.z; return this; }
  addScaled(v, s) { this.x += v.x * s; this.z += v.z * s; return this; }
  sub(v) { this.x -= v.x; this.z -= v.z; return this; }
  scale(s) { this.x *= s; this.z *= s; return this; }
  length() { return Math.hypot(this.x, this.z); }
  lengthSq() { return this.x * this.x + this.z * this.z; }
  normalize() {
    const l = this.length();
    if (l > 1e-6) { this.x /= l; this.z /= l; }
    return this;
  }
  angle() { return Math.atan2(this.x, this.z); }
  setFromAngle(a, len = 1) { this.x = Math.sin(a) * len; this.z = Math.cos(a) * len; return this; }
  dot(v) { return this.x * v.x + this.z * v.z; }
  /** 2D cross product (scalar): positive when v is to the left of this. */
  cross(v) { return this.z * v.x - this.x * v.z; }
}

export function dist2(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
export function distSq2(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/**
 * Deterministic PRNG (mulberry32). Every stochastic outcome in the simulation
 * draws from a seeded stream so replays and network sessions reproduce exactly
 * (section 41: "random seeds where randomness exists").
 */
export class Rng {
  constructor(seed = 0x9e3779b9) {
    this.seed = seed >>> 0;
    this._s = this.seed;
    this.calls = 0;
  }
  next() {
    this.calls++;
    this._s = (this._s + 0x6d2b79f5) >>> 0;
    let t = this._s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + this.next() * (b - a); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  /** Approximately normal via the sum of three uniforms; cheap and bounded. */
  gauss(mean = 0, sd = 1) {
    const u = (this.next() + this.next() + this.next()) / 3;
    return mean + (u - 0.5) * 3.4641 * sd;
  }
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  fork(salt) { return new Rng((this._s ^ Math.imul(salt | 1, 0x85ebca6b)) >>> 0); }
  reset() { this._s = this.seed; this.calls = 0; }
}

/**
 * Closest point on segment ab to point p, and the distance. Used for passing lane
 * interception checks and for the referee sightline test.
 */
export function segmentPointDistance(ax, az, bx, bz, px, pz) {
  const abx = bx - ax, abz = bz - az;
  const apx = px - ax, apz = pz - az;
  const denom = abx * abx + abz * abz;
  const t = denom < 1e-9 ? 0 : clamp01((apx * abx + apz * abz) / denom);
  const cx = ax + abx * t, cz = az + abz * t;
  return { t, x: cx, z: cz, dist: Math.hypot(px - cx, pz - cz) };
}
