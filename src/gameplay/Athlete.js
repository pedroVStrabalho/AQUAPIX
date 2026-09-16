/**
 * Runtime athlete: hydrodynamic locomotion, eggbeater elevation, stamina layers.
 *
 * Design Bible sections 10 (Hydrodynamic Player Movement), 11 (Eggbeater and
 * Vertical Elevation) and 17 (Stamina, Fatigue, Rotation, Injury).
 *
 * The controlling rule from section 10.1:
 *
 *     propulsion(stroke, legs) - water resistance - contact resistance,
 *     modified by body orientation, fatigue, possession and attributes
 *
 * Nothing here ever writes a position directly from an input direction. The input
 * sets a *desired heading and effort*; the water decides what actually happens.
 */

import { Vec2, clamp, clamp01, lerp, damp, angleDelta, turnToward, smoothstep } from '../core/Math2.js';

/** Attribute 1-99 to a 0-1 curve that keeps mid ratings meaningful. */
const a01 = (v) => clamp01((v - 10) / 85);

/** Readiness thresholds and recovery rates (fractions per second). */
const READY_SPRINT_START = 0.75;   // needed to BEGIN a sprint
const READY_SPRINT_MIN = 0.70;     // sprint cuts out below this
const READY_REFILL_STILL = 0.08;   // treading water
const READY_REFILL_SWIM = 0.03;    // swimming gently

export const LOCOMOTION = {
  SPRINT: 'sprint',           // horizontal high-effort swimming
  SWIM: 'swim',               // controlled head-up swimming
  DRIBBLE: 'dribble',         // swimming with the ball
  RECOVER: 'recover',         // low-effort return swim
  EGGBEATER: 'eggbeater',     // vertical, stable
  HIGH_EGGBEATER: 'high',     // vertical, elevated
  EXPLODE: 'explode',         // maximum elevation effort
  SEAL: 'seal',               // centre forward holding position
  FRONT: 'front',             // centre defender fronting
  BLOCK: 'block',             // arm raised, set to block
  SHOT_PREP: 'shotPrep',
  PASS_PREP: 'passPrep',
  GK_SET: 'gkSet',
  GK_LATERAL: 'gkLateral',
  OUT: 'out',                 // excluded / outside the field of play
};

export class Athlete {
  /**
   * @param {object} player static player record from the roster data
   * @param {'home'|'away'} side
   * @param {number} attackDir +1 if this team attacks toward +z, -1 otherwise
   */
  constructor(player, side, attackDir) {
    this.player = player;
    this.id = player.id;
    this.side = side;
    this.attackDir = attackDir;
    this.isGoalkeeper = player.position === 'GK';

    // --- Kinematics -------------------------------------------------------
    this.pos = new Vec2(0, 0);
    this.vel = new Vec2(0, 0);
    this.heading = attackDir > 0 ? 0 : Math.PI;
    this.desiredHeading = this.heading;

    /** 0 = fully horizontal (swimming), 1 = fully vertical (eggbeater). */
    this.verticality = 1;
    /** Metres of body raised above the neutral floating waterline. */
    this.elevation = 0;
    this.elevVel = 0;
    /** Shoulder line, lags the heading. Governs which actions are available. */
    this.shoulder = this.heading;

    // --- Effort and stamina (section 17.1: three connected layers) ---------
    this.burst = 1;        // stored name for READINESS - starts full
    this.pool = 1;         // possession-level recovery, tens of seconds
    this.matchFatigue = 0; // accumulates across the match, lowers capacity
    this.exertion = 0;     // smoothed instantaneous output, drives animation

    // --- Match state ------------------------------------------------------
    this.hasBall = false;
    this.state = LOCOMOTION.EGGBEATER;
    this.personalFouls = 0;
    this.excluded = false;
    this.exclusionRemaining = 0;
    this.excludedForMatch = false;
    this.inPool = true;
    this.role = 'field';
    this.roleSlot = null;
    this.markTarget = null;

    // --- Action timers ----------------------------------------------------
    this.actionLock = 0;     // seconds during which locomotion input is reduced
    this.chargeTime = 0;     // shot / pass charge accumulator
    this.charging = null;    // 'shot' | 'pass' | null
    this.pumpFakes = 0;
    this.lastPumpFakeAt = -99;
    this.catchCooldown = 0;
    this.stealCooldown = 0;
    this.blockTimer = 0;
    this.armRaised = 0;      // 0..1 visual + block reach
    this.contactImpulse = new Vec2(0, 0);
    this.contactLoad = 0;    // 0..1 how hard this athlete is being worked
    this.lastTouchAt = -99;
    this.stunned = 0;

    // --- Derived constants from attributes --------------------------------
    this.refresh();

    // --- Statistics -------------------------------------------------------
    this.stats = freshStats();
    this.distanceSwum = 0;
    this.sprintEfforts = 0;
    this._wasSprinting = false;
  }

  refresh() {
    const a = this.player.attr;
    const form = this.player.form ?? 1;
    // ARCADE PACE. Real swimmers do ~2 m/s, which means 12 seconds to cross the
    // pool - that reads as "the controls don't work". These are deliberately
    // arcade speeds: cross the pool in ~5s, reach top speed in well under a
    // second, and turn sharply. Attributes still separate fast from slow players.
    // Arcade, but readable. The pool is now drawn whole and landscape, so the
    // eye has to track the entire field at once - at the old pace play crossed
    // the screen faster than a person could read it. Still well above a real
    // swimmer's ~2 m/s, so the controls stay responsive.
    this.maxSpeed = lerp(2.7, 3.7, a01(a.swimSpeed)) * form;
    this.accelBase = lerp(6.0, 10.0, a01(a.firstStroke));
    this.turnBase = lerp(4.5, 7.5, a01(a.changeOfDirection));
    this.maxElevation = lerp(0.34, 0.72, a01(a.legPower) * 0.7 + a01(a.verticalReach) * 0.3);
    this.riseRate = lerp(1.5, 3.4, a01(a.explosiveness) * 0.6 + a01(a.legPower) * 0.4);
    this.enduranceK = lerp(1.35, 0.62, a01(a.endurance));
    this.burstK = lerp(1.45, 0.6, a01(a.burstStamina));
    this.strength = a01(a.upperStrength);
    this.leverage = a01(a.leverage);
    this.balance = a01(a.balance);
    this.reach = lerp(0.72, 1.06, a01(a.wingspan)) + (this.player.height - 190) * 0.0035;
    this.hand = this.player.leftHanded ? -1 : 1;
    this.traits = new Set(this.player.traits ?? []);
    if (this.traits.has('eliteLegs')) { this.maxElevation *= 1.08; this.riseRate *= 1.08; }
    if (this.traits.has('highMotor')) this.enduranceK *= 0.85;
    if (this.traits.has('counterSprinter')) this.accelBase *= 1.12;
    if (this.traits.has('longReachBlocker')) this.reach *= 1.1;
  }

  /** Capacity ceiling: match fatigue permanently lowers what the athlete can do. */
  get capacity() { return 1 - 0.42 * this.matchFatigue; }
  /** Combined freshness used everywhere a fatigue penalty applies. */
  get freshness() { return clamp01(0.35 + 0.4 * this.burst + 0.25 * this.pool) * this.capacity; }
  get speed() { return this.vel.length(); }
  get isVertical() { return this.verticality > 0.55; }

  has(trait) { return this.traits.has(trait); }

  /**
   * @param {number} dt
   * @param {object} cmd control intent
   *   cmd.dir     {Vec2|null}  desired swim direction, magnitude 0..1
   *   cmd.effort  {number}     0..1 requested propulsion effort (sprint = 1)
   *   cmd.rise    {number}     0..1 requested eggbeater elevation
   *   cmd.face    {number|null} desired facing angle overriding movement facing
   *   cmd.brace   {boolean}    hold legal defensive position / protect ball
   * @param {object} world { profile, pool }
   */
  /** Readiness, 0..1. Full at 100%; below 70% the athlete cannot sprint. */
  get readiness() { return this.burst; }
  /** Can this athlete start a sprint right now? */
  get canSprint() { return this.burst >= READY_SPRINT_START; }

  update(dt, cmd, world) {
    if (!this.inPool) {
      this.exertion = damp(this.exertion, 0, 4, dt);
      this._recover(dt, 0);
      return;
    }

    this.actionLock = Math.max(0, this.actionLock - dt);
    this.catchCooldown = Math.max(0, this.catchCooldown - dt);
    this.stealCooldown = Math.max(0, this.stealCooldown - dt);
    this.stunned = Math.max(0, this.stunned - dt);
    this.blockTimer = Math.max(0, this.blockTimer - dt);

    const dir = cmd.dir ?? null;
    const wantMove = dir ? Math.min(1, dir.length()) : 0;
    const lockScale = this.stunned > 0 ? 0.25 : this.actionLock > 0 ? 0.45 : 1;

    // ---- Requested effort, limited by what the body can still produce -----
    let effort = clamp01(cmd.effort ?? 0) * wantMove * lockScale;
    const sprinting = effort > 0.82 && wantMove > 0.7;
    const rise = clamp01(cmd.rise ?? 0);

    // ---- Body orientation: swimming is horizontal, elevation is vertical --
    // Moving fast pulls the body flat; requesting elevation stands it up.
    const wantVertical = clamp01(Math.max(rise, cmd.brace ? 0.85 : 0) * (1 - wantMove * 0.55) + (1 - wantMove) * 0.75);
    const orientLambda = wantVertical > this.verticality ? 5.5 : 3.6;
    this.verticality = damp(this.verticality, wantVertical, orientLambda * (0.6 + 0.6 * a01(this.player.attr.bodyControl)), dt);

    // A vertical body cannot swim: propulsion collapses as the athlete stands up.
    const swimEfficiency = lerp(1, 0.28, smoothstep(this.verticality));

    // ---- Turning ----------------------------------------------------------
    // Heading is where you SWIM; face is where you LOOK. These must stay
    // separate. Thrust is produced along the body axis only (see below), so
    // letting cmd.face overwrite the swim heading meant that every AI player
    // who was told to "watch the ball" - which is nearly all of them, nearly
    // all the time - physically swam at the ball instead of to their position.
    // That single line was the cause of the whole team collapsing into a scrum
    // around the ball no matter what the formation logic asked for.
    if (dir && wantMove > 0.05) this.desiredHeading = dir.angle();
    else if (cmd.face != null) this.desiredHeading = cmd.face;   // treading: turn to watch play

    const speedFrac = clamp01(this.speed / this.maxSpeed);
    // Turning radius grows with speed while horizontal; eggbeater spins freely.
    const turnRate = this.turnBase
      * lerp(1.0, 0.34, speedFrac * (1 - this.verticality * 0.75))
      * lerp(0.55, 1.0, this.freshness)
      * lerp(1.0, 1.45, this.verticality);
    this.heading = turnToward(this.heading, this.desiredHeading, turnRate * dt);
    // Shoulders lag the head: you cannot shoot at what you have only just turned to.
    // The shoulders - not the legs - are what follow cmd.face, so an athlete can
    // swim to their position while keeping the ball in view, and still pass or
    // shoot where the AI aimed.
    const aim = cmd.face != null ? cmd.face : this.heading;
    const shoulderRate = turnRate * lerp(0.55, 0.95, a01(this.player.attr.bodyControl));
    this.shoulder = turnToward(this.shoulder, aim, shoulderRate * dt);

    // ---- Propulsion -------------------------------------------------------
    const fatigueSpeed = lerp(0.62, 1.0, this.freshness);
    // Dribbling is SLOW. You swim head-up with the ball between your forearms -
    // you cannot take a proper stroke. At the old 4-14% cost a carrier who
    // sprinted moved faster than a free defender could cruise, so anyone who won
    // the ball simply swam the length of the pool and scored untouched.
    const ballPenalty = this.hasBall ? lerp(0.66, 0.78, a01(this.player.attr.ballSecurity)) : 1;
    // Sprint is a real burst you can feel, paid for in burst stamina - but you
    // cannot sprint while controlling the ball, so the carrier must pass.
    const sprintCeiling = this.hasBall ? 1.06 : 1.3;
    // Hold the full boost until the burst is nearly spent, then fall away. Making
    // it proportional to remaining burst meant the boost decayed faster than the
    // athlete could accelerate into it, so sprinting was actually SLOWER than
    // cruising - it cost stamina and delivered nothing.
    // READINESS GATES THE SPRINT. Below 70% the athlete simply cannot sprint any
    // more and has to recover first, which is what stops a match becoming one
    // swimmer holding sprint from end to end. The start/continue thresholds
    // differ slightly so it cannot stutter on and off at exactly the line.
    if (this._sprinting) {
      if (this.readiness < READY_SPRINT_MIN) this._sprinting = false;
    } else if (cmd.sprint && this.readiness >= READY_SPRINT_START) {
      this._sprinting = true;
    }
    if (!cmd.sprint) this._sprinting = false;
    const canSprint = this._sprinting;
    const sprintBoost = canSprint ? lerp(1.0, sprintCeiling, clamp01(this.readiness / 0.32)) : 1;
    let vMax = this.maxSpeed * fatigueSpeed * ballPenalty * sprintBoost
      * lerp(0.70, 1.0, effort > 0 ? lerp(0.7, 1, effort) : 0.7);
    // Arrival damping: when the caller says how far the target is, cap speed to
    // what can still be stopped in that distance (v = sqrt(2*a*d)). Without this
    // the faster arcade athletes overshoot every position and oscillate.
    if (cmd.arriveDist != null) {
      vMax = Math.min(vMax, Math.sqrt(Math.max(0, 2 * this.accelBase * 0.85 * cmd.arriveDist)) + 0.15);
    }
    const accel = this.accelBase * effort * swimEfficiency * lerp(0.6, 1.0, this.freshness);

    // Quadratic water resistance tuned so that propulsion balances drag at vMax.
    const dragK = vMax > 0.05 ? this.accelBase / (vMax * vMax) : 6;

    const hx = Math.sin(this.heading), hz = Math.cos(this.heading);
    // Thrust is produced along the body axis only - swimmers do not strafe.
    this.vel.x += hx * accel * dt;
    this.vel.z += hz * accel * dt;

    // Directional drag: much stronger sideways than forwards. This is what makes
    // a turn cost momentum instead of instantly redirecting it.
    const along = this.vel.x * hx + this.vel.z * hz;
    const latX = this.vel.x - along * hx;
    const latZ = this.vel.z - along * hz;
    const lat = Math.hypot(latX, latZ);

    const alongDrag = dragK * Math.abs(along) + 0.55;
    const latDrag = dragK * lat * 2.4 + 3.2 + this.verticality * 2.5;

    const newAlong = along - Math.sign(along) * Math.min(Math.abs(along), alongDrag * Math.abs(along) * dt + 0.02 * dt);
    const latDamp = Math.exp(-latDrag * dt);

    this.vel.x = newAlong * hx + latX * latDamp;
    this.vel.z = newAlong * hz + latZ * latDamp;

    // Standing up in the water kills forward momentum quickly.
    if (this.verticality > 0.6) {
      const k = Math.exp(-(this.verticality - 0.6) * 5.5 * dt);
      this.vel.scale(k);
    }

    // ---- Contact resistance ----------------------------------------------
    if (this.contactImpulse.lengthSq() > 0) {
      this.vel.addScaled(this.contactImpulse, dt);
      this.contactImpulse.set(0, 0);
    }

    // ---- Integrate --------------------------------------------------------
    const step = this.speed * dt;
    this.distanceSwum += step;
    this.pos.addScaled(this.vel, dt);
    this._clampToPool(world);

    // ---- Eggbeater elevation ---------------------------------------------
    this._updateElevation(dt, rise, cmd.brace);

    // ---- Stamina ----------------------------------------------------------
    // Cruising is sustainable; sprinting, elevating and wrestling are what cost
    // you. Without this, "always full effort" movement drains everyone in
    // seconds and the whole pool looks exhausted from nowhere.
    const workload =
      // You cannot generate a true sprint effort while controlling the ball, so
      // it costs less - otherwise holding sprint with the ball made you slower
      // than not holding it, which reads as a broken button.
      effort * (canSprint ? (this.hasBall ? 0.5 : 1.05) : 0.34) * this.enduranceK +
      rise * rise * this.burstK * 0.7 +
      this.contactLoad * 0.5;
    this._recover(dt, workload, effort);
    this.exertion = damp(this.exertion, clamp01(workload * 0.9 + speedFrac * 0.35), 6, dt);

    if (sprinting && !this._wasSprinting) this.sprintEfforts++;
    this._wasSprinting = sprinting;

    this.contactLoad = damp(this.contactLoad, 0, 5, dt);
    this.armRaised = damp(this.armRaised, this.blockTimer > 0 ? 1 : 0, 9, dt);

    this.state = this._deriveState(effort, rise, sprinting, wantMove);
  }

  _updateElevation(dt, rise, brace) {
    // Available lift depends on legs, current burst stamina and match fatigue.
    const legFresh = lerp(0.45, 1.0, this.burst) * this.capacity;
    const targetHeight = this.maxElevation * rise * legFresh * lerp(0.75, 1.0, this.verticality);

    // Rising is fast and expensive; settling back down is passive and cheap.
    if (targetHeight > this.elevation) {
      const rate = this.riseRate * legFresh * (0.4 + 0.6 * rise);
      this.elevVel = damp(this.elevVel, (targetHeight - this.elevation) * rate, 14, dt);
    } else {
      // Gravity plus buoyancy return: quick at first, gentle near the surface.
      this.elevVel = damp(this.elevVel, (targetHeight - this.elevation) * 4.5, 10, dt);
    }
    this.elevation = clamp(this.elevation + this.elevVel * dt, -0.05, this.maxElevation * 1.02);
    if (brace) this.elevation = Math.max(this.elevation, this.maxElevation * 0.22 * legFresh);
  }

  _recover(dt, workload, effort = 0) {
    // READINESS. Starts full, drains under load, and comes back at a pace you
    // can feel: about 8% per second treading water, about 3% per second while
    // swimming gently. Sprinting is the only thing that empties it quickly.
    const rest = clamp01(1 - effort);
    // Recovery only happens when you are actually taking it easy. Without this
    // gate an athlete hammering explosive eggbeater counted as "still" - they
    // were not swimming - and recovered as fast as they spent, so elevation
    // became free.
    const easing = 1 - clamp01(workload * 1.8);
    const refill = lerp(READY_REFILL_SWIM, READY_REFILL_STILL, rest) * easing
      * lerp(0.85, 1.15, a01(this.player.attr.effortRecovery));
    const drain = workload * 0.16;
    this.burst = clamp01(this.burst + (refill - drain) * dt);

    // Possession-level pool: slower both ways.
    const poolDrain = workload * 0.085;
    const poolRefill = (1 - clamp01(workload * 3)) * 0.055;
    this.pool = clamp01(this.pool + (poolRefill - poolDrain) * dt);

    // Match fatigue only ever grows during play. Substitutions and intervals
    // shave it back (see recoverOnBench).
    this.matchFatigue = clamp01(this.matchFatigue + workload * 0.0085 * dt);
  }

  /** Called while an athlete sits on the bench or during an interval. */
  recoverOnBench(dt) {
    this.burst = clamp01(this.burst + 0.24 * dt);
    this.pool = clamp01(this.pool + 0.11 * dt);
    this.matchFatigue = clamp01(this.matchFatigue - 0.019 * dt);
    this.elevation = damp(this.elevation, 0, 6, dt);
    this.exertion = damp(this.exertion, 0, 4, dt);
  }

  _clampToPool(world) {
    const f = world.profile.field;
    const halfW = f.width / 2 - 0.35;
    const halfL = f.length / 2 - 0.3;

    // Goalkeepers stay home. They may come off their line, but never upfield -
    // a keeper wandering to half way leaves an empty net and looks broken.
    if (this.isGoalkeeper) {
      const ownGoalZ = -this.attackDir * (f.length / 2);
      const maxOut = 3.2;                       // metres off the goal line
      const lo = Math.min(ownGoalZ, ownGoalZ + this.attackDir * maxOut);
      const hi = Math.max(ownGoalZ, ownGoalZ + this.attackDir * maxOut);
      if (this.pos.z < lo) { this.pos.z = lo; this.vel.z = Math.max(0, this.vel.z) * 0.3; }
      if (this.pos.z > hi) { this.pos.z = hi; this.vel.z = Math.min(0, this.vel.z) * 0.3; }
      const gkX = f.goalWidth / 2 + 1.6;
      if (this.pos.x < -gkX) { this.pos.x = -gkX; this.vel.x = Math.max(0, this.vel.x) * 0.3; }
      if (this.pos.x > gkX) { this.pos.x = gkX; this.vel.x = Math.min(0, this.vel.x) * 0.3; }
    }
    if (this.pos.x < -halfW) { this.pos.x = -halfW; this.vel.x = Math.max(0, this.vel.x) * 0.4; }
    if (this.pos.x > halfW) { this.pos.x = halfW; this.vel.x = Math.min(0, this.vel.x) * 0.4; }
    if (this.pos.z < -halfL) { this.pos.z = -halfL; this.vel.z = Math.max(0, this.vel.z) * 0.4; }
    if (this.pos.z > halfL) { this.pos.z = halfL; this.vel.z = Math.min(0, this.vel.z) * 0.4; }
  }

  _deriveState(effort, rise, sprinting, wantMove) {
    if (!this.inPool) return LOCOMOTION.OUT;
    if (this.isGoalkeeper) return wantMove > 0.25 ? LOCOMOTION.GK_LATERAL : LOCOMOTION.GK_SET;
    if (this.charging === 'shot') return LOCOMOTION.SHOT_PREP;
    if (this.charging === 'pass') return LOCOMOTION.PASS_PREP;
    if (this.blockTimer > 0) return LOCOMOTION.BLOCK;
    if (rise > 0.85) return LOCOMOTION.EXPLODE;
    if (this.verticality > 0.6) {
      if (this.elevation > this.maxElevation * 0.5) return LOCOMOTION.HIGH_EGGBEATER;
      return LOCOMOTION.EGGBEATER;
    }
    if (this.hasBall) return LOCOMOTION.DRIBBLE;
    if (sprinting) return LOCOMOTION.SPRINT;
    if (effort > 0.15) return LOCOMOTION.SWIM;
    return LOCOMOTION.RECOVER;
  }

  /** World-space point where this athlete's throwing hand sits right now. */
  handPoint(out = { x: 0, y: 0, z: 0 }) {
    const side = this.hand;
    const perpX = Math.cos(this.shoulder) * side;
    const perpZ = -Math.sin(this.shoulder) * side;
    const fwd = 0.16 + this.elevation * 0.25;
    out.x = this.pos.x + perpX * 0.24 + Math.sin(this.shoulder) * fwd;
    out.z = this.pos.z + perpZ * 0.24 + Math.cos(this.shoulder) * fwd;
    out.y = 0.22 + this.elevation * 1.25 + (this.charging === 'shot' ? 0.18 : 0);
    return out;
  }

  /** Head position, used by the camera and for wet-catch geometry. */
  headPoint(out = { x: 0, y: 0, z: 0 }) {
    out.x = this.pos.x;
    out.z = this.pos.z;
    out.y = 0.12 + this.elevation * 1.05;
    return out;
  }

  /** How well oriented the athlete is to act toward a world target, 0..1. */
  facingQuality(tx, tz) {
    const want = Math.atan2(tx - this.pos.x, tz - this.pos.z);
    const d = Math.abs(angleDelta(this.shoulder, want));
    return clamp01(1 - d / (Math.PI * 0.85));
  }

  resetForRestart() {
    this.vel.set(0, 0);
    this.charging = null;
    this.chargeTime = 0;
    this.actionLock = 0;
    this.stunned = 0;
  }
}

export function freshStats() {
  return {
    goals: 0, assists: 0, shots: 0, shotsOnGoal: 0, saves: 0, blocks: 0, steals: 0,
    turnovers: 0, ordinaryFouls: 0, exclusionsDrawn: 0, exclusionsConceded: 0,
    penaltiesDrawn: 0, penaltiesConceded: 0, personalFouls: 0, passesAttempted: 0,
    passesCompleted: 0, centreEntries: 0, centreTouches: 0, counterGoals: 0,
    reboundsControlled: 0, shotLocations: [], timeInPool: 0,
  };
}
