/**
 * Hierarchical water polo AI (Design Bible section 21).
 *
 * Seven layers, exactly as specified:
 *   1 Coach strategy      - match plan, risk, substitutions, tempo
 *   2 Team tactical       - formation, pressing scheme, transition, set play
 *   3 Role                - each athlete's current responsibility
 *   4 Decision            - pass / drive / shoot / screen / foul / press / drop
 *   5 Local movement      - a physically viable path through water and contact
 *   6 Execution           - force, timing and target for the chosen action
 *   7 Learning            - opponent tendencies feed back into layer 4
 *
 * Difficulty never inflates attributes beyond their published ratings
 * (section 19.2). It changes reaction time, recognition, error frequency,
 * adaptation and risk assessment only.
 */

import { Vec2, clamp, clamp01, lerp, dist2, angleDelta, smoothstep } from '../core/Math2.js';
import {
  OFFENSIVE_SYSTEMS, DEFENSIVE_SYSTEMS, EXTRA_PLAYER_SYSTEMS, MAN_DOWN_SYSTEMS,
  slotToWorld, markingSpot,
} from './Tactics.js';
import { pressureOn, laneOpenness, shotQuality, SHOT_TYPES, PASS_TYPES, contextualShotType } from '../gameplay/Actions.js';

const a01 = (v) => clamp01((v - 10) / 85);

/**
 * Difficulty never inflates attributes - it changes how quickly the AI reads
 * play and how tightly it presses.
 *
 * `press` is how close the defence lives to the ball carrier: an amateur side
 * gives you room to swim and think, a legendary one is on your shoulder. It
 * used to be missing entirely, so every level marked you equally tightly and
 * the carrier had nowhere to go regardless of the level you picked.
 *
 * Reaction times are deliberately longer than a real athlete's across the
 * board: the player needs a beat to see what is happening and act on it.
 */
export const DIFFICULTY = {
  amateur:      { react: 0.66, recognition: 0.42, error: 0.34, adapt: 0.15, risk: 0.35, gkDiscipline: 0.35, subQuality: 0.35, press: 0.30, label: 'Amateur' },
  club:         { react: 0.52, recognition: 0.58, error: 0.24, adapt: 0.30, risk: 0.45, gkDiscipline: 0.52, subQuality: 0.55, press: 0.48, label: 'Club' },
  national:     { react: 0.40, recognition: 0.74, error: 0.16, adapt: 0.50, risk: 0.55, gkDiscipline: 0.70, subQuality: 0.72, press: 0.64, label: 'National' },
  international:{ react: 0.30, recognition: 0.87, error: 0.10, adapt: 0.72, risk: 0.66, gkDiscipline: 0.85, subQuality: 0.88, press: 0.82, label: 'International' },
  legendary:    { react: 0.22, recognition: 0.96, error: 0.06, adapt: 0.9,  risk: 0.74, gkDiscipline: 0.94, subQuality: 0.95, press: 0.97, label: 'Legendary' },
};

/** Layer 7: opponent tendency memory. Gradual and explainable, never psychic. */
class TendencyMemory {
  constructor() {
    this.centreEntrySide = { left: 0, right: 0 };
    this.shotZones = new Map();   // "x,z" bucket -> count
    this.shooterUse = new Map();  // athlete id -> count
    this.pumpFakeBeforeShot = 0;
    this.shotsObserved = 0;
    this.counterExposure = 0;
    this.extraPlayerPattern = new Map();
  }
  noteShot(athlete, at, afterFake) {
    this.shotsObserved++;
    const key = `${Math.round(at.x / 2)},${Math.round(at.z / 2)}`;
    this.shotZones.set(key, (this.shotZones.get(key) ?? 0) + 1);
    this.shooterUse.set(athlete.id, (this.shooterUse.get(athlete.id) ?? 0) + 1);
    if (afterFake) this.pumpFakeBeforeShot++;
  }
  noteCentreEntry(fromX) {
    if (fromX < 0) this.centreEntrySide.left++; else this.centreEntrySide.right++;
  }
  /** 0..1 confidence that this athlete is the primary threat. */
  threatBias(athlete) {
    if (this.shotsObserved < 5) return 0;
    return clamp01((this.shooterUse.get(athlete.id) ?? 0) / this.shotsObserved * 2.2 - 0.25);
  }
  fakeBias() {
    return this.shotsObserved < 4 ? 0 : clamp01(this.pumpFakeBeforeShot / this.shotsObserved);
  }
  entryBias() {
    const t = this.centreEntrySide.left + this.centreEntrySide.right;
    if (t < 4) return 0;
    return (this.centreEntrySide.right - this.centreEntrySide.left) / t;
  }
  /** Plain-language summary for the analyst commentary and the debug overlay. */
  summary() {
    const out = [];
    const eb = this.entryBias();
    if (Math.abs(eb) > 0.45) out.push(`entering the centre from the ${eb > 0 ? 'right' : 'left'} almost every time`);
    if (this.fakeBias() > 0.55) out.push('pump faking before nearly every shot');
    let top = null, topN = 0;
    for (const [id, n] of this.shooterUse) if (n > topN) { topN = n; top = id; }
    if (top && topN / Math.max(1, this.shotsObserved) > 0.45) out.push('leaning on one shooter');
    return out;
  }
}

export class TeamAI {
  /**
   * @param {'home'|'away'} side
   * @param {object} tactics from makeTeamTactics
   * @param {string} difficultyKey
   */
  constructor(side, tactics, difficultyKey = 'national', rng) {
    this.side = side;
    this.tactics = tactics;
    this.diff = DIFFICULTY[difficultyKey] ?? DIFFICULTY.national;
    this.difficultyKey = difficultyKey;
    this.rng = rng;
    this.memory = new TendencyMemory();

    this.coachTimer = 0;
    this.plan = { tempo: tactics.tempo, riskTolerance: 0.5, pressLevel: 0.6, pullKeeper: false };
    this.slotAssign = new Map();   // athlete id -> slot index
    this.markAssign = new Map();   // defender id -> attacker id
    this.reactionClock = new Map();// athlete id -> seconds until it may act
    this.driveTimer = 0;
    this.setPlayTimer = 0;
    this.lastDecision = new Map(); // for the debug overlay (section 21.6)
    this.counterCommit = false;
  }

  /** Layer 1. Runs a few times a second, not every frame. */
  updateCoach(dt, ctx) {
    this.coachTimer -= dt;
    if (this.coachTimer > 0) return;
    this.coachTimer = 0.8;

    const { sim } = ctx;
    const score = sim.score;
    const diffScore = (this.side === 'home' ? score.home - score.away : score.away - score.home);
    const timeLeft = sim.timeRemainingInMatch();

    // Risk rises when behind late, falls when protecting a lead.
    const urgency = clamp01((-diffScore + 1) / 3) * clamp01(1 - timeLeft / 480);
    this.plan.riskTolerance = clamp01(0.35 + urgency * 0.55 + this.diff.risk * 0.25);
    this.plan.tempo = clamp01(this.tactics.tempo + urgency * 0.4 -
      (this.tactics.triggers.find((t) => t.id === 'slowWhenLeading')?.on && diffScore > 1 ? 0.3 : 0));

    // Pressing costs stamina: back off when the squad is cooked.
    const squad = sim.activeAthletes(this.side).filter((p) => !p.isGoalkeeper);
    const avgFresh = squad.reduce((s, p) => s + p.freshness, 0) / Math.max(1, squad.length);
    // Difficulty decides how hard this side presses. Without it every level
    // marked the carrier equally tightly, so choosing Amateur did nothing to
    // give the player room.
    this.plan.pressLevel = clamp01(
      DEFENSIVE_SYSTEMS[this.tactics.defense].pressure
      * lerp(0.55, 1.1, avgFresh)
      * lerp(0.45, 1.15, this.diff.press ?? 0.64)
    );

    // Pull the goalkeeper when it is rational (section 16.4).
    const trigger = this.tactics.triggers.find((t) => t.id === 'pullKeeperLate');
    this.plan.pullKeeper = !!trigger?.on && diffScore < 0 && timeLeft < 60 &&
      sim.possession === this.side && this.diff.recognition > 0.5;

    // Substitutions (section 17.3). Quality of the decision scales with difficulty.
    if (this.rng.next() < this.diff.subQuality * 0.5) this._considerSubstitution(ctx, squad);

    // Timeout: only when in possession, late, and the attack has stalled.
    if (sim.possession === this.side && sim.shotClock < 7 && timeLeft < 120 &&
        Math.abs(diffScore) <= 1 && this.rng.next() < this.diff.recognition * 0.25) {
      sim.callTimeout(this.side, 'ai');
    }
  }

  _considerSubstitution(ctx, squad) {
    const { sim } = ctx;
    const bench = sim.benchAthletes(this.side).filter((p) => !p.isGoalkeeper && !p.excludedForMatch);
    if (!bench.length) return;
    // Only try when the substitution can actually be legal: during a stoppage,
    // or with a tired athlete already back in their own re-entry area. Asking
    // otherwise just generates refusals.
    const stoppage = !sim.isLive();
    const zone = sim.profile.substitution.reentryZoneLength + 0.5;
    const ownGoalZ = -sim.attackDir[this.side] * (sim.profile.field.length / 2);
    if (!stoppage && !squad.some((p) => Math.abs(p.pos.z - ownGoalZ) <= zone)) return;

    let worst = null, worstScore = 1e9;
    for (const p of squad) {
      const foulTrouble = this.tactics.triggers.find((t) => t.id === 'protectTwoFouls')?.on &&
        p.personalFouls >= sim.profile.discipline.personalFoulLimit - 1 ? 0.35 : 0;
      const s = p.freshness - foulTrouble;
      if (s < worstScore) { worstScore = s; worst = p; }
    }
    if (!worst || worstScore > 0.62) return;
    if (!stoppage && Math.abs(worst.pos.z - ownGoalZ) > zone) return;

    const replacement = bench
      .filter((p) => p.freshness > worstScore + 0.2)
      .sort((a, b) => (b.freshness * 40 + b.player.overall) - (a.freshness * 40 + a.player.overall))[0];
    if (replacement) sim.requestSubstitution(this.side, worst, replacement, 'ai');
  }

  /** Layers 2 and 3: formation and role assignment for the current phase. */
  assignRoles(ctx) {
    const { sim } = ctx;
    const mine = sim.activeAthletes(this.side).filter((p) => !p.isGoalkeeper);
    const attacking = sim.possession === this.side;
    const theirs = sim.activeAthletes(this.side === 'home' ? 'away' : 'home').filter((p) => !p.isGoalkeeper);

    this.slotAssign.clear();
    this.markAssign.clear();

    if (attacking) {
      const extra = mine.length > theirs.length;
      const system = extra
        ? EXTRA_PLAYER_SYSTEMS[this.tactics.extraPlayer]
        : OFFENSIVE_SYSTEMS[this.tactics.offense];
      const slots = system.slots;

      // Assign by role affinity then by proximity, so the centre forward really
      // is the centre forward and nobody swims across the pool to a slot.
      const pool = mine.slice();
      const used = new Set();
      slots.forEach((slot, i) => {
        let best = null, bestScore = -1e9;
        for (const p of pool) {
          if (used.has(p.id)) continue;
          const world = slotToWorld(slot, p.attackDir, sim.profile);
          const affinity =
            (slot.role && p.player.position === slot.role ? 3.2 : 0) +
            (slot.role && p.player.secondaryPosition === slot.role ? 1.4 : 0);
          const proximity = -dist2(p.pos, world) * 0.16;
          const s = affinity + proximity;
          if (s > bestScore) { bestScore = s; best = p; }
        }
        if (best) { used.add(best.id); this.slotAssign.set(best.id, i); best.roleSlot = { ...slot, index: i, system }; }
      });
    } else {
      const manDown = mine.length < theirs.length;
      if (manDown) {
        const zone = MAN_DOWN_SYSTEMS[this.tactics.manDown];
        mine.forEach((p, i) => {
          const slot = zone.slots[i % zone.slots.length];
          p.roleSlot = { ...slot, index: i, system: zone, zone: true };
          this.slotAssign.set(p.id, i);
        });
      } else {
        // Man marking, matched by threat and by physical suitability.
        const attackers = theirs.slice().sort((a, b) =>
          (b.player.overall + this.memory.threatBias(b) * 30) - (a.player.overall + this.memory.threatBias(a) * 30));
        const defenders = mine.slice();
        const scheme = DEFENSIVE_SYSTEMS[this.tactics.defense];

        for (const att of attackers) {
          let best = null, bestScore = -1e9;
          for (const d of defenders) {
            if (this.markAssign.has(d.id)) continue;
            const centreMatch = att.player.position === 'CF'
              ? (d.player.position === 'CD' ? 3.5 : d.player.secondaryPosition === 'CD' ? 1.5 : 0)
              : 0;
            const s = centreMatch - dist2(d.pos, att.pos) * 0.2 + a01(d.player.attr.marking) * 1.2;
            if (s > bestScore) { bestScore = s; best = d; }
          }
          if (best) { this.markAssign.set(best.id, att.id); best.markTarget = att; best.roleSlot = null; }
        }
        // Double team the star if the scheme or the trigger asks for it.
        const doubleTrigger = this.tactics.triggers.find((t) => t.id === 'doubleStar')?.on;
        if ((scheme.doubleBest || doubleTrigger) && attackers.length) {
          const star = attackers[0];
          const spare = mine.find((d) => this.markAssign.get(d.id) !== star.id &&
            dist2(d.pos, star.pos) < 5 && this.rng.next() < this.diff.recognition);
          if (spare) { this.markAssign.set(spare.id, star.id); spare.markTarget = star; }
        }
      }
    }
  }

  /** Layers 4-6, per athlete, every frame. */
  update(dt, ctx) {
    const { sim } = ctx;
    this.updateCoach(dt, ctx);
    this.driveTimer -= dt;

    const mine = sim.activeAthletes(this.side);
    const opp = sim.activeAthletes(this.side === 'home' ? 'away' : 'home');
    const attacking = sim.possession === this.side;

    // Swim-off: exactly ONE athlete (the fastest) sprints for the centre ball.
    // Everyone else takes up their attacking formation, so the pool does not
    // collapse into a scrum at the half line.
    if (sim.state === 'swimOff') {
      const field = mine.filter((p) => p.inPool && !p.isGoalkeeper);
      if (!this._sprinter || !field.includes(this._sprinter)) {
        this._sprinter = field.slice().sort((a, b) => b.player.attr.swimSpeed - a.player.attr.swimSpeed)[0];
      }
      const system = OFFENSIVE_SYSTEMS[this.tactics.offense];
      let slotI = 0;
      for (const p of field) {
        if (sim.userControlsSide === this.side && p === sim.userAthlete) continue;
        if (p === this._sprinter) {
          const to = new Vec2(sim.ball.pos.x - p.pos.x, sim.ball.pos.z - p.pos.z);
          p.cmd = { dir: to.length() > 0.1 ? to.normalize() : null, effort: 1, rise: 0, face: null, brace: false };
        } else {
          const slot = system.slots[slotI % system.slots.length]; slotI++;
          const w = slotToWorld(slot, p.attackDir, sim.profile);
          const to = new Vec2(w.x - p.pos.x, w.z - p.pos.z);
          p.cmd = { dir: to.length() > 0.4 ? to.normalize() : null, effort: clamp01(to.length() / 4) * 0.9, arriveDist: to.length(), rise: 0.2, face: null, brace: false };
        }
      }
      return;
    }
    this._sprinter = null;

    if (sim.roleDirty || this._lastPhase !== attacking || this._lastCount !== mine.length) {
      this.assignRoles(ctx);
      this._lastPhase = attacking;
      this._lastCount = mine.length;
    }

    for (const p of mine) {
      if (!p.inPool) continue;
      // Skip the athlete a real human is driving. Never skip in AI-vs-AI
      // (no controlling side), or the carrier would freeze and never act.
      if (sim.userControlsSide === this.side && p === sim.userAthlete) continue;
      if (p.isGoalkeeper) continue; // handled by GoalkeeperAI

      // Reaction clock: difficulty delays *recognition*, not physical ability.
      let clock = (this.reactionClock.get(p.id) ?? 0) - dt;
      const mayAct = clock <= 0;
      if (mayAct) clock = this.diff.react * this.rng.range(0.6, 1.4);
      this.reactionClock.set(p.id, clock);

      // A loose ball outranks everything else. Both teams contest it - the
      // side that lost possession does not stand in its formation and watch.
      const chase = this._looseBall(p, ctx, mine, opp);
      const cmd = chase
        ?? (attacking
          ? this._offense(p, dt, ctx, mayAct, opp, mine)
          : this._defense(p, dt, ctx, mayAct, opp, mine));
      p.cmd = cmd;
    }

    // Hard spacing pass: off-ball teammates actively keep clear water between
    // them so the pool never collapses into a scrum around the ball. This runs
    // after per-athlete decisions and gently overrides their heading when they
    // are crowding a teammate - the single biggest readability/playability win.
    this._enforceSpacing(sim, mine);
  }

  /**
   * Personal space. This is deliberately a gentle NUDGE, not an override: the
   * formation decides where a player belongs, and this only stops two teammates
   * occupying the same water. An aggressive version of this locked the whole
   * team into a straight line and stopped formations forming at all.
   */
  _enforceSpacing(sim, mine) {
    const SPACE = 2.7;
    for (const p of mine) {
      if (!p.inPool || p.isGoalkeeper || !p.cmd) continue;
      if (p === sim.ball.holder) continue;
      if (sim.userControlsSide === this.side && p === sim.userAthlete) continue;
      let sx = 0, sz = 0, crowd = 0;
      for (const t of mine) {
        if (t === p || t.isGoalkeeper || !t.inPool) continue;
        const d = dist2(p.pos, t.pos);
        if (d < SPACE && d > 1e-3) { sx += (p.pos.x - t.pos.x) / d * (SPACE - d); sz += (p.pos.z - t.pos.z) / d * (SPACE - d); crowd++; }
      }
      if (!crowd) continue;
      const sep = new Vec2(sx, sz);
      if (sep.length() < 0.05) continue;
      sep.normalize();
      const cur = p.cmd.dir ?? new Vec2(0, 0);
      // Small, fixed blend so intent always wins over the nudge.
      const blended = new Vec2(cur.x + sep.x * 0.5, cur.z + sep.z * 0.5);
      if (blended.length() > 0.05) { blended.normalize(); p.cmd.dir = blended; }
      // Crowded players need room to actually move out of the pile.
      p.cmd.arriveDist = Math.max(p.cmd.arriveDist ?? 0, 1.2);
      p.cmd.effort = Math.max(p.cmd.effort ?? 0, 0.55);
    }
  }

  /**
   * Contest a loose ball. Only the single nearest teammate goes for it (plus
   * anyone it lands on top of); everyone else keeps their shape. A loose ball is
   * not a signal for the whole team to swim into one spot.
   */
  _looseBall(p, ctx, mine, opp) {
    const { sim } = ctx;
    const ball = sim.ball;
    if (!ball.isLoose || ball.timeSinceLoose < 0.08) return null;
    if (p.isGoalkeeper) return null;
    // A pass in flight belongs to its intended receiver, who is already moving
    // to it - the rest of the team must not collapse onto every pass.
    if (ball.kind === 'pass' && ball.timeSinceLoose < 1.4) {
      const rx = ball.intendedReceiver;
      // ...but the intended receiver is the one player who MUST go and meet it.
      // Lumping them in with their teammates meant nobody moved to the ball for
      // the first 1.4s of every pass, so passes routinely died in open water.
      if (rx === p) { /* fall through and swim to it */ }
      else if (!rx || rx.side === p.side) return null;
    }

    const d = (a) => Math.hypot(ball.pos.x - a.pos.x, ball.pos.z - a.pos.z);
    const mineRanked = mine.filter((a) => a.inPool && !a.isGoalkeeper).sort((a, b) => d(a) - d(b));
    const rank = mineRanked.indexOf(p);
    const myDist = d(p);
    // Rank-based, never proximity-based. The old rule let anyone within 1.4m
    // chase, which is self-reinforcing: once the team bunches, everyone is
    // within 1.4m of the ball, so everyone chases, so the bunch never breaks up.
    // Ranking can't cascade like that. The second-nearest joins only a genuine
    // scramble - a ball that has been loose long enough to be up for grabs, not
    // a pass in flight - because leaving rebounds to one player alone let balls
    // trickle into the net unchallenged.
    const scramble = ball.timeSinceLoose > 0.5 && myDist < 3.0;
    const isTarget = ball.kind === 'pass' && ball.intendedReceiver === p;

    // CRASH THE GOAL. A shot spilling around the opponent's cage is the most
    // dangerous ball in the sport, and attackers go and get it. Leaving it to
    // the single nearest player meant rebounds were recovered further out and
    // under more pressure than the original shot, so second chances were worth
    // LESS than first ones - the opposite of how water polo works.
    const attackGoalZ = p.attackDir * (sim.profile.field.length / 2);
    const isRebound = (ball.kind === 'shot' || ball.kind === 'deflection') &&
      Math.abs(attackGoalZ - ball.pos.z) < 5.5;
    const crashing = isRebound && myDist < 5.5;

    if (!isTarget && rank > (crashing ? 2 : scramble ? 1 : 0)) return null;

    // Lead the ball rather than swimming at where it currently is.
    const lead = clamp01(myDist / 6) * 0.42;
    const tx = ball.pos.x + ball.vel.x * lead;
    const tz = ball.pos.z + ball.vel.z * lead;

    const cmd = { dir: null, effort: 1, rise: 0, face: null, brace: false };
    const to = new Vec2(tx - p.pos.x, tz - p.pos.z);
    if (to.length() > 0.12) cmd.dir = to.normalize();
    cmd.arriveDist = Math.max(myDist, 1.5);
    cmd.face = Math.atan2(ball.pos.x - p.pos.x, ball.pos.z - p.pos.z);
    if (ball.pos.y > 0.55) cmd.rise = clamp01((ball.pos.y - 0.3) / 0.9);
    if (myDist < 0.9) cmd.effort = 0.55;

    this._note(p, 'contest loose ball', myDist);
    return cmd;
  }

  // -------------------------------------------------------------------------
  // Offense
  // -------------------------------------------------------------------------
  _offense(p, dt, ctx, mayAct, opp, mine) {
    const { sim } = ctx;
    const profile = sim.profile;
    const ball = sim.ball;
    const carrier = ball.holder;
    const cmd = { dir: null, effort: 0, rise: 0, face: null, brace: false };

    // --- Counterattack --------------------------------------------------
    // Only the two best-placed swimmers break; the rest build the set. And they
    // sprint up their OWN LANE (their formation x), not straight at the ball -
    // otherwise the whole team converges on one spot and it looks like everyone
    // is chasing the ball.
    const counterLane = this._counterValue(p, sim, opp);
    if (sim.transitionTimer > 0 && counterLane > 0.45 && this._isCounterRunner(p, mine, sim)) {
      const slotW = p.roleSlot ? slotToWorld(p.roleSlot, p.attackDir, profile) : { x: p.pos.x, z: 0 };
      const goalZ = p.attackDir * (profile.field.length / 2 - 3.2);
      const to = new Vec2(slotW.x - p.pos.x, goalZ - p.pos.z);
      cmd.arriveDist = to.length();
      cmd.dir = to.normalize();
      cmd.effort = 1;
      cmd.sprint = true;
      this._note(p, 'counter sprint', counterLane);
      if (p === carrier) return this._carrier(p, dt, ctx, mayAct, opp, mine, cmd);
      return cmd;
    }

    if (p === carrier) return this._carrier(p, dt, ctx, mayAct, opp, mine, cmd);

    // --- Off-ball: hold the slot, drive, or present at the centre ----------
    const slotIndex = this.slotAssign.get(p.id);
    const system = p.roleSlot?.system ?? OFFENSIVE_SYSTEMS[this.tactics.offense];
    const slot = p.roleSlot ?? system.slots[slotIndex ?? 0];
    let target = slotToWorld(slot, p.attackDir, profile);

    // Until the attack is established the shape travels WITH the ball: hold your
    // lane across the pool and stay level with play. Sprinting the full length of
    // the pool to a fixed spot leaves the whole team strung out behind the ball,
    // which is what made it look like everyone was chasing it.
    {
      const goalZ2 = p.attackDir * (profile.field.length / 2);
      const ballZ = sim.ball.pos.z;
      const ballToGoal = Math.abs(goalZ2 - ballZ);
      const setness = clamp01((11 - ballToGoal) / 5);   // 1 once we are in the attacking third
      const transitZ = ballZ + p.attackDir * clamp(4.5 - slot.d * 0.5, -1.5, 3.5);
      target = { x: target.x, z: lerp(transitZ, target.z, setness) };
    }

    const isCentre = slot.role === 'CF' || slot.role === 'post';
    const marker = opp.find((d) => d.markTarget === p) ??
      opp.filter((d) => !d.isGoalkeeper).sort((a, b) => dist2(a.pos, p.pos) - dist2(b.pos, p.pos))[0];

    if (isCentre && carrier) {
      // Centre play (section 15.3): seal on the ball side, present a target hand.
      const ballSide = Math.sign(carrier.pos.x || 0.01);
      target = {
        x: clamp(ballSide * -0.7, -1.6, 1.6),
        z: p.attackDir * (profile.field.length / 2 - 2.0),
      };
      cmd.brace = true;
      cmd.rise = 0.35 + 0.25 * clamp01(1 - dist2(p.pos, carrier.pos) / 8);
      cmd.face = Math.atan2(carrier.pos.x - p.pos.x, carrier.pos.z - p.pos.z);
      if (marker && dist2(marker.pos, p.pos) < 1.2) {
        // Fight for inside water rather than swimming away from contact.
        const away = new Vec2(p.pos.x - marker.pos.x, p.pos.z - marker.pos.z).normalize();
        target = { x: p.pos.x + away.x * 0.6, z: p.pos.z + away.z * 0.4 };
      }
    } else if (mayAct && this.driveTimer <= 0 && carrier &&
               Math.hypot(target.x - p.pos.x, target.z - p.pos.z) < 3.0 &&
               this.rng.next() < system.driveBias * this.plan.tempo * 0.35) {
      // Drive: cut hard toward the goal through the gap the marker leaves.
      const driveFor = this.rng.range(1.0, 1.7);
      p.driving = { until: sim.clockNow + driveFor, lane: this.rng.range(-1, 1) };
      this.driveTimer = driveFor + this.rng.range(1.8, 3.2);  // outlast the drive
    }

    if (p.driving && sim.clockNow < p.driving.until) {
      const goalZ = p.attackDir * (profile.field.length / 2 - 2.4);
      target = { x: clamp(p.pos.x + p.driving.lane * 2.4, -6.5, 6.5), z: goalZ };
      cmd.effort = 1;
      this._note(p, 'driving', 1);
    } else {
      p.driving = null;
      // Avoid clustering (section 21.2): push away from every nearby teammate.
      // Water polo spacing is wide, so the comfortable radius is generous and the
      // push is firm - crowding kills passing angles and invites double teams.
      for (const t of mine) {
        if (t === p || t.isGoalkeeper) continue;
        const d = dist2(t.pos, p.pos);
        if (d < 2.4 && d > 1e-3) {
          const push = (2.4 - d) * 0.5;
          target.x += (p.pos.x - t.pos.x) / d * push;
          target.z += (p.pos.z - t.pos.z) / d * push;
        }
      }
    }

    // Final separation pass, applied in every case so the shape never collapses -
    // even a sealing centre or a driver keeps a metre of water around teammates.
    // The push is accumulated and then CLAMPED: summing five unclamped pushes
    // used to fling the target tens of metres outside a 10x25m pool, which made
    // the steering meaningless (every player just sprinted at a wall).
    let px = 0, pz = 0;
    for (const t of mine) {
      if (t === p || t.isGoalkeeper) continue;
      const dd = dist2(t.pos, p.pos);
      if (dd < 2.8 && dd > 1e-3) {
        const push = (2.8 - dd) * 1.5;
        px += (p.pos.x - t.pos.x) / dd * push;
        pz += (p.pos.z - t.pos.z) / dd * push;
      }
    }
    const pl = Math.hypot(px, pz);
    if (pl > 2.5) { px = px / pl * 2.5; pz = pz / pl * 2.5; }
    target = { x: target.x + px, z: target.z + pz };

    // Keep the target inside the water. An unreachable target reads as a player
    // swimming into the wall instead of taking up a position.
    const halfW = profile.field.width / 2 - 0.6;
    const halfL = profile.field.length / 2 - 0.6;
    target = { x: clamp(target.x, -halfW, halfW), z: clamp(target.z, -halfL, halfL) };

    // Fan out into your LANE first, then advance up the pool. Without this the
    // whole team travels from a turnover as one blob directly behind the ball,
    // which is what reads as "everyone is chasing the ball".
    // STABILISE THE STATION. Everything above recomputes a fresh target 60 times
    // a second - slot, transit blend, separation pushes, drive rolls - and the
    // result jitters far faster than a swimmer can respond. Measured: off-ball
    // players sat 8m from their own target and closed on it only 49% of frames,
    // i.e. a coin flip, so nobody ever arrived anywhere and the whole team just
    // hovered around the ball. Easing the station with a ~0.3s time constant
    // filters the jitter while still tracking genuine changes within half a
    // second. This is what lets a formation actually form.
    target = smoothTarget(p, target, dt);

    const dxs = target.x - p.pos.x;
    const dzs = target.z - p.pos.z;
    const d = Math.hypot(dxs, dzs);
    const lateralBias = 1 + clamp01(d / 6) * 1.8;
    const to = new Vec2(dxs * lateralBias, dzs);
    cmd.dir = d > 0.25 ? to.normalize() : null;
    cmd.arriveDist = d;
    // Get to the spread set quickly after a turnover - crowding is the enemy.
    cmd.effort = Math.max(cmd.effort, clamp01(d / 1.5) * lerp(0.8, 1.0, this.plan.tempo));
    if (d > 4) cmd.sprint = true;   // sprint into the set, then settle
    if (!isCentre && carrier) cmd.face = Math.atan2(carrier.pos.x - p.pos.x, carrier.pos.z - p.pos.z);
    if (d < 0.6 && !p.driving) { cmd.rise = Math.max(cmd.rise, 0.3); cmd.effort *= 0.5; }
    return cmd;
  }

  _carrier(p, dt, ctx, mayAct, opp, mine, cmd) {
    const { sim } = ctx;
    const profile = sim.profile;
    const goalZ = p.attackDir * (profile.field.length / 2);
    const pressure = pressureOn(p, opp);
    const distToGoal = Math.hypot(p.pos.x, goalZ - p.pos.z);
    const clock = sim.shotClock;
    const system = OFFENSIVE_SYSTEMS[this.tactics.offense];
    const gk = sim.goalkeeperFor(this.side === 'home' ? 'away' : 'home');

    // --- Evaluate options as expected value, not as arbitrary weights ------
    // Every option is scored on the same scale: roughly "probability this leads
    // to a goal from here". That is what lets shooting genuinely beat passing
    // when the shot is there, instead of the ball circulating forever.
    const options = [];
    const clockPanic = clamp01((6 - clock) / 6);

    /** Expected shot value for an athlete standing where they are now. */
    const shotValueFor = (athlete, aimOverride) => {
      const gz = athlete.attackDir * (profile.field.length / 2);
      const aim = aimOverride ?? {
        x: clamp(-Math.sign(gk ? gk.pos.x - athlete.pos.x * 0.3 : 1) * 0.72, -0.85, 0.85),
        y: this.rng.range(0.12, 0.8),
      };
      const aimPt = { x: aim.x * (profile.field.goalWidth / 2 - 0.15), y: aim.y * 0.78, z: gz };
      const factorsStub = {
        pressure: pressureOn(athlete, opp),
        elevation: clamp01(athlete.elevation / Math.max(0.2, athlete.maxElevation)),
        shoulder: athlete.facingQuality(aimPt.x, aimPt.z),
        freshness: athlete.freshness,
        blockOpen: laneOpenness(athlete.pos, aimPt, opp).open,
      };
      const q = shotQuality({
        distance: Math.hypot(athlete.pos.x - aimPt.x, gz - athlete.pos.z),
        angle: Math.abs(Math.atan2(athlete.pos.x, Math.abs(gz - athlete.pos.z))),
        goalkeeper: gk, shooter: athlete, factors: factorsStub, profile,
      });
      return { q, aim, aimPt };
    };

    const own = shotValueFor(p);
    const sq = own.q;

    // Shooting: quality is raised to a power so a poor shot scores very little and
    // driving/passing win instead - the carrier only commits to a shot it can
    // actually make. Clock panic overrides this so a dying possession still fires.
    options.push({
      kind: 'shoot',
      score: Math.pow(sq, 1.35) * lerp(1.15, 1.7, system.shootBias) * lerp(0.9, 1.25, this.plan.riskTolerance)
        + clockPanic * 0.8
        - (p.actionLock > 0 ? 0.4 : 0),
      aim: own.aim, aimPt: own.aimPt, quality: sq,
    });

    // Passing: the receiver's chance, discounted by how likely the pass is to
    // arrive at all. A pass is only worth making if it improves the position.
    for (const t of mine) {
      if (t === p || !t.inPool) continue;
      if (t.isGoalkeeper && distToGoal < 14) continue;
      const tDist = dist2(p.pos, t.pos);
      if (tDist > 17 || tDist < 1.2) continue;
      const lane = laneOpenness(p.pos, t.pos, opp);
      if (lane.open <= 0.02) continue;

      const isCentreEntry = t.roleSlot?.role === 'CF' || t.roleSlot?.role === 'post';
      const mate = shotValueFor(t);
      const tPressure = pressureOn(t, opp);
      const completion = clamp01(lane.open * lerp(0.72, 1.0, a01(p.player.attr.shortPass)) *
        lerp(1.0, 0.82, clamp01(tDist / 16)));

      // Circulation has value even when the receiver cannot shoot: it moves the
      // defence. That is the small constant term.
      const positional = 0.12 + 0.16 * clamp01((distToGoal - Math.hypot(t.pos.x, goalZ - t.pos.z)) / 6);
      let score = completion * (0.72 * mate.q + positional + 0.10 * (1 - tPressure));
      if (isCentreEntry) score *= 1 + system.entryBias * 0.55;
      // Getting out of trouble is worth something on its own.
      score += pressure * completion * 0.14;

      // Recognition noise: weaker AI misjudges lanes and teammates.
      score += this.rng.gauss(0, (1 - this.diff.recognition) * 0.14);
      options.push({
        kind: 'pass', target: t, score, lane: lane.open,
        type: isCentreEntry ? PASS_TYPES.ENTRY : (tDist > 9 ? PASS_TYPES.CROSS : PASS_TYPES.DRY),
      });
    }

    // Driving: worth it when there is water in front and the shot is not yet on.
    // A carrier that is still a long way out MUST advance the ball, so driving
    // gains a large bonus the further from goal it is - this is what stops the
    // whole team circulating at midfield and never attacking the cage.
    const driveLane = laneOpenness(p.pos, { x: p.pos.x * 0.4, z: goalZ - p.attackDir * 3 }, opp);
    const needToAdvance = clamp01((distToGoal - 6.5) / 6);
    options.push({
      kind: 'drive',
      score: driveLane.open * (0.28 + 0.55 * needToAdvance) * (0.75 + system.driveBias * 0.5)
        + a01(p.player.attr.swimSpeed) * 0.08
        - pressure * 0.14
        - clockPanic * 0.2,
    });

    // Holding: only sane close to the set with time on the clock. Deep, it is
    // almost worthless - you do not kill a possession loitering in your own half.
    options.push({
      kind: 'hold',
      score: 0.14 * (1 - pressure) * clamp01(clock / 12) * (1 - needToAdvance) - clockPanic * 0.6,
    });

    options.sort((a, b) => b.score - a.score);
    let choice = options[0];
    this._note(p, choice.kind, choice.score, options.slice(1, 4));

    // --- Execute (layer 6) -------------------------------------------------
    // Settle first: an athlete who has just taken the ball needs a beat before
    // they can do anything with it, so possessions actually develop.
    // A PUT-BACK is instant. Making a player settle before shooting gave the
    // defence and a scrambling keeper time to reset, so a rebound collected in
    // front of the cage was worth no more than an ordinary set shot - which is
    // why second chances were converting worse than first ones.
    const goalDist = Math.hypot(p.pos.x, goalZ - p.pos.z);
    const putBack = goalDist < 6.0 && (gk ? (sim.gkBrain[gk.side]?.beaten ?? 0) > 0.10 : false);
    const settled = putBack || !p.justCaught || p.justCaught < 0.34;
    // A shot is worth taking if it is decent, or if the clock is dying (a
    // desperation shot beats a shot-clock turnover). If the chosen shot is not
    // good enough and there is still time, the carrier falls through to driving
    // rather than standing still holding the ball.
    const desperate = clock < 4.0;
    // A dying shot clock must produce a SHOT, not merely permit one. Requiring
    // the shot to already be the best-scoring option meant a carrier who
    // preferred a pass or a drive simply ran the clock out, so possessions ended
    // in shot-clock turnovers instead of attempts on goal.
    if (desperate && choice.kind !== 'shoot') {
      const shotOpt = options.find((o) => o.kind === 'shoot');
      if (shotOpt) choice = shotOpt;
    }
    if (putBack && choice.kind !== 'shoot') {
      const shotOpt = options.find((o) => o.kind === 'shoot');
      if (shotOpt) choice = shotOpt;
    }
    const willShoot = choice.kind === 'shoot' && (choice.quality > 0.14 || desperate || putBack);

    if (mayAct && !p.actionLock && settled) {
      if (willShoot) {
        // Pump fake first when the keeper has been biting.
        if (choice.quality > 0.28 && this.rng.next() < 0.16 * this.diff.recognition && p.pumpFakes < 2 && clock > 4) {
          sim.tryPumpFake(p);
        } else {
          const type = desperate && choice.quality < 0.3
            ? SHOT_TYPES.DESPERATION
            : contextualShotType(p, distToGoal, pressure, p.pumpFakes > 0, p.justCaught, gk && Math.abs(gk.pos.z - goalZ) > 1.1);
          sim.tryShot(p, choice.aim, type, clamp01(0.55 + this.plan.riskTolerance * 0.4 + this.rng.gauss(0, this.diff.error)));
          this.memory.noteShot(p, p.pos, p.pumpFakes > 0);
        }
      } else if (choice.kind === 'pass' && choice.lane > 0.58) {
        sim.tryPass(p, choice.target, choice.type, clamp01(0.5 + dist2(p.pos, choice.target.pos) / 22));
        if (choice.type === PASS_TYPES.ENTRY) this.memory.noteCentreEntry(p.pos.x);
      }
    }

    // If the carrier wanted to shoot but the shot was not on, treat the movement
    // as a drive so it works to a better position instead of loitering.
    if (choice.kind === 'shoot' && !willShoot && choice.quality < 0.14) choice.kind = 'drive';

    // --- Movement ----------------------------------------------------------
    if (choice.kind === 'drive') {
      // Drive to the edge of the restricted area, not to the goal line. Driving
      // at the line itself meant carriers swam the ball into the goal mouth and
      // scored from a median of 0.7m - which is both against the two metre rule
      // and unsaveable, so every shot went in from point blank.
      const hold = profile.field.restrictedLine + 0.8;
      const stopZ = goalZ - p.attackDir * hold;
      const to = new Vec2(p.pos.x * -0.25, stopZ - p.pos.z);
      cmd.arriveDist = Math.abs(stopZ - p.pos.z);
      cmd.dir = to.length() > 0.2 ? to.normalize() : null;
      cmd.effort = 1;
    } else if (choice.kind === 'shoot') {
      cmd.rise = 0.95;
      cmd.face = Math.atan2(choice.aimPt.x - p.pos.x, choice.aimPt.z - p.pos.z);
      cmd.effort = 0.15;
    } else {
      // Circulate, but always work toward the attacking set rather than drifting
      // in place. If the carrier is deeper than the front court, the drift point
      // is pulled up toward six metres so the ball keeps advancing.
      const near = opp.filter((d) => !d.isGoalkeeper).sort((a, b) => dist2(a.pos, p.pos) - dist2(b.pos, p.pos))[0];
      const away = near ? new Vec2(p.pos.x - near.pos.x, p.pos.z - near.pos.z).normalize() : new Vec2(0, 0);
      const slot = p.roleSlot ? slotToWorld(p.roleSlot, p.attackDir, profile) : { x: p.pos.x, z: p.pos.z };
      const attackZ = p.attackDir * (profile.field.length / 2 - 6.5);
      // Advance in z toward the front court, but keep the carrier's own lateral
      // lane so the perimeter stays spread rather than collapsing to the middle.
      const driftZ = needToAdvance > 0.15 ? attackZ : slot.z;
      const tx = slot.x + away.x * 1.4;
      const tz = driftZ + away.z * 0.8;
      // Separate from nearby teammates as well.
      let sepX = 0, sepZ = 0;
      for (const t of mine) {
        if (t === p || t.isGoalkeeper) continue;
        const d = dist2(t.pos, p.pos);
        if (d < 2.2 && d > 1e-3) { sepX += (p.pos.x - t.pos.x) / d * (2.2 - d) * 0.35; sepZ += (p.pos.z - t.pos.z) / d * (2.2 - d) * 0.35; }
      }
      const to = new Vec2(tx - p.pos.x + sepX, tz - p.pos.z + sepZ);
      cmd.arriveDist = to.length();
      cmd.dir = to.length() > 0.3 ? to.normalize() : null;
      cmd.effort = Math.max(clamp01(to.length() / 3) * 0.75, needToAdvance * 0.65);
      cmd.rise = 0.3;
      cmd.brace = pressure > 0.5;
    }
    return cmd;
  }

  /** At most two athletes break on a counter; everyone else builds the set. */
  _isCounterRunner(p, mine, sim) {
    const goalZ = p.attackDir * (sim.profile.field.length / 2);
    const ranked = mine.filter((a) => a.inPool && !a.isGoalkeeper)
      .sort((a, b) => Math.abs(goalZ - a.pos.z) - Math.abs(goalZ - b.pos.z));
    return ranked.indexOf(p) < 2;
  }

  _counterValue(p, sim, opp) {
    if (p.isGoalkeeper) return 0;
    const goalZ = p.attackDir * (sim.profile.field.length / 2);
    const ahead = opp.filter((d) => !d.isGoalkeeper &&
      Math.sign(goalZ - d.pos.z) === Math.sign(goalZ - p.pos.z) &&
      Math.abs(goalZ - d.pos.z) < Math.abs(goalZ - p.pos.z)).length;
    const lane = clamp01(1 - ahead / 3);
    return lane * clamp01(p.freshness * 1.2) * this.tactics.counterCommitment * 2;
  }

  // -------------------------------------------------------------------------
  // Defense
  // -------------------------------------------------------------------------
  _defense(p, dt, ctx, mayAct, opp, mine) {
    const { sim } = ctx;
    const profile = sim.profile;
    const scheme = DEFENSIVE_SYSTEMS[this.tactics.defense];
    const cmd = { dir: null, effort: 0, rise: 0, face: null, brace: false };
    const ball = sim.ball;
    const carrier = ball.holder;
    const defendDir = -p.attackDir;

    // Loose ball: only the single nearest defender goes for it; the rest keep
    // their defensive shape rather than collapsing onto the ball.
    if (ball.isLoose && ball.timeSinceLoose > 0.1 && !(ball.kind === 'pass' && ball.timeSinceLoose < 1.4 && ball.intendedReceiver && ball.intendedReceiver.side !== p.side)) {
      const mineNear = mine.filter((q) => !q.isGoalkeeper && q.inPool)
        .sort((a, b) => ball.distanceTo(a.pos.x, 0.2, a.pos.z) - ball.distanceTo(b.pos.x, 0.2, b.pos.z))[0];
      const myD = ball.distanceTo(p.pos.x, 0.2, p.pos.z);
      if (p === mineNear || myD < 1.2) {
        cmd.dir = new Vec2(ball.pos.x - p.pos.x, ball.pos.z - p.pos.z).normalize();
        cmd.effort = 1;
        this._note(p, 'chase loose ball', 1);
        return cmd;
      }
    }

    // Zone (man-down) or man marking.
    let target;
    const zoneSlot = p.roleSlot?.zone ? p.roleSlot : null;
    if (zoneSlot) {
      const w = slotToWorld(zoneSlot, defendDir, profile);
      // Collapse the zone toward the ball (dynamic lane collapse).
      const bx = carrier ? carrier.pos.x : ball.pos.x;
      target = { x: w.x + clamp(bx * 0.35, -1.6, 1.6), z: w.z };
      cmd.rise = 0.55;
      this._note(p, 'man-down zone', 1);
    } else {
      const markId = this.markAssign.get(p.id);
      let mark = opp.find((o) => o.id === markId) ?? p.markTarget;

      // Somebody must always be on the ball. If the carrier is unmarked - which
      // happens constantly as attackers rotate out of their assigned slots - the
      // nearest defender picks them up. Without this the shape looks correct but
      // nobody actually contests the shot, and every attack ends in a goal.
      if (carrier && carrier.side !== p.side && mark !== carrier) {
        const marked = mine.some((q) => q !== p && !q.isGoalkeeper && q.inPool &&
          (opp.find((o) => o.id === this.markAssign.get(q.id)) ?? q.markTarget) === carrier);
        if (!marked) {
          const nearest = mine.filter((q) => !q.isGoalkeeper && q.inPool)
            .sort((a, b) => dist2(a.pos, carrier.pos) - dist2(b.pos, carrier.pos))[0];
          if (nearest === p) mark = carrier;
        }
      }

      if (!mark) {
        const own = defendDir * (profile.field.length / 2 - 4);
        target = { x: p.pos.x * 0.6, z: own };
      } else {
        const isCentre = mark.roleSlot?.role === 'CF' || mark.roleSlot?.role === 'post';
        target = markingSpot(mark, defendDir, profile, { ...scheme, pressure: this.plan.pressLevel }, isCentre);
        cmd.face = Math.atan2(mark.pos.x - p.pos.x, mark.pos.z - p.pos.z);

        const gap = dist2(p.pos, mark.pos);
        if (isCentre) {
          cmd.brace = true;
          cmd.rise = 0.45;
          this._note(p, scheme.frontCentre > 0.5 ? 'front the centre' : 'play behind the centre', 1);
        }

        // Raise an arm when the marked player can shoot.
        const markGoalDist = Math.hypot(mark.pos.x, defendDir * profile.field.length / 2 - mark.pos.z);
        if (mark === carrier && gap < 2.2 && markGoalDist < 9) {
          cmd.rise = Math.max(cmd.rise, 0.85);
          if (mayAct) sim.tryBlock(p);
          this._note(p, 'raise arm / block', 1);
        }

        // Steal attempt: high value, high risk. Weighted by timing attribute and
        // by how much personal-foul room this athlete has left.
        if (mark === carrier && gap < 1.25 && mayAct && p.stealCooldown <= 0) {
          const foulRoom = 1 - p.personalFouls / profile.discipline.personalFoulLimit;
          const chance = a01(p.player.attr.stealTiming) * this.diff.recognition * foulRoom *
            lerp(0.4, 1.2, this.plan.riskTolerance) * 0.5;
          if (this.rng.next() < chance * dt * 8) {
            sim.trySteal(p);
            this._note(p, 'steal attempt', chance);
          }
        }

        // Tactical foul: stop a counter or a centre entry at the cost of a free throw.
        // This branch only ever set a brace flag and wrote a debug note - it
        // never actually fouled anybody, so the AI's "tactical foul" did not
        // exist. It now commits the real thing, through the same call the human
        // makes with SPACE, so the position decides the punishment: in front of
        // the carrier it costs a free throw, from behind it costs an exclusion.
        // That is where man-up situations come from now that defenders mark
        // goalside and so almost never foul from behind by accident.
        if (mark === carrier && gap < 2.2 && sim.transitionTimer > 0 &&
            p.personalFouls < profile.discipline.personalFoulLimit - 1 &&
            this.rng.next() < scheme.foulRisk * this.diff.risk * dt * 3) {
          cmd.brace = true;
          if (mayAct) sim.tryDeliberateFoul(p);
          this._note(p, 'tactical foul', scheme.foulRisk);
        }
      }
    }

    const to = new Vec2(target.x - p.pos.x, target.z - p.pos.z);
    const d = to.length();
    cmd.dir = d > 0.2 ? to.normalize() : null;
    cmd.arriveDist = d;
    cmd.effort = clamp01(d / 2.6) * lerp(0.5, 1.0, this.plan.pressLevel);
    // A defender who has arrived at their marking spot would otherwise sit at
    // zero effort and let the carrier swim away from them. Marking the ball is
    // active work: stay with them.
    // How hard the defence chases the carrier is a DIFFICULTY setting. A fixed
    // radius and effort meant an amateur side hounded you exactly as hard as a
    // legendary one, and the carrier never had room to work.
    const press = this.diff.press ?? 0.64;
    if (carrier && carrier.side !== p.side &&
        dist2(p.pos, carrier.pos) < lerp(2.8, 5.0, press)) {
      cmd.effort = Math.max(cmd.effort, lerp(0.45, 0.95, press));
    }
    if (d < 0.5) cmd.rise = Math.max(cmd.rise, 0.4);
    return cmd;
  }

  _note(athlete, action, score, rejected = []) {
    this.lastDecision.set(athlete.id, { action, score, rejected: rejected.map((r) => `${r.kind} ${r.score.toFixed(2)}`) });
  }
}

/**
 * Ease an athlete's held station toward a freshly computed target.
 *
 * Steering wants a destination that is stable for long enough to swim to. A
 * target that is re-derived every frame is noise, not intent. The station snaps
 * instead of easing when the new target is a long way off, so genuine events -
 * a turnover, a change of end - are picked up immediately rather than smeared.
 */
function smoothTarget(p, target, dt) {
  const held = p.aiStation;
  if (!held) { p.aiStation = { x: target.x, z: target.z }; return target; }
  if (Math.hypot(target.x - held.x, target.z - held.z) > 6) {
    p.aiStation = { x: target.x, z: target.z };
    return target;
  }
  const k = 1 - Math.exp(-dt / 0.3);
  held.x += (target.x - held.x) * k;
  held.z += (target.z - held.z) * k;
  return { x: held.x, z: held.z };
}

const clampToZero = (v) => (v > 0 ? v : 0);
