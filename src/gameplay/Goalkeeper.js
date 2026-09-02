/**
 * Goalkeeper simulation and AI (Design Bible section 16 and 21.4).
 *
 * The goalkeeper is a fully simulated athlete, not an enlarged collision box. It
 * reads ball position, shooter hand, shoulder angle, elevation, pump-fake history,
 * shot-clock pressure, likely shot type, block coverage and passing options, and
 * it moves with the same hydrodynamic locomotion as everyone else - the only
 * difference is that its command comes from this file rather than the field AI.
 *
 * Saves are resolved geometrically: the keeper's hands sweep a real volume and the
 * ball either intersects it or does not. Rebound direction follows from where on
 * the hand the contact happened and from the keeper's rebound-control attribute.
 */

import { Vec2, clamp, clamp01, lerp, damp, dist2, angleDelta } from '../core/Math2.js';
import { laneOpenness } from './Actions.js';

const a01 = (v) => clamp01((v - 10) / 85);

export const GK_PROFILE = {
  ASSISTED: 'assisted',   // AI positions, user influences major reactions
  HYBRID: 'hybrid',       // AI holds stance and angle, user times the block
  MANUAL: 'manual',       // user controls everything
};

export class GoalkeeperBrain {
  constructor(athlete, side, rng) {
    this.gk = athlete;
    this.side = side;
    this.rng = rng;
    this.reactionDelay = 0;
    this.committed = null;    // { x, y, at } once the keeper has gone
    this.readTimer = 0;
    this.fakeMemory = 0;      // rises when a shooter keeps faking
    this.lastShooter = null;
    this.diveCooldown = 0;
    this.beaten = 0;
  }

  /** World z of the goal line this keeper defends. */
  goalZ(profile) { return -this.gk.attackDir * (profile.field.length / 2); }

  /**
   * Produce the goalkeeper's locomotion command. Called every frame.
   * @param {object} ctx { sim, difficulty }
   */
  update(dt, ctx) {
    const { sim } = ctx;
    const gk = this.gk;
    const profile = sim.profile;
    const ball = sim.ball;
    const gz = this.goalZ(profile);
    const half = profile.field.goalWidth / 2;
    const diff = ctx.difficulty;
    const attr = gk.player.attr;

    this.diveCooldown = Math.max(0, this.diveCooldown - dt);
    this.beaten = Math.max(0, this.beaten - dt);

    const cmd = { dir: null, effort: 0, rise: 0, face: null, brace: false };

    // --- Holding the ball: outlet and start the counter (section 16.1) -----
    if (gk.hasBall) {
      this.outletDelay = (this.outletDelay ?? lerp(1.4, 0.5, a01(attr.gkCommunication))) - dt;
      cmd.rise = 0.55;
      const outlet = this._chooseOutlet(sim);
      if (outlet) cmd.face = Math.atan2(outlet.pos.x - gk.pos.x, outlet.pos.z - gk.pos.z);
      if (this.outletDelay <= 0 && outlet && gk.actionLock <= 0) {
        const far = dist2(gk.pos, outlet.pos) > 9;
        sim.tryPass(gk, outlet, far ? 'gkOutlet' : 'outlet', far ? 0.95 : 0.62);
        this.outletDelay = null;
      }
      return cmd;
    }
    this.outletDelay = null;

    // --- Where is the threat? ---------------------------------------------
    const threat = ball.holder ?? (ball.isLoose ? { pos: { x: ball.pos.x, z: ball.pos.z }, isBall: true } : null);
    const tx = threat ? threat.pos.x : ball.pos.x;
    const tz = threat ? threat.pos.z : ball.pos.z;

    // --- Angle: sit on the bisector between the threat and the goal centre --
    const toGoal = Math.hypot(tx - 0, tz - gz) || 1;
    const angleX = (tx / toGoal) * half * lerp(0.55, 0.92, a01(attr.setPositioning));
    // Depth: come out against close threats, sit back against lobs and long shots.
    const threatDist = Math.hypot(tx, gz - tz);
    let depth = lerp(0.28, 1.15, clamp01((threatDist - 2.5) / 7));
    if (threatDist < 3.0) depth = lerp(0.9, 0.35, clamp01((3.0 - threatDist) / 2.2));
    // Lob awareness: a keeper who reads a lob threat holds depth.
    const lobRisk = clamp01((threatDist - 5.5) / 5) * (1 - a01(attr.lobRecognition) * 0.55);
    depth = lerp(depth, 0.32, lobRisk * 0.6);

    let targetX = clamp(angleX, -half - 0.35, half + 0.35);
    let targetZ = gz + this.gk.attackDir * depth;

    // --- Shot in flight: commit ------------------------------------------
    const incoming = this._incomingShot(ball, gz, profile);
    if (incoming) {
      if (this.reactionDelay <= 0 && !this.committed) {
        // Reaction time is physical; recognition quality is the difficulty knob.
        const base = lerp(0.26, 0.09, a01(attr.reactionSpeed));
        this.reactionDelay = base * lerp(1.25, 0.85, diff.gkDiscipline) * this.rng.range(0.85, 1.2);
      }
      this.reactionDelay -= dt;

      if (this.reactionDelay <= 0 && !this.committed) {
        // Read the flight, with error from skip tracking and shot speed.
        const readErr =
          (1 - a01(incoming.isSkip ? attr.skipTracking : attr.reactionSpeed)) *
          lerp(0.55, 0.18, diff.gkDiscipline) *
          clamp01(incoming.speed / 22);
        this.committed = {
          x: incoming.x + this.rng.gauss(0, readErr * 0.9),
          y: clamp(incoming.y + this.rng.gauss(0, readErr * 0.55), -0.1, 1.15),
          at: sim.clockNow,
        };
      }

      if (this.committed) {
        targetX = clamp(this.committed.x, -half - 0.55, half + 0.55);
        targetZ = gz + this.gk.attackDir * clamp(depth, 0.18, 0.6);
        cmd.rise = clamp01(this.committed.y / 0.9) * lerp(0.7, 1.0, a01(attr.verticalExplosion));
        cmd.effort = 1;
      }
    } else {
      this.committed = null;
      this.reactionDelay = 0;

      // Set stance: keep legs going, ready to explode. Height scales with threat.
      const readiness = clamp01(1 - (threatDist - 2.0) / 9);
      cmd.rise = lerp(0.18, 0.62, readiness) * lerp(0.8, 1.0, gk.freshness);

      // Pump-fake discipline (section 21.4): a disciplined keeper stops biting.
      if (ball.holder && ball.holder.charging === 'shot') {
        const disciplined = a01(attr.pumpFakeDiscipline) * diff.gkDiscipline;
        const bite = clamp01(this.fakeMemory * (1 - disciplined));
        cmd.rise = clamp01(cmd.rise + 0.35 * (1 - bite));
      }
    }

    // --- Move ---------------------------------------------------------------
    const to = new Vec2(targetX - gk.pos.x, targetZ - gk.pos.z);
    const d = to.length();
    cmd.dir = d > 0.08 ? to.normalize() : null;
    cmd.effort = Math.max(cmd.effort, clamp01(d / 1.2) * lerp(0.6, 1.0, a01(attr.lateralMovement)));
    cmd.face = Math.atan2(tx - gk.pos.x, tz - gk.pos.z);
    cmd.brace = true;

    return cmd;
  }

  /**
   * Pick an outlet. A goalkeeper prefers the athlete furthest up the pool with a
   * clean lane - that is what turns a save into a counterattack - but will take
   * the safe short option when nothing is open.
   */
  _chooseOutlet(sim) {
    const gk = this.gk;
    const mates = sim.activeAthletes(this.side).filter((a) => a !== gk);
    if (!mates.length) return null;
    const opp = sim.activeAthletes(sim.opponentSide(this.side));
    const attackGoalZ = gk.attackDir * (sim.profile.field.length / 2);

    let best = null, bestScore = -Infinity;
    for (const m of mates) {
      const lane = laneOpenness(gk.pos, m.pos, opp).open;
      const d = dist2(gk.pos, m.pos);
      if (d > 21) continue;
      const upField = clamp01(1 - Math.abs(attackGoalZ - m.pos.z) / sim.profile.field.length);
      const pressure = clamp01(1 - Math.min(...opp.map((o) => dist2(o.pos, m.pos)), 99) / 3);
      const score = lane * 1.6 + upField * 1.1 - pressure * 0.9 - (d > 16 ? 0.5 : 0);
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  /** Is there a shot heading at this goal right now? */
  _incomingShot(ball, gz, profile) {
    if (!ball.isLoose) return null;
    const dir = Math.sign(gz - ball.pos.z);
    if (Math.sign(ball.vel.z) !== dir || Math.abs(ball.vel.z) < 3.5) return null;
    const t = (gz - ball.pos.z) / ball.vel.z;
    if (t < 0 || t > 1.4) return null;

    // Predict with gravity and a crude buoyancy allowance for skip shots.
    const x = ball.pos.x + ball.vel.x * t;
    let y = ball.pos.y + ball.vel.y * t - 0.5 * 9.81 * t * t;
    const isSkip = ball.pos.y < 0.35 || ball.eventFlags.skip > 0;
    if (isSkip) y = Math.max(y, 0.18);
    if (Math.abs(x) > profile.field.goalWidth / 2 + 0.9) return null;
    return { x, y: clamp(y, -0.15, 1.4), t, speed: ball.speed, isSkip };
  }

  /** Called by the simulation when a shot reaches the keeper's reach volume. */
  noteFake() { this.fakeMemory = clamp01(this.fakeMemory + 0.34); }
  decayFake(dt) { this.fakeMemory = clamp01(this.fakeMemory - dt * 0.12); }
}

/**
 * Attempt a save. Returns null when the ball is nowhere near the keeper's hands,
 * otherwise a resolution describing the contact and the resulting ball velocity.
 *
 * The reach volume is a real shape: an ellipsoid around the keeper, wider than it
 * is deep, scaled by wingspan, elevation and single/two-arm coverage. A keeper who
 * has committed the wrong way physically cannot reach the other corner.
 */
export function attemptSave(gk, ball, brain, rng, opts = {}) {
  const attr = gk.player.attr;
  const manual = opts.manualDirection ?? null;

  const hx = gk.pos.x;
  const hz = gk.pos.z;
  const hy = 0.16 + gk.elevation * 1.2;

  const dx = ball.pos.x - hx;
  const dy = ball.pos.y - hy;
  const dz = ball.pos.z - hz;

  // Reach envelope.
  const armSpan = gk.reach * lerp(1.5, 2.05, a01(attr.singleArmReach)) * (1 + gk.elevation * 0.35);
  const vertical = gk.reach * lerp(1.0, 1.5, a01(attr.twoArmCoverage)) * (1 + gk.elevation * 0.9);
  const depthReach = 0.55 + gk.elevation * 0.3;

  // Manual input steers the block; assisted keepers use their committed read.
  let biasX = 0, biasY = 0;
  if (manual) { biasX = manual.x * 0.55; biasY = manual.y * 0.4; }
  else if (brain?.committed) {
    biasX = clamp((brain.committed.x - hx) * 0.6, -0.6, 0.6);
    biasY = clamp((brain.committed.y - hy) * 0.5, -0.4, 0.5);
  }

  const ex = (dx - biasX) / armSpan;
  const ey = (dy - biasY) / vertical;
  const ez = dz / depthReach;
  const r = Math.hypot(ex, ey, ez);
  if (r > 1) return null;

  // Contact quality: dead centre of the hand is a clean control, edge is a parry.
  const clean = clamp01(1 - r) * lerp(0.5, 1.0, a01(attr.reboundControl));
  const closeRange = clamp01(1 - Math.abs(dz) / 2.4);
  const speedPenalty = clamp01(1 - (ball.speed - 12) / 22);
  const control = clamp01(clean * 0.6 + speedPenalty * 0.25 + a01(attr.closeRange) * closeRange * 0.25);

  const roll = rng.next();
  let outcome, vel;
  const n = { x: (dx || 0.01), y: Math.max(0.15, dy), z: dz };
  const nl = Math.hypot(n.x, n.y, n.z) || 1;
  n.x /= nl; n.y /= nl; n.z /= nl;

  if (roll < control * 0.62) {
    outcome = 'controlled';   // keeper holds it
    vel = { x: 0, y: 0, z: 0 };
  } else if (roll < control + 0.22) {
    outcome = 'parry';        // directed deflection
    const speed = ball.speed * lerp(0.22, 0.42, 1 - control);
    // A controlled keeper parries wide and away from the danger zone.
    const wide = Math.sign(dx || rng.range(-1, 1));
    const dirX = lerp(n.x, wide, lerp(0.2, 0.85, a01(attr.reboundControl)));
    vel = { x: dirX * speed, y: Math.abs(n.y) * speed * 0.8 + 1.5, z: -Math.sign(dz || 1) * speed * 0.7 };
  } else if (roll < control + 0.34) {
    outcome = 'deflection';   // uncontrolled: anywhere
    const speed = ball.speed * 0.5;
    vel = {
      x: (n.x + rng.gauss(0, 0.6)) * speed,
      y: Math.abs(n.y) * speed * 0.6 + 1.2,
      z: (n.z + rng.gauss(0, 0.5)) * speed,
    };
  } else {
    return null;              // beaten: the ball goes through
  }

  return { outcome, vel, control, reach: r };
}
