/**
 * Continuous contact model and foul classification pipeline.
 * Design Bible sections 15.2 - 15.5 and 22.1.
 *
 * Contact is never a binary "engaged / not engaged" flag. Each overlapping pair
 * accumulates a persistent engagement record carrying leverage, hand placement,
 * depth, duration and intent. Fouls emerge from that record through the fifteen
 * step pipeline in section 15.4 - they are not triggered by animation labels.
 */

import { Vec2, clamp, clamp01, lerp, angleDelta, dist2, segmentPointDistance } from '../core/Math2.js';

const a01 = (v) => clamp01((v - 10) / 85);

export const FOUL = {
  NONE: 'none',
  ORDINARY: 'ordinary',
  EXCLUSION: 'exclusion',
  PENALTY: 'penalty',
  BRUTALITY: 'brutality',
};

/** Persistent record for one attacker/defender pair. */
class Engagement {
  constructor(a, b) {
    this.a = a; // player being contacted (usually the attacker)
    this.b = b; // player applying contact (usually the defender)
    this.duration = 0;
    this.severity = 0;    // 0..1 smoothed illegality of the current hold
    this.impeding = 0;    // 0..1 how much b blocks a's path to goal
    this.holding = 0;     // grabbing / pulling back
    this.sinking = 0;     // pushing under
    this.leverage = 0;    // -1 b has inside water, +1 a has inside water
    this.peak = 0;
    this.reported = false;
    this.cooldown = 0;
  }
}

export class ContactSystem {
  constructor(rng) {
    this.rng = rng;
    this.engagements = new Map();
    this.referees = [
      { x: 0, z: 0, side: 1 },
      { x: 0, z: 0, side: -1 },
    ];
    this.lastFoulTime = -99;
  }

  key(a, b) { return a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`; }

  /** Position the two referees. They walk the side of the pool with play. */
  updateReferees(ball, profile) {
    const halfW = profile.field.width / 2 + 0.9;
    const halfL = profile.field.length / 2;
    const bz = clamp(ball.pos.z, -halfL + 2, halfL - 2);
    this.referees[0].x = halfW;
    this.referees[0].z = clamp(bz + 2.5, -halfL, halfL);
    this.referees[1].x = -halfW;
    this.referees[1].z = clamp(bz - 2.5, -halfL, halfL);
  }

  /**
   * @returns {Array} foul events for the rules engine to adjudicate
   */
  update(dt, all, ball, ctx) {
    const { profile, refereeProfile = 'standard', matchTime } = ctx;
    this.updateReferees(ball, profile);
    const fouls = [];

    for (const eng of this.engagements.values()) {
      eng.cooldown = Math.max(0, eng.cooldown - dt);
      eng.touchedThisFrame = false;
    }

    for (let i = 0; i < all.length; i++) {
      const p = all[i];
      if (!p.inPool) continue;
      for (let j = i + 1; j < all.length; j++) {
        const q = all[j];
        if (!q.inPool || q.side === p.side) continue;

        const d = dist2(p.pos, q.pos);
        const contactRange = 0.98;
        if (d > contactRange) continue;

        // Physical separation: two bodies cannot occupy the same water.
        this._separate(p, q, d, dt);

        // Decide roles: whoever is nearer the ball (or holds it) is the attacker.
        const pAtt = p.hasBall || (p.side === ball.lastTouchSide && !q.hasBall);
        const attacker = pAtt ? p : q;
        const defender = pAtt ? q : p;

        const eng = this._engagement(attacker, defender);
        eng.touchedThisFrame = true;
        this._evaluate(eng, dt, ball, ctx);

        const foul = this._classify(eng, ball, ctx);
        if (foul) fouls.push(foul);
      }
    }

    // Decay and retire stale engagements.
    for (const [k, eng] of this.engagements) {
      if (!eng.touchedThisFrame) {
        eng.duration = Math.max(0, eng.duration - dt * 2.5);
        eng.severity *= Math.exp(-6 * dt);
        eng.holding *= Math.exp(-6 * dt);
        eng.sinking *= Math.exp(-6 * dt);
        if (eng.duration <= 0 && eng.severity < 0.545 && eng.cooldown <= 0) this.engagements.delete(k);
      }
    }

    return fouls;
  }

  _engagement(a, b) {
    const k = this.key(a, b);
    let e = this.engagements.get(k);
    if (!e || e.a !== a) {
      // Roles can swap during a possession; rebuild rather than mislabel.
      e = e && e.a === b && e.b === a ? Object.assign(e, { a, b }) : (e ?? new Engagement(a, b));
      e.a = a; e.b = b;
      this.engagements.set(k, e);
    }
    return e;
  }

  _separate(p, q, d, dt) {
    const minD = 0.72;
    if (d >= minD || d < 1e-4) return;
    const overlap = minD - d;
    const nx = (p.pos.x - q.pos.x) / d;
    const nz = (p.pos.z - q.pos.z) / d;

    // Stronger, better balanced athlete with inside water gives less ground - but
    // strength only counts while the athlete has the stamina to apply it. A strong
    // centre with a drained tank (late in a period) can no longer hold position,
    // exactly as the design intends.
    const eff = (a) => (a.strength * 0.6 + a.leverage * 0.25 + a.balance * 0.15) * lerp(0.45, 1.05, a.freshness);
    const pw = eff(p) + 0.05;
    const qw = eff(q) + 0.05;
    const total = pw + qw || 1;
    const pShare = qw / total;
    const qShare = pw / total;

    const push = overlap * 26;
    p.contactImpulse.x += nx * push * pShare;
    p.contactImpulse.z += nz * push * pShare;
    q.contactImpulse.x -= nx * push * qShare;
    q.contactImpulse.z -= nz * push * qShare;

    const load = clamp01(overlap / 0.35);
    p.contactLoad = Math.max(p.contactLoad, load * 0.9);
    q.contactLoad = Math.max(q.contactLoad, load);
  }

  /** Steps 1-9 of section 15.4, evaluated continuously. */
  _evaluate(eng, dt, ball, ctx) {
    const { a, b } = eng;
    const d = dist2(a.pos, b.pos);
    eng.duration += dt;

    // Step 2/3: who has the ball, and is the contacted player holding it?
    const aHasBall = a.hasBall || (ball.state === 'dribble' && ball.holder === a);
    const ballNear = ball.distanceTo(a.pos.x, 0.2, a.pos.z) < 1.1;

    // Step 4: position and movement.
    const goalZ = a.attackDir * (ctx.profile.field.length / 2);
    const toGoal = new Vec2(0 - a.pos.x, goalZ - a.pos.z).normalize();
    const toDef = new Vec2(b.pos.x - a.pos.x, b.pos.z - a.pos.z).normalize();
    eng.impeding = clamp01(toGoal.dot(toDef)) * clamp01(1 - (d - 0.5) / 0.6);

    // Leverage: who owns the inside water. Positive means the attacker does.
    eng.leverage = clamp(
      (a.leverage * 0.6 + a.strength * 0.4 + a.elevation * 0.6) -
      (b.leverage * 0.6 + b.strength * 0.4 + b.elevation * 0.6), -1, 1);

    // Step 5/6: severity and purpose. A defender swimming *into* a player who is
    // not holding the ball, with a raised arm and closing velocity, is holding.
    const closing = clamp01(
      ((b.vel.x - a.vel.x) * -toDef.x + (b.vel.z - a.vel.z) * -toDef.z) / 1.6
    );
    const discipline = a01(b.player.attr.foulDiscipline) * 0.5 + a01(b.player.attr.contactDiscipline) * 0.5;
    const legalSkill = a01(b.player.attr.legalLeverage);

    // A defender's intent is inferred from what they are actually doing: how hard
    // they hold position across the attacker's line, how long, and how fatigued
    // they are (tired defenders grab).
    // Being BEATEN is its own kind of contact. eng.impeding only rises while the
    // defender is goalside, so every foul the model could produce was a front
    // one and exclusions had quietly stopped existing. A defender who has been
    // gone past, is still within arm's reach, and is losing the race, grabs -
    // and that is the foul that gets you excluded.
    const behindness = clamp01(-toGoal.dot(toDef));
    // A defender who is behind you and within arm's reach has already been
    // beaten - they do not also have to be losing a sprint for the grab to
    // count, which is what an (a.speed - b.speed) gate demanded. Being there at
    // all is the problem; outpacing them just makes it worse.
    eng.trailing = behindness *
      clamp01(1 - (d - 0.5) / 0.9) *
      clamp01((a.speed - b.speed + 0.95) / 1.25);

    const grabIntent = clamp01(
      (eng.impeding + eng.trailing * 0.95) * (0.55 + 0.45 * closing) *
      lerp(1.35, 0.55, legalSkill) *
      lerp(1.3, 0.95, b.freshness)
    );

    // Remember which kind of contact BUILT this foul, rather than reading the
    // geometry at the instant of the whistle. By the time the referee blows,
    // bodies have moved; what decides an exclusion is that the defender spent
    // the engagement grabbing from behind, not where they happen to be now.
    eng.behindWork = (eng.behindWork ?? 0) + eng.trailing * dt;
    eng.frontWork = (eng.frontWork ?? 0) + eng.impeding * dt;

    // Where is the defender: goalside (in front of the attacker, between them and
    // the goal they are attacking) or behind them? This is the difference between
    // an ordinary foul and an exclusion in water polo, and nothing in the model
    // used to look at it.
    eng.fromBehind = -toGoal.dot(toDef);   // +1 directly behind, -1 directly in front

    // Contact on the player holding the ball is the ORDINARY foul of water polo -
    // a defender fouling the centre forward is the most common whistle in the
    // sport. Treating it as "largely legal" at 0.3 meant the ball carrier could
    // essentially never draw one: measured over six matches, the athlete the
    // human was controlling was the victim of 0 out of 54 fouls, so every whistle
    // happened somewhere else and teleported the ball to a stranger.
    const holdRate = aHasBall ? grabIntent * 0.6 : grabIntent;
    // The subtracted term is the "letting go" rate: a defender must keep working
    // at it for the hold to register as illegal, and it decays the moment they
    // stop. Sustained contact of about a second is what draws the whistle.
    eng.holding = clamp01(eng.holding + (holdRate - 0.13) * dt * 2.6);

    // Sinking: pushing an opponent under. Detected as downward pressure while the
    // opponent is trying to elevate.
    const sinkRate = clamp01((a.elevation < 0.08 ? 1 : 0.25) * grabIntent * (b.elevation > 0.10 ? 1 : 0.5));
    eng.sinking = clamp01(eng.sinking + (sinkRate - 0.16) * dt * 2.1);

    const severityNow = clamp01(
      eng.holding * 0.62 + eng.sinking * 0.5 + eng.impeding * 0.28 * (aHasBall ? 0.35 : 1)
    ) * lerp(1.2, 0.75, discipline);

    eng.severity = lerp(eng.severity, severityNow, 1 - Math.exp(-7 * dt));
    eng.peak = Math.max(eng.peak, eng.severity);
    eng.aHasBall = aHasBall;
    eng.ballNear = ballNear;
  }

  /** Steps 7-15: classify, apply advantage, check visibility, whistle. */
  _classify(eng, ball, ctx) {
    // A foul is an event, not a metronome. Letting the carrier draw fouls at all
    // (see holdRate) pushed the whistle to 17.5 a match, which is a stoppage
    // every seventeen seconds; the threshold carries that back down.
    if (eng.cooldown > 0 || eng.severity < 0.64) return null;
    const { a, b } = eng;

    // Fouls are called where the play is. A tussle eight metres from the ball
    // was being whistled - including exclusions - so from the player's seat the
    // referee stopped the game for something happening out of play. The man with
    // the ball, and whoever is fighting for position near it, are what count.
    const offBall = Math.hypot(ball.pos.x - a.pos.x, ball.pos.z - a.pos.z);
    if (!eng.aHasBall && offBall > 4.5) return null;
    const f = ctx.profile.field;

    // Step 7: location relative to goal.
    const goalZ = a.attackDir * (f.length / 2);
    const distToGoal = Math.hypot(a.pos.x - 0, a.pos.z - goalZ);
    const insidePenaltyArea = distToGoal < f.penaltyLine + 0.4 &&
      Math.abs(a.pos.z - goalZ) < f.penaltyLine + 0.4;

    // Step 8: was a probable goal prevented?
    const gk = ctx.goalkeeperFor?.(b.side);
    const probableGoal = eng.aHasBall && distToGoal < f.penaltyLine + 0.6 &&
      a.facingQuality(0, goalZ) > 0.5 &&
      (!gk || Math.abs(gk.pos.x - a.pos.x) > 0.9);

    // Step 9: advantage. If the attacking player is still clearly better off,
    // the referee lets it go (section 15.5).
    const advantage = eng.aHasBall && a.speed > 0.75 && eng.severity < 0.545 &&
      a.facingQuality(0, goalZ) > 0.6;
    if (advantage) return null;

    // Step 10: referee visibility.
    const vis = this._visibility(a, ctx);
    const profileStrictness = { strict: 1.0, standard: 0.9, human: 0.74 }[ctx.refereeProfile] ?? 0.9;
    const seen = vis * profileStrictness;
    if (ctx.refereeProfile !== 'strict') {
      if (this.rng.next() > clamp01(seen * 1.25)) return null; // genuinely missed
    }

    // Step 11: classify.
    let type = FOUL.ORDINARY;
    let reason = 'impeding a player not holding the ball';

    // Where the defender is decides what the foul is, which is how the sport
    // actually works and what the model was missing entirely:
    //
    //   IN FRONT  - the defender is goalside, pressing down on a player trying to
    //               rise. That is an ordinary foul; the attack restarts with a
    //               free throw.
    //   BEHIND    - the defender has been beaten and pulls the attacker back by
    //               the shoulder or leg. That is an exclusion, because it is the
    //               only way to stop someone who has already gone past you.
    const behindWork = eng.behindWork ?? 0;
    const frontWork = eng.frontWork ?? 0;
    const fromBehind = behindWork > frontWork * 0.85 && behindWork > 0.05;
    const heavy = eng.holding > 0.74 || eng.sinking > 0.66;
    // Pulling someone back from behind IS the exclusion foul - it does not need
    // to be as extreme as a front hold to be one, because there is no legal
    // version of it. Front contact has to get genuinely heavy before it counts.
    if ((heavy || eng.holding > 0.56 || eng.sinking > 0.48) && fromBehind) {
      type = FOUL.EXCLUSION;
      reason = eng.sinking > eng.holding
        ? 'sinking an opponent from behind'
        : 'holding and pulling an opponent back from behind';
    } else if (heavy) {
      reason = eng.sinking > eng.holding
        ? 'pushing an opponent under while defending in front'
        : 'holding an opponent while defending in front';
    }
    if (heavy && insidePenaltyArea && probableGoalPrevented(eng, probableGoal)) {
      type = FOUL.PENALTY;
      reason = 'foul inside the five metre area preventing a probable goal';
    }
    if (eng.severity > 0.985 && eng.holding > 0.95 && eng.sinking > 0.9) {
      type = FOUL.BRUTALITY;
      reason = 'violent conduct';
    }

    eng.cooldown = 1.4;
    eng.reported = true;
    const peak = eng.peak;
    eng.peak = 0;
    eng.holding *= 0.2;
    eng.sinking *= 0.2;
    eng.severity *= 0.25;
    const workBehind = eng.behindWork ?? 0;
    const workFront = eng.frontWork ?? 0;
    eng.behindWork = 0;
    eng.frontWork = 0;

    return {
      type,
      reason,
      offender: b,
      victim: a,
      // How the engagement was built, front vs behind. Kept on the record so the
      // front/behind rule can be measured rather than guessed at.
      workBehind, workFront,
      holding: eng.holding, sinking: eng.sinking,
      at: { x: (a.pos.x + b.pos.x) / 2, z: (a.pos.z + b.pos.z) / 2 },
      severity: peak,
      insidePenaltyArea,
      probableGoal,
      visibility: vis,
      time: ctx.matchTime,
    };
  }

  /** Referee sightline: distance, angle and occlusion by bodies and splash. */
  _visibility(target, ctx) {
    let best = 0;
    for (const ref of this.referees) {
      const d = Math.hypot(ref.x - target.pos.x, ref.z - target.pos.z);
      let v = clamp01(1 - (d - 4) / 14);
      let occ = 0;
      for (const other of ctx.allAthletes) {
        if (other === target || !other.inPool) continue;
        const s = segmentPointDistance(ref.x, ref.z, target.pos.x, target.pos.z, other.pos.x, other.pos.z);
        if (s.t > 0.05 && s.t < 0.95 && s.dist < 0.55) occ += 0.16;
      }
      // Splash from nearby high-effort swimming hides contact.
      const splash = clamp01(target.contactLoad * 0.3 + target.exertion * 0.25);
      v *= clamp01(1 - occ) * (1 - splash * 0.35);
      best = Math.max(best, v);
    }
    return clamp01(best);
  }

  reset() {
    this.engagements.clear();
  }
}

function probableGoalPrevented(eng, probableGoal) {
  return probableGoal || (eng.impeding > 0.75 && eng.severity > 0.8);
}
