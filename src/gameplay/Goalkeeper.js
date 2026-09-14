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

    // --- Smother a loose ball in my own goal mouth -------------------------
    // A keeper does not watch a free ball roll across their own line. Without
    // this, balls that nobody is chasing simply drift into an unattended net -
    // goals that belong to no shooter and to no attack.
    if (ball.isLoose && !ball.holder) {
      const toLine = Math.abs(ball.pos.z - gz);
      const wide = Math.abs(ball.pos.x);
      // Generous: a slow ball anywhere in the goal area is the keeper's to claim.
      // Measured, more than half of all goals were balls drifting over the line
      // at 1.5 m/s with no shot within the previous ten seconds.
      // Only a genuinely slow ball. A keeper who swims at an incoming SHOT has
      // abandoned their angle, and every shot then goes in behind them - so
      // anything with pace is left to the save logic below.
      if (ball.speed < 4.5 && toLine < 6.0 && wide < half + 4.5) {
        const to = new Vec2(ball.pos.x - gk.pos.x, ball.pos.z - gk.pos.z);
        const d = to.length();
        cmd.dir = d > 0.1 ? to.normalize() : null;
        cmd.arriveDist = d;
        cmd.effort = 1;
        cmd.rise = 0.5;
        cmd.face = Math.atan2(ball.pos.x - gk.pos.x, ball.pos.z - gk.pos.z);
        return cmd;
      }
    }

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

      // Keep TRACKING the ball rather than freezing on the first read. A shot
      // that is in the air for most of a second gives the keeper time to correct
      // - that is precisely why long shots are saveable and close ones are not.
      // Committing once and never refining left the keeper standing in the wrong
      // place on exactly the shots they should comfortably reach.
      if (this.committed && incoming) {
        const track = lerp(1.2, 4.5, a01(attr.skipTracking)) * diff.gkDiscipline;
        const k = 1 - Math.exp(-track * dt);
        this.committed.x += (incoming.x - this.committed.x) * k;
        this.committed.y += (incoming.y - this.committed.y) * k;
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
    cmd.arriveDist = d;   // settle on the angle, don't sail past it
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
  const depthReach = 0.95 + gk.elevation * 0.45;

  // Manual input steers the block; assisted keepers use their committed read.
  // The committed read is only worth something if there was TIME to read. On a
  // close-range shot the ball arrives before the keeper can move, so handing
  // them the full read-assist let them cover the corner the shooter had picked -
  // which is why accurate close shooting was being punished instead of rewarded.
  // Long shots keep the full assist, so half-court stays comfortably read.
  const readAssist = clamp01(((ball.timeSinceLoose ?? 0) - 0.14) / 0.40);
  let biasX = 0, biasY = 0;
  if (manual) { biasX = manual.x * 0.55; biasY = manual.y * 0.4; }
  else if (brain?.committed) {
    biasX = clamp((brain.committed.x - hx) * 0.6, -0.6, 0.6) * readAssist;
    biasY = clamp((brain.committed.y - hy) * 0.5, -0.4, 0.5) * readAssist;
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

  // Away from the goal line, unambiguously. The keeper defends the line at
  // z = -attackDir * halfLength, so the pool - and safety - is in the opposite
  // direction. Deriving this from the keeper-relative offset or from the ball's
  // own velocity both get the sign wrong in some geometries, and a save that
  // deflects into your own net is the worst outcome in the game.
  const outward = gk.attackDir;

  // ONE attempt per shot, decided the first time the ball is genuinely within
  // reach. Rolling every frame made the outcome depend on how many frames the
  // ball happened to spend inside the envelope - a frame-rate lottery - and let
  // a keeper who had already been beaten save the same shot on the next tick.
  if (ball.saveAttempted) return null;
  ball.saveAttempted = true;

  // How long has the keeper had to read it? A shot from twelve metres is in the
  // air for most of a second: the keeper sees it, sets, and takes it. A shot
  // from three metres arrives before they can move. Without this the chance was
  // flat, and a HALF-COURT shot scored as often as a point-blank one.
  const flight = ball.timeSinceLoose ?? 0;
  const readiness = clamp01((flight - 0.20) / 0.42);
  const saveChance = clamp01(lerp(0.20, 0.97, readiness) * lerp(0.85, 1.12, control));

  const roll = rng.next();
  let outcome, vel;
  const n = { x: (dx || 0.01), y: Math.max(0.15, dy), z: dz };
  const nl = Math.hypot(n.x, n.y, n.z) || 1;
  n.x /= nl; n.y /= nl; n.z /= nl;

  if (roll < saveChance * 0.55) {
    outcome = 'controlled';   // keeper holds it
    vel = { x: 0, y: 0, z: 0 };
  } else if (roll < saveChance * 0.85) {
    outcome = 'parry';        // directed deflection
    const speed = ball.speed * lerp(0.22, 0.42, 1 - control);
    // A controlled keeper parries wide and away from the danger zone.
    const wide = Math.sign(dx || rng.range(-1, 1));
    const dirX = lerp(n.x, wide, lerp(0.2, 0.85, a01(attr.reboundControl)));
    vel = { x: dirX * speed, y: Math.abs(n.y) * speed * 0.8 + 1.5, z: outward * speed * 0.7 };
  } else if (roll < saveChance) {
    outcome = 'deflection';   // uncontrolled: anywhere, but never backwards
    const speed = ball.speed * 0.5;
    // "Uncontrolled" means the keeper cannot choose WHERE it goes - not that it
    // goes into their own goal. The outward z is forced: a hand on the ball
    // always kills its momentum toward the line. Letting this component stay
    // negative meant a large share of saves deflected straight into the net.
    const out = outward;
    vel = {
      x: (n.x + rng.gauss(0, 0.6)) * speed,
      y: Math.abs(n.y) * speed * 0.6 + 1.2,
      z: out * Math.abs(n.z + rng.gauss(0, 0.5)) * speed,
    };
  } else {
    return null;              // beaten: the ball goes through
  }

  return { outcome, vel, control, reach: r };
}
