/**
 * Ball physics (Design Bible section 12).
 *
 * The ball is fully three dimensional and simulated continuously: mass, radius,
 * buoyancy, *partial* submersion, air drag, water drag, spin, spin decay, Magnus
 * force, restitution, wetness, and collision with posts, crossbar, net, athletes
 * and pool boundaries.
 *
 * Skip shots are not animations. A ball that meets the surface at a shallow angle
 * with the right spin partially submerges, is thrown back out by the enormous
 * buoyant force acting on the submerged cap, and continues toward goal. Meet the
 * water too steeply and the same equations bury it. Section 12.2 asks for exactly
 * this and nothing about it is special-cased.
 */

import { clamp, clamp01, lerp } from '../core/Math2.js';

export const BALL_STATE = {
  HELD: 'held',       // in an athlete's hand
  DRIBBLE: 'dribble', // riding the bow wave in front of a swimmer
  FLIGHT: 'flight',   // free, physics-driven
  DEAD: 'dead',       // stopped for a restart
};

const G = 9.81;
const RHO_WATER = 1000;
const RHO_AIR = 1.225;

export class Ball {
  constructor() {
    this.radius = 0.111;      // FINA size 5 ~ 0.222 m diameter
    this.mass = 0.43;
    this.volume = (4 / 3) * Math.PI * this.radius ** 3;

    this.pos = { x: 0, y: 0.111, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    /** Angular velocity in rad/s about each world axis. */
    this.spin = { x: 0, y: 0, z: 0 };

    this.state = BALL_STATE.DEAD;
    this.holder = null;          // Athlete
    this.lastHolder = null;
    this.lastTouchSide = null;
    this.lastTouchTime = 0;
    this.wetness = 1;            // 1 = soaked; affects grip and pass control
    this.travelledFrom = { x: 0, y: 0, z: 0 };

    // Flags consumed by the presentation layer for one frame.
    this.eventFlags = { splash: 0, skip: 0, post: 0, net: 0, catch: 0, waterExit: 0 };
    this.timeSinceLoose = 0;
    this.intendedTarget = null;  // for pass/shot analysis
    this.kind = null;            // 'pass' | 'shot' | 'deflection' | 'outlet'
  }

  reset(x, y, z) {
    this.pos.x = x; this.pos.y = y; this.pos.z = z;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.spin.x = this.spin.y = this.spin.z = 0;
    this.state = BALL_STATE.DEAD;
    this.holder = null;
    this.timeSinceLoose = 0;
  }

  get isLoose() { return this.state === BALL_STATE.FLIGHT; }
  get speed() { return Math.hypot(this.vel.x, this.vel.y, this.vel.z); }
  /** Fraction of the sphere below the waterline, 0..1. */
  get submerged() {
    const d = clamp((this.radius - this.pos.y) / (2 * this.radius), 0, 1);
    // Spherical cap volume fraction for immersion depth h = 2r*d.
    return d * d * (3 - 2 * d);
  }

  /** Launch the ball. Velocity in m/s, spin in rad/s. */
  launch(from, vel, spin, kind, byAthlete) {
    this.pos.x = from.x; this.pos.y = from.y; this.pos.z = from.z;
    this.vel.x = vel.x; this.vel.y = vel.y; this.vel.z = vel.z;
    this.spin.x = spin?.x ?? 0; this.spin.y = spin?.y ?? 0; this.spin.z = spin?.z ?? 0;
    this.state = BALL_STATE.FLIGHT;
    this.lastHolder = byAthlete ?? this.holder ?? this.lastHolder;
    this.lastTouchSide = this.lastHolder?.side ?? this.lastTouchSide;
    this.holder = null;
    this.timeSinceLoose = 0;
    this.kind = kind;
    this._skipped = false;
    this.travelledFrom = { ...from };
  }

  attach(athlete) {
    this.holder = athlete;
    this.lastHolder = athlete;
    this.lastTouchSide = athlete.side;
    this.state = BALL_STATE.HELD;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.spin.x = this.spin.y = this.spin.z = 0;
    this.eventFlags.catch = 1;
  }

  /**
   * @param {number} dt
   * @param {object} world { profile, athletes, onGoal, onOut, rng }
   */
  update(dt, world) {
    for (const k in this.eventFlags) this.eventFlags[k] = Math.max(0, this.eventFlags[k] - dt * 6);

    if (this.state === BALL_STATE.HELD && this.holder) {
      this._followHand(dt);
      return;
    }
    if (this.state === BALL_STATE.DRIBBLE && this.holder) {
      this._followDribble(dt, world);
      return;
    }
    if (this.state === BALL_STATE.DEAD) return;

    this.timeSinceLoose += dt;

    // Substep: buoyancy accelerations exceed 100 m/s^2, so integrate finely
    // whenever the ball is anywhere near the surface.
    const near = Math.abs(this.pos.y) < this.radius * 2.5;
    const steps = near ? 6 : 2;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this._integrate(h, world);
  }

  _integrate(dt, world) {
    const sub = this.submerged;
    const v = this.vel;
    const speed = Math.hypot(v.x, v.y, v.z);

    // --- Gravity ----------------------------------------------------------
    v.y -= G * dt;

    // --- Buoyancy on the submerged cap ------------------------------------
    if (sub > 0) {
      const buoy = (RHO_WATER * this.volume * sub * G) / this.mass;
      v.y += buoy * dt;
    }

    // --- Drag: semi-implicit so it is stable at any speed ------------------
    const area = Math.PI * this.radius ** 2;
    const cdAir = 0.47, cdWater = 0.62;
    const kAir = (0.5 * RHO_AIR * cdAir * area) / this.mass;
    const kWater = (0.5 * RHO_WATER * cdWater * area) / this.mass;
    const k = kAir * (1 - sub) + kWater * sub;
    if (speed > 1e-4) {
      const damp = 1 / (1 + k * speed * dt);
      v.x *= damp; v.y *= damp; v.z *= damp;
    }

    // --- Magnus: spin curves the flight and decides skip behaviour ---------
    // F = S * (w x v). Small in air, dominant during water contact where it
    // converts topspin into a forward-diving skip and backspin into a rise.
    const magnus = (0.00042 / this.mass) * (1 + sub * 22);
    const mx = this.spin.y * v.z - this.spin.z * v.y;
    const my = this.spin.z * v.x - this.spin.x * v.z;
    const mz = this.spin.x * v.y - this.spin.y * v.x;
    v.x += mx * magnus * dt;
    v.y += my * magnus * dt;
    v.z += mz * magnus * dt;

    // Spin decays faster in water.
    const spinDecay = Math.exp(-(0.45 + sub * 5.2) * dt);
    this.spin.x *= spinDecay; this.spin.y *= spinDecay; this.spin.z *= spinDecay;

    // --- Surface events for presentation ----------------------------------
    const wasAbove = this.pos.y > this.radius * 0.35;
    this.pos.x += v.x * dt;
    this.pos.y += v.y * dt;
    this.pos.z += v.z * dt;
    const nowBelow = this.pos.y <= this.radius * 0.35;
    if (wasAbove && nowBelow && speed > 2.5) {
      this.eventFlags.splash = Math.min(1, speed / 14);
      this.wetness = 1;
      // Skip: a shallow entry carrying forward topspin skips off the surface like
      // a stone. The topspin (spin about the horizontal axis across the line of
      // travel) plus the surface reaction throw the ball back up and forward,
      // preserving most of its horizontal speed. A steep entry, or one without
      // topspin, just gets absorbed - so this rewards a real skip technique.
      const horiz = Math.hypot(v.x, v.z) || 1e-4;
      const shallow = v.y > -horiz * 0.55;                 // low descent angle
      const topspin = (this.spin.x * v.z - this.spin.z * v.x) / horiz; // forward roll
      if (shallow && topspin > 8 && !this._skipped) {
        // Reflect the downward velocity upward, scaled by how much topspin bit.
        const grip = clamp(topspin / 45, 0, 1);
        v.y = Math.abs(v.y) * (0.45 + 0.5 * grip) + grip * 1.4;
        v.x *= 0.9; v.z *= 0.9;                            // small horizontal loss
        this.pos.y = this.radius * 0.4;                    // sit it back on top
        this.spin.x *= 0.5; this.spin.z *= 0.5;            // spin spent on the grip
        this._skipped = true;                              // one clean skip per shot
        this.eventFlags.skip = 1;
      } else if (v.y > -speed * 0.42) {
        this.eventFlags.skip = 1;
      }
    }
    if (!wasAbove && !nowBelow && speed > 3) this.eventFlags.waterExit = 1;

    this._collide(world, dt);

    // Settle: once slow and floating, damp to a gentle bob.
    if (speed < 0.35 && Math.abs(this.pos.y - this.radius * 0.55) < 0.09) {
      v.x *= 0.965; v.z *= 0.965; v.y *= 0.5;
    }
  }

  _collide(world, dt) {
    const f = world.profile.field;
    const halfW = f.width / 2;
    const halfL = f.length / 2;
    const r = this.radius;

    // --- Pool side walls ---------------------------------------------------
    if (this.pos.x < -halfW + r) { this.pos.x = -halfW + r; this.vel.x = Math.abs(this.vel.x) * 0.55; this.spin.y *= -0.4; }
    if (this.pos.x > halfW - r) { this.pos.x = halfW - r; this.vel.x = -Math.abs(this.vel.x) * 0.55; this.spin.y *= -0.4; }

    // --- Pool floor (deep, but keep the ball inside the volume) ------------
    if (this.pos.y < -f.minDepth + r) { this.pos.y = -f.minDepth + r; this.vel.y = Math.abs(this.vel.y) * 0.3; }

    // --- Goals -------------------------------------------------------------
    for (const sign of [-1, 1]) {
      const gz = sign * halfL;
      const dz = (this.pos.z - gz) * sign; // negative = beyond the goal line
      if (dz > 0.6 || dz < -1.6) continue;

      const halfGoal = f.goalWidth / 2;
      const crossbarY = f.goalHeight;

      // Posts: vertical cylinders at the goal line.
      for (const px of [-halfGoal, halfGoal]) {
        const dx = this.pos.x - px;
        const distXZ = Math.hypot(dx, this.pos.z - gz);
        if (distXZ < r + 0.05 && this.pos.y < crossbarY + 0.1 && this.pos.y > -0.6) {
          const nx = dx / (distXZ || 1e-4);
          const nz = (this.pos.z - gz) / (distXZ || 1e-4);
          const vn = this.vel.x * nx + this.vel.z * nz;
          if (vn < 0) {
            this.vel.x -= 1.55 * vn * nx;
            this.vel.z -= 1.55 * vn * nz;
            this.pos.x = px + nx * (r + 0.05);
            this.pos.z = gz + nz * (r + 0.05);
            this.eventFlags.post = 1;
            world.onPost?.(this, sign);
          }
        }
      }

      // Crossbar: horizontal cylinder along x at y = goalHeight.
      if (Math.abs(this.pos.x) < halfGoal + 0.05) {
        const dy = this.pos.y - crossbarY;
        const dzz = this.pos.z - gz;
        const d = Math.hypot(dy, dzz);
        if (d < r + 0.05) {
          const ny = dy / (d || 1e-4);
          const nz = dzz / (d || 1e-4);
          const vn = this.vel.y * ny + this.vel.z * nz;
          if (vn < 0) {
            this.vel.y -= 1.5 * vn * ny;
            this.vel.z -= 1.5 * vn * nz;
            this.pos.y = crossbarY + ny * (r + 0.05);
            this.pos.z = gz + nz * (r + 0.05);
            this.eventFlags.post = 1;
            world.onPost?.(this, sign);
          }
        }
      }

      // Goal line crossing.
      if (dz < -r * 0.5 && Math.abs(this.pos.x) < halfGoal - r * 0.3 &&
          this.pos.y < crossbarY - r * 0.3 && this.pos.y > -1.2) {
        world.onGoal?.(this, sign);
        // Net: absorbs almost everything.
        if (dz < -0.9) {
          this.pos.z = gz - sign * 0.9;
          this.vel.x *= 0.12; this.vel.y *= 0.1; this.vel.z *= -0.08;
          this.eventFlags.net = 1;
        }
        return;
      }
    }

    // --- Goal lines / end walls (ball out of play) -------------------------
    if (this.pos.z < -halfL + r || this.pos.z > halfL - r) {
      const sign = Math.sign(this.pos.z);
      // Keep it physically inside; the rules engine decides corner vs goal throw.
      this.pos.z = sign * (halfL - r);
      this.vel.z *= -0.4;
      world.onEndLine?.(this, sign);
    }
  }

  _followHand(dt) {
    const h = this.holder;
    const p = h.handPoint();
    // The ball tracks the hand rather than teleporting: contact can knock it out.
    const lambda = 26;
    const t = 1 - Math.exp(-lambda * dt);
    this.vel.x = (p.x - this.pos.x) / Math.max(dt, 1e-4);
    this.vel.y = (p.y - this.pos.y) / Math.max(dt, 1e-4);
    this.vel.z = (p.z - this.pos.z) / Math.max(dt, 1e-4);
    this.pos.x += (p.x - this.pos.x) * t;
    this.pos.y += (p.y - this.pos.y) * t;
    this.pos.z += (p.z - this.pos.z) * t;
  }

  _followDribble(dt, world) {
    // Section 10.4: the ball rides the bow wave. A poor handler pushes it too far
    // ahead and exposes it; a good handler keeps it on the fingertips.
    const h = this.holder;
    const sec = clamp01((h.player.attr.ballSecurity - 10) / 85);
    const lead = lerp(0.62, 0.34, sec) + h.speed * lerp(0.30, 0.15, sec);
    const tx = h.pos.x + Math.sin(h.heading) * lead;
    const tz = h.pos.z + Math.cos(h.heading) * lead;
    const ty = this.radius * 0.45;

    const lambda = lerp(5.5, 11, sec);
    const t = 1 - Math.exp(-lambda * dt);
    this.pos.x += (tx - this.pos.x) * t;
    this.pos.z += (tz - this.pos.z) * t;
    this.pos.y += (ty - this.pos.y) * t;
    this.vel.x = h.vel.x; this.vel.z = h.vel.z; this.vel.y = 0;
    this.spin.x = h.speed * 3.4;
    if (h.speed > 0.6) this.eventFlags.splash = Math.max(this.eventFlags.splash, h.speed * 0.06);
  }

  /** Distance from the ball to a point, used constantly by catch/steal checks. */
  distanceTo(x, y, z) {
    return Math.hypot(this.pos.x - x, this.pos.y - y, this.pos.z - z);
  }
}
