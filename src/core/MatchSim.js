/**
 * MatchSim - the authoritative water polo match simulation.
 *
 * Owns the match state machine (section 7.3), the clocks, possession, exclusions,
 * substitutions, statistics (section 29), the deterministic event record
 * (section 41) and the public action API that both the human input layer and the
 * AI call into. It knows nothing about rendering.
 *
 * Fixed timestep. Every stochastic draw comes from a seeded RNG, and every state
 * transition is emitted on the event bus and appended to the match record, so a
 * match can be replayed exactly.
 */

import { EventBus } from './EventBus.js';
import { Vec2, Rng, clamp, clamp01, lerp, dist2, angleDelta } from './Math2.js';
import { Athlete, LOCOMOTION, freshStats } from '../gameplay/Athlete.js';
import { Ball, BALL_STATE } from '../gameplay/Ball.js';
import { ContactSystem, FOUL } from '../gameplay/Contact.js';
import { GoalkeeperBrain, attemptSave, GK_PROFILE } from '../gameplay/Goalkeeper.js';
import {
  resolvePass, resolveCatch, resolveShot, goalAimPoint, pressureOn, lobFlight,
  contextualShotType, SHOT_TYPES, PASS_TYPES, shotQuality, laneOpenness,
} from '../gameplay/Actions.js';
import {
  MATCH_STATE, POSSESSION_EVENT, shotClockAfter, freeThrowSpot, endLineRestart,
  exclusionTick, personalFoulResult, timeoutEligible, periodTransition,
  shootoutState, substitutionLegal, explainFoul,
} from '../rules/RulesEngine.js';
import { TeamAI, DIFFICULTY } from '../ai/TeamAI.js';
import { makeTeamTactics, OFFENSIVE_SYSTEMS, DEFENSIVE_SYSTEMS } from '../ai/Tactics.js';
import { defaultLineup } from '../data/Teams.js';

/**
 * Defensive auto-switch damping. Control should feel like it belongs to you:
 * it only moves when another defender is clearly better placed, and never more
 * than once in this many seconds.
 */
const AUTO_SWITCH_MARGIN = 2.2;   // metres closer to the ball before it moves
const AUTO_SWITCH_HOLD = 1.4;     // seconds you keep control after a switch

export const ASSIST_PROFILE = {
  BEGINNER: 'beginner',
  STANDARD: 'standard',
  COMPETITIVE: 'competitive',
  FULL_SIM: 'fullSim',
};

const ASSIST_VALUES = {
  beginner:    { pass: 0.95, shot: 0.55, catchWindow: 1.5, switchAuto: true, indicators: 'full', gk: GK_PROFILE.ASSISTED },
  standard:    { pass: 0.7, shot: 0.3, catchWindow: 1.2, switchAuto: true, indicators: 'standard', gk: GK_PROFILE.ASSISTED },
  competitive: { pass: 0.35, shot: 0.12, catchWindow: 1.0, switchAuto: false, indicators: 'minimal', gk: GK_PROFILE.HYBRID },
  fullSim:     { pass: 0.0, shot: 0.0, catchWindow: 0.85, switchAuto: false, indicators: 'minimal', gk: GK_PROFILE.MANUAL },
};

/**
 * The result of one shootout kick, from where the ball goes (zone: -1, 0, +1
 * across the goal) and where the keeper went (dive: -1, 0, +1). Pure, so the
 * rule can be tested on its own:
 *
 *   keeper right way   -> a real chance of a save (a keeper who STAYS in the
 *                         middle saves almost every shot down the middle)
 *   keeper wrong way   -> goal, unless the shooter misses the target
 *   aiming for a corner carries a small risk of missing it entirely
 */
export function shootoutOutcome({ zone, dive, placement, gkSkill, rng }) {
  const missChance = zone === 0 ? 0.02 : lerp(0.12, 0.03, placement);
  if (rng.chance(missChance)) return 'miss';
  let saveChance;
  if (dive === zone) saveChance = zone === 0 ? lerp(0.86, 0.95, gkSkill) : lerp(0.42, 0.62, gkSkill) * lerp(1.15, 0.8, placement);
  else if (dive === 0) saveChance = lerp(0.06, 0.16, gkSkill) * lerp(1.1, 0.8, placement);   // stayed, stretched for it
  else saveChance = 0.02;                                                                      // went the wrong way
  return rng.chance(saveChance) ? 'save' : 'goal';
}

export class MatchSim {
  /**
   * @param {object} cfg
   *   cfg.profile      rules profile
   *   cfg.league       { teams, rosters }
   *   cfg.homeId/awayId team ids
   *   cfg.seed         deterministic seed
   *   cfg.difficulty   key into DIFFICULTY
   *   cfg.assist       key into ASSIST_VALUES
   *   cfg.userSide     'home' | 'away' | null (null = AI vs AI showcase)
   *   cfg.refereeProfile 'strict' | 'standard' | 'human'
   */
  constructor(cfg) {
    this.profile = cfg.profile;
    this.league = cfg.league;
    this.seed = cfg.seed ?? 1;
    this.rng = new Rng(this.seed);
    this.bus = new EventBus();
    this.record = [];             // deterministic match record (section 41)
    this.cfgLineups = cfg.lineups ?? null;   // { home?: ids[7], away?: ids[7] }
    this.difficultyKey = cfg.difficulty ?? 'national';
    // Difficulty makes the OPPONENT better - their outfield AI and their keeper.
    // It used to be applied to both teams, so at Legendary your own team-mates
    // and your own keeper became legendary too and the setting cancelled itself
    // out: measured over 120 matches, a player won as often on Amateur as on
    // Legendary. Your side now plays at a fixed, competent level.
    this.teammateDifficultyKey = 'national';
    this.difficultyFor = (side) =>
      (cfg.userSide && side === cfg.userSide) ? this.teammateDifficultyKey : this.difficultyKey;
    this.assistKey = cfg.assist ?? ASSIST_PROFILE.STANDARD;
    this.assist = ASSIST_VALUES[this.assistKey];
    this.refereeProfile = cfg.refereeProfile ?? 'standard';
    // null when nobody is controlling (AI-vs-AI spectate): the AI then drives
    // every athlete and auto-switch stays inert.
    this.userControlsSide = cfg.userSide ?? null;
    this.secondUserSide = cfg.secondUserSide ?? null;   // local one-versus-one

    this.homeTeam = this.league.teams.find((t) => t.id === cfg.homeId);
    this.awayTeam = this.league.teams.find((t) => t.id === cfg.awayId);

    // Home attacks toward +z in the first period; ends swap at halftime.
    this.attackDir = { home: 1, away: -1 };

    this.ball = new Ball();
    this.contact = new ContactSystem(this.rng.fork(0x51ed));

    this.squads = { home: [], away: [] };
    this.active = { home: [], away: [] };
    this.bench = { home: [], away: [] };
    this.gkBrain = { home: null, away: null };

    this._buildSquads();

    this.tactics = {
      home: makeTeamTactics(this.homeTeam.style),
      away: makeTeamTactics(this.awayTeam.style),
    };
    this.ai = {
      home: new TeamAI('home', this.tactics.home, this.difficultyFor('home'), this.rng.fork(0xA1)),
      away: new TeamAI('away', this.tactics.away, this.difficultyFor('away'), this.rng.fork(0xA2)),
    };

    // --- Match state -------------------------------------------------------
    this.state = MATCH_STATE.PRE_MATCH;
    this.stateTimer = 0;
    this.period = 1;
    this.gameClock = this.profile.timing.periodSeconds;
    this.clockRunning = false;
    this.clockNow = 0;             // monotonic simulation time
    this.shotClock = this.profile.timing.normalPossession;
    this.shotClockArmed = false;
    this.shotClockSecondary = false;
    this.possession = null;
    this.score = { home: 0, away: 0 };
    this.timeoutsUsed = { home: 0, away: 0 };
    this.challengesUsed = { home: 0, away: 0 };
    this.exclusions = [];
    this.pendingRestart = null;
    this.transitionTimer = 0;      // >0 while a counterattack window is open
    this.lastGoal = null;
    this.roleDirty = true;
    this.shootout = null;
    this.abandoned = false;

    this.stats = {
      home: freshTeamStats(),
      away: freshTeamStats(),
    };
    this.timeline = [];            // human-readable match events for the UI

    // --- User control ------------------------------------------------------
    this.userAthlete = null;
    this.secondUserAthlete = null;
    this.userCommand = emptyCommand();
    this.secondUserCommand = emptyCommand();
    this.userGkControl = false;
    this.autoSwitch = true;          // EAFC-style automatic player switching
    this.lockUserAthlete = false;    // Player Career: you control ONE athlete only
    this.manualSwitchCooldown = 0;   // brief window where a manual pick is respected

    this.pendingFouls = [];
    this.explain = null;           // last call explanation for the HUD
    this.reviewRequest = null;
    this.paused = false;
    this.presentation = {          // one-frame flags consumed by the renderer
      whistle: 0, goalFlash: 0, saveFlash: 0, bigSplash: null, shake: 0,
    };

    this._log('matchCreated', {
      profile: this.profile.id, home: this.homeTeam.id, away: this.awayTeam.id, seed: this.seed,
    });
  }

  // =========================================================================
  // Setup
  // =========================================================================

  _buildSquads() {
    for (const side of ['home', 'away']) {
      const team = side === 'home' ? this.homeTeam : this.awayTeam;
      const roster = this.league.rosters[team.id];
      const dir = this.attackDir[side];
      // The opponent plays to the chosen difficulty. The AI knobs alone (reaction,
      // recognition, pressing) steer decisions but barely move results - AI v AI,
      // Amateur and Legendary won 8 and 10 of 16 against National, with shots,
      // passing, turnovers and steals flat - because outcomes are decided by the
      // athletes' attributes. So difficulty also lifts or lowers every attribute
      // of the side you face, for this match only, on a copy: the league's real
      // players are never touched. Your own side is always at its real level.
      const edge = (DIFFICULTY[this.difficultyFor(side)]?.edge) ?? 0;
      // Discipline is left alone: lowering it made weak sides foul constantly,
      // doubling the whistles on Amateur - choppiest exactly where the game
      // should flow most easily.
      const KEEP = new Set(['foulDiscipline', 'contactDiscipline', 'legalLeverage']);
      const playAs = (p) => edge === 0 ? p : {
        ...p,
        attr: Object.fromEntries(Object.entries(p.attr).map(([k, v]) => [k, KEEP.has(k) ? v : clamp(v + edge, 1, 99)])),
      };
      const squad = roster.map((p) => new Athlete(playAs(p), side, dir));
      this.squads[side] = squad;

      // A career passes the seven the manager picked. It is used only if it is
      // a real seven - seven athletes from this roster, exactly one goalkeeper -
      // otherwise the automatic pick stands, so a stale save can never field
      // six players or two keepers.
      const chosen = this.cfgLineups?.[side];
      const valid = Array.isArray(chosen) && chosen.length === 7 &&
        new Set(chosen).size === 7 &&
        chosen.every((id) => roster.some((p) => p.id === id)) &&
        roster.filter((p) => chosen.includes(p.id) && p.position === 'GK').length === 1;
      const lineup = valid ? roster.filter((p) => chosen.includes(p.id)) : defaultLineup(roster);
      const lineupIds = new Set(lineup.map((p) => p.id));
      this.active[side] = squad.filter((a) => lineupIds.has(a.player.id));
      this.bench[side] = squad.filter((a) => !lineupIds.has(a.player.id));
      for (const a of this.bench[side]) a.inPool = false;

      const gk = this.active[side].find((a) => a.isGoalkeeper);
      if (gk) this.gkBrain[side] = new GoalkeeperBrain(gk, side, this.rng.fork(side === 'home' ? 7 : 11));
    }
  }

  /** Place everyone for a period start / swim-off. */
  setupPeriod() {
    const f = this.profile.field;
    for (const side of ['home', 'away']) {
      const dir = this.attackDir[side];
      const list = this.active[side];
      list.forEach((a, i) => {
        a.attackDir = dir;
        a.resetForRestart();
        a.inPool = true;
        if (a.isGoalkeeper) {
          a.pos.set(0, -dir * (f.length / 2 - 0.5));
        } else {
          // Line up on their own goal line for the swim-off, in lanes.
          const spread = ((i - 3) / 3) * (f.width / 2 - 2.2);
          a.pos.set(spread, -dir * (f.length / 2 - 0.4));
          a.vel.set(0, 0);
        }
        a.heading = dir > 0 ? 0 : Math.PI;
        a.shoulder = a.heading;
        a.elevation = 0;
        a.hasBall = false;
      });
      for (const a of this.bench[side]) a.inPool = false;
    }
    this.ball.reset(0, 0.08, 0);
    this.ball.state = BALL_STATE.DEAD;
    this.possession = null;
    this.roleDirty = true;
  }

  start() {
    this.setupPeriod();
    this._setState(MATCH_STATE.PERIOD_SETUP, 1.1);
    this._timeline(`Period ${this.period} - teams set.`);
  }

  // =========================================================================
  // Accessors
  // =========================================================================

  activeAthletes(side) { return this.active[side].filter((a) => a.inPool); }
  benchAthletes(side) { return this.bench[side]; }
  allActive() { return [...this.activeAthletes('home'), ...this.activeAthletes('away')]; }
  goalkeeperFor(side) { return this.active[side].find((a) => a.isGoalkeeper && a.inPool) ?? null; }
  opponentSide(side) { return side === 'home' ? 'away' : 'home'; }
  teamOf(side) { return side === 'home' ? this.homeTeam : this.awayTeam; }
  timeRemainingInMatch() {
    return this.gameClock + (this.profile.timing.periods - this.period) * this.profile.timing.periodSeconds;
  }
  isLive() { return this.state === MATCH_STATE.LIVE || this.state === MATCH_STATE.LOOSE_BALL; }
  activeCount(side) { return this.activeAthletes(side).length; }
  /** Extra-player / man-down status for the HUD and the AI. */
  playerAdvantage(side) { return this.activeCount(side) - this.activeCount(this.opponentSide(side)); }

  // =========================================================================
  // Main update
  // =========================================================================

  update(dt) {
    if (this.paused) return;
    this.clockNow += dt;
    for (const k in this.presentation) {
      if (typeof this.presentation[k] === 'number') this.presentation[k] = Math.max(0, this.presentation[k] - dt * 3);
    }
    this.transitionTimer = Math.max(0, this.transitionTimer - dt);
    this.stateTimer -= dt;
    if (this.pendingSubs?.length && !this.isLive() && this.state !== MATCH_STATE.SHOOTOUT) this._flushPendingSubs();

    switch (this.state) {
      case MATCH_STATE.PRE_MATCH: break;
      case MATCH_STATE.PERIOD_SETUP: this._updatePeriodSetup(dt); break;
      case MATCH_STATE.SWIM_OFF: this._updateLive(dt, true); break;
      case MATCH_STATE.LIVE:
      case MATCH_STATE.LOOSE_BALL: this._updateLive(dt, false); break;
      case MATCH_STATE.ORDINARY_FOUL:
      case MATCH_STATE.EXCLUSION_FOUL:
      case MATCH_STATE.NEUTRAL_THROW: this._updateRestart(dt); break;
      case MATCH_STATE.PENALTY_FOUL: this._updatePenalty(dt); break;
      case MATCH_STATE.GOAL: this._updateGoal(dt); break;
      case MATCH_STATE.TIMEOUT: this._updateTimeout(dt); break;
      case MATCH_STATE.INTERVAL: this._updateInterval(dt); break;
      case MATCH_STATE.PERIOD_END: this._updatePeriodEnd(dt); break;
      case MATCH_STATE.SHOOTOUT: this._updateShootout(dt); break;
      case MATCH_STATE.MATCH_END: break;
      default: break;
    }

    // Bench recovery runs in every state.
    for (const side of ['home', 'away']) {
      for (const a of this.bench[side]) a.recoverOnBench(dt);
    }
  }

  _updatePeriodSetup(dt) {
    this._driveAthletes(dt, true);
    if (this.stateTimer <= 0) {
      if (this.profile.restarts.swimOffAtPeriodStart) {
        // Long enough for the race to be decided in the water. The sprint is
        // the length of a half - twelve and a half metres - which takes over
        // four seconds, so a 4s window handed the ball out just BEFORE anybody
        // could reach it. It still ends the instant someone touches the ball.
        this._setState(MATCH_STATE.SWIM_OFF, 9);
        this.clockRunning = true;
        this.presentation.whistle = 1;
        // Release the ball on the half-distance line. It is genuinely loose:
        // whoever reaches it first wins the sprint and the first possession.
        this.ball.reset(0, this.ball.radius * 0.6, 0);
        this.ball.state = BALL_STATE.FLIGHT;
        this.ball.timeSinceLoose = 0;
        this.ball.lastTouchSide = null;
        // You are the one racing for it. The sprinter is the athlete in the
        // middle, nearest the ball - in real water polo that is who goes - and
        // watching an AI team-mate do it while you steer somebody else is not a
        // swim-off. Player Career is the exception: there you are your athlete.
        if (this.userControlsSide && !this.lockUserAthlete) {
          const mine = this.activeAthletes(this.userControlsSide).filter((a) => !a.isGoalkeeper);
          const sprinter = mine.sort((a, b) => Math.hypot(a.pos.x, a.pos.z) - Math.hypot(b.pos.x, b.pos.z))[0];
          if (sprinter) {
            this.setUserAthlete(sprinter);
            this.manualSwitchCooldown = 5;   // control stays on him for the race
          }
        }
        this._timeline('Swim-off!');
        this._log('swimOff', { period: this.period });
      } else {
        this._releaseBallToNearest();
        this._beginLive();
      }
    }
  }

  /** Fallback used by profiles without a swim-off: nearest athlete starts. */
  _releaseBallToNearest() {
    const all = this.allActive().filter((a) => !a.isGoalkeeper);
    if (!all.length) return;
    // Nearest THE BALL, not nearest the centre of the pool. Sorting by distance
    // from the origin handed the ball to whoever happened to line up closest to
    // the middle - a player metres away from it - which is the ball flying to
    // someone else while you were still swimming for it.
    const b = this.ball.pos;
    const nearest = all.sort((p, q) =>
      Math.hypot(p.pos.x - b.x, p.pos.z - b.z) - Math.hypot(q.pos.x - b.x, q.pos.z - b.z))[0];
    this._giveBall(nearest);
    this._applyShotClock(shotClockAfter(this.profile, POSSESSION_EVENT.GAIN));
  }

  _beginLive() {
    this._setState(MATCH_STATE.LIVE, 0);
    this.clockRunning = true;
  }

  _updateLive(dt, swimOff) {
    // ---- Clocks -----------------------------------------------------------
    if (this.clockRunning) {
      this.gameClock = Math.max(0, this.gameClock - dt);
      // The shot clock only runs once the team in possession has actually
      // touched the ball. It used to start the instant possession changed, so a
      // team was already losing time while the ball was still travelling to them.
      if (!swimOff && this.possession && this.shotClockArmed) {
        this.shotClock = Math.max(0, this.shotClock - dt);
        if (this.shotClock <= 0) {
          this._turnover(this.opponentSide(this.possession), 'shotClockExpired');
          return;
        }
      }
    }

    // ---- Exclusions -------------------------------------------------------
    this._tickExclusions(dt, {});

    // ---- Automatic control switching (before applying the user command) ---
    this._autoSwitchControl(dt);

    // ---- AI, input, locomotion -------------------------------------------
    this.ai.home.update(dt, { sim: this });
    this.ai.away.update(dt, { sim: this });
    this.roleDirty = false;
    this._driveGoalkeepers(dt);
    this._applyUserCommand();
    this._driveAthletes(dt, false);

    // ---- Ball -------------------------------------------------------------
    this.ball.update(dt, {
      profile: this.profile,
      onGoal: (ball, sign) => this._onGoalLineCrossed(ball, sign),
      onEndLine: (ball, sign) => this._onEndLine(ball, sign),
      onPost: () => { this.presentation.shake = 0.7; this.presentation.whistle = 0; },
    });

    // ---- Blocks and goalkeeper saves --------------------------------------
    this._resolveBlocks(dt);
    this._resolveSaves(dt);

    // ---- Loose ball pickup / interception --------------------------------
    if (this.ball.isLoose) this._resolveLooseBall(dt);

    // ---- Contact and fouls ------------------------------------------------
    const fouls = this.contact.update(dt, this.allActive(), this.ball, {
      profile: this.profile,
      refereeProfile: this.refereeProfile,
      matchTime: this.clockNow,
      allAthletes: this.allActive(),
      goalkeeperFor: (s) => this.goalkeeperFor(s),
    });
    for (const foul of fouls) this._awardFoul(foul);

    // ---- Statistics -------------------------------------------------------
    for (const a of this.allActive()) a.stats.timeInPool += dt;
    const posStats = this.possession ? this.stats[this.possession] : null;
    if (posStats) posStats.possessionTime += dt;

    // ---- Period end -------------------------------------------------------
    if (this.gameClock <= 0 && this.state !== MATCH_STATE.PERIOD_END) {
      this._setState(MATCH_STATE.PERIOD_END, 1.2);
      this.clockRunning = false;
      this.presentation.whistle = 1;
      this._timeline(`End of period ${this.period}.`);
      this._log('periodEnd', { period: this.period, score: { ...this.score } });
    }

    if (swimOff && (this.ball.holder || this.stateTimer <= 0)) {
      if (this.ball.holder) {
        this._setPossession(this.ball.holder.side, POSSESSION_EVENT.GAIN);
      } else {
        // Nobody won the sprint cleanly: award it to whoever is closest so the
        // match never stalls on a dead ball.
        this._releaseBallToNearest();
      }
      this._applyShotClock(shotClockAfter(this.profile, POSSESSION_EVENT.GAIN));
      this._beginLive();
    }
  }

  _updateRestart(dt) {
    this._driveAthletes(dt, true);
    this.ball.update(dt, { profile: this.profile });
    this._tickExclusions(dt, {});
    if (this.stateTimer <= 0 && this.pendingRestart) {
      const r = this.pendingRestart;
      const taker = r.taker;
      if (taker && taker.inPool) {
        taker.pos.set(r.spot.x, r.spot.z);
        taker.vel.set(0, 0);
        this._giveBall(taker);
        // You were fouled, so you take the restart. Without this the ball was
        // handed to the victim while the camera and the controls stayed on
        // whoever you happened to be steering, so from the player's seat the
        // ball had simply gone to another player.
        if (this.userControlsSide === taker.side && !this.lockUserAthlete && !taker.isGoalkeeper) {
          this.userAthlete = taker;
        }
      }
      this.pendingRestart = null;
      this._beginLive();
      this.clockRunning = true;
    }
  }

  _updateGoal(dt) {
    this._driveAthletes(dt, true);
    this.ball.update(dt, { profile: this.profile });
    if (this.stateTimer <= 0) {
      // Restart from the centre by the team that conceded.
      const restartSide = this.lastGoal ? this.opponentSide(this.lastGoal.side) : 'home';
      this._positionForCentreRestart(restartSide);
      const taker = this.activeAthletes(restartSide)
        .filter((a) => !a.isGoalkeeper)
        .sort((a, b) => Math.abs(a.pos.z) - Math.abs(b.pos.z))[0];
      if (taker) this._giveBall(taker);
      this._setPossession(restartSide, POSSESSION_EVENT.GOAL);
      this._beginLive();
      this.clockRunning = true;
    }
  }

  _updatePenalty(dt) {
    this._driveAthletes(dt, true);
    this.ball.update(dt, {
      profile: this.profile,
      onGoal: (ball, sign) => this._onGoalLineCrossed(ball, sign),
      onEndLine: (ball, sign) => this._onEndLine(ball, sign),
    });
    this._resolveSaves(dt);

    const p = this.pendingRestart;
    if (!p) { this._beginLive(); return; }

    if (!p.taken && this.stateTimer <= 0) {
      p.taken = true;
      this.presentation.whistle = 1;
      const shooter = p.taker;
      if (shooter === this.userAthlete && this.userControlsSide) {
        // The human takes it manually: hand them the ball and let them shoot.
        shooter.pendingPenalty = true;
        this._giveBall(shooter);
        this.stateTimer = 6;
      } else {
        shooter.pendingPenalty = true;
        this._giveBall(shooter);
        const aim = { x: this.rng.range(-0.85, 0.85), y: this.rng.range(0.1, 0.8) };
        this.tryShot(shooter, aim, SHOT_TYPES.PENALTY, 0.95);
        shooter.pendingPenalty = false;
        this.stateTimer = 4;
      }
    } else if (p.taken && (this.ball.isLoose || this.stateTimer <= 0)) {
      if (this.stateTimer <= 0) {
        p.taker.pendingPenalty = false;
        this._beginLive();
        this.clockRunning = true;
      }
    }
  }

  /**
   * Penalty shootout (section 7.2 and 7.4). Five nominated shooters per team,
   * alternating, then sudden death in pairs. Every attempt is a real penalty
   * throw resolved by the normal shooting and goalkeeping systems.
   */
  _prepareShootout() {
    const pick = (side) => this.activeAthletes(side)
      .filter((a) => !a.isGoalkeeper)
      .sort((a, b) =>
        (b.player.attr.penaltyComposure + b.player.attr.shotPlacement + (b.has('penaltySpecialist') ? 40 : 0)) -
        (a.player.attr.penaltyComposure + a.player.attr.shotPlacement + (a.has('penaltySpecialist') ? 40 : 0)))
      .slice(0, Math.max(this.profile.shootout.shootersPerTeam, 5));

    const order = { home: pick('home'), away: pick('away') };
    // Player Career: your own player always takes one of the kicks.
    const me = this.lockUserAthlete ? this.userAthlete : null;
    if (me && me.inPool && !me.isGoalkeeper && !order[me.side].includes(me)) {
      order[me.side] = [me, ...order[me.side].slice(0, -1)];
    }
    this.shootout = {
      attempts: [],
      order,
      index: { home: 0, away: 0 },
      phase: 'setup',
      timer: 1.2,
      current: null,
      resolved: false,
    };
    this.clockRunning = false;
    this._timeline('Penalty shootout.');
    this._log('shootoutStart', {});
  }

  /**
   * The human's shootout input for this frame: which side of the goal (-1, 0,
   * +1 in world x) they are holding, and whether they pressed SHOOT. Written by
   * Input2D every frame of a shootout.
   */
  shootoutControl(input) { this._soInput = input; }

  /** Is the human taking this kick, and/or keeping goal against it? */
  _shootoutRoles(side, shooter) {
    const user = this.userControlsSide;
    if (!user) return { humanShoots: false, humanKeeps: false };
    // Player Career: you are one athlete, so you take your OWN kick only and the
    // club's goalkeeper is not yours to steer. Every other mode: you are the
    // team - you take every one of your team's kicks and keep goal against all
    // of theirs.
    if (this.lockUserAthlete) {
      return { humanShoots: side === user && shooter === this.userAthlete, humanKeeps: false };
    }
    return { humanShoots: side === user, humanKeeps: side !== user };
  }

  _updateShootout(dt) {
    const so = this.shootout;
    if (!so) { this._endMatch(); return; }

    this._driveAthletes(dt, true);
    this._driveGoalkeepers(dt);
    this.ball.update(dt, {
      profile: this.profile,
      onGoal: (ball, sign) => this._onShootoutGoal(sign),
      onEndLine: () => { if (so.phase === 'flight') this._resolveShootoutAttempt(false); },
    });
    // No _resolveSaves here. The outcome of a penalty is decided when it is
    // taken, from where the ball is going and where the keeper went; the
    // physics just has to show it. Letting the open-play save model run as well
    // is what produced shots down the middle beating a keeper who had not moved.
    this._shootoutKeeperPose(dt);

    if (so.phase === 'aim') { this._shootoutAim(dt); return; }
    if (so.phase === 'flight') {
      // A predetermined save: the keeper takes it before it reaches the line.
      if (so.outcome === 'save' && !so.resolved && !this.ball.holder) {
        const gk = this.goalkeeperFor(this.opponentSide(so.current.side));
        const gz = this.attackDir[so.current.side] * (this.profile.field.length / 2);
        if (gk && Math.abs(gz - this.ball.pos.z) < 0.9) {
          gk.pos.x = this.ball.pos.x;
          this._giveBall(gk);
          gk.stats.saves++; this.stats[gk.side].saves++;
          this.presentation.saveFlash = 1;
          this.bus.emit('save', { gk, outcome: 'controlled' });
          this._resolveShootoutAttempt(false);
          return;
        }
      }
    }

    so.timer -= dt;
    if (so.timer > 0) return;

    switch (so.phase) {
      case 'setup': {
        const state = shootoutState(this.profile, so.attempts);
        if (state.finished) { this._finishShootout(state); return; }
        // Safety valve: shootouts must terminate. After a long sudden death,
        // the next pair that is not both-score-or-both-miss decides it, and a
        // hard cap prevents any pathological infinite tie.
        if (so.attempts.length >= 40) {
          const decided = state.hScore !== state.aScore
            ? { ...state, finished: true, winner: state.hScore > state.aScore ? 'home' : 'away' }
            : { ...state, finished: true, winner: this.rng.chance(0.5) ? 'home' : 'away' };
          this._finishShootout(decided);
          return;
        }
        const side = state.nextSide;
        const list = so.order[side];
        const shooter = list[so.index[side] % list.length];
        so.index[side]++;
        so.current = { side, shooter };
        so.resolved = false;

        this._positionShootout(side, shooter);
        so.phase = 'ready';
        so.timer = 1.1;
        this._timeline(`${this.teamOf(side).short} · #${shooter.player.capNumber} ${shooter.player.name} steps up.`);
        break;
      }
      case 'ready': {
        const { side, shooter } = so.current;
        shooter.pendingPenalty = true;
        this._giveBall(shooter);
        this.presentation.whistle = 1;
        const roles = this._shootoutRoles(side, shooter);
        so.humanShoots = roles.humanShoots;
        so.humanKeeps = roles.humanKeeps;
        so.aimSide = 0;
        so.dive = null;
        so.diveX = 0;
        this._soInput = null;
        if (so.humanShoots && !this.lockUserAthlete) this.userAthlete = shooter;
        so.phase = 'aim';
        // You get a proper moment to pick your corner; the AI shooter gives a
        // human keeper long enough to read him and choose a side.
        so.timer = so.humanShoots ? 7 : this.rng.range(1.5, 2.3);
        break;
      }
      case 'flight':
        // No goal within the window: the attempt failed.
        this._resolveShootoutAttempt(false);
        break;
      case 'between':
        so.phase = 'setup';
        so.timer = 0.6;
        break;
      default:
        break;
    }
  }

  /** Aim phase: the shooter picks a corner, the keeper picks a dive. */
  _shootoutAim(dt) {
    const so = this.shootout;
    const input = this._soInput ?? { side: 0, shoot: false };
    so.timer -= dt;

    if (so.humanShoots) {
      so.aimSide = input.side;
      this.shootoutPrompt = 'YOUR PENALTY  ·  hold UP or DOWN to pick a corner (neither = middle)  ·  X / SPACE to shoot';
      if (input.shoot || so.timer <= 0) this._takeShootoutKick();
      return;
    }
    if (so.humanKeeps) {
      // Latch the last side you pressed: tap it and let go, it stays chosen.
      if (input.side !== 0) { so.dive = input.side; so.diveScreen = input.screen; }
      this.shootoutPrompt = so.dive == null
        ? 'YOU ARE IN GOAL  ·  press UP or DOWN to dive that way  ·  press nothing to stay in the middle'
        : `YOU ARE IN GOAL  ·  diving ${so.diveScreen < 0 ? 'UP' : 'DOWN'}  ·  (press the other way to change)`;
    } else {
      this.shootoutPrompt = null;
    }
    if (so.timer <= 0) this._takeShootoutKick();
  }

  /**
   * Take the kick. The result is decided here, from geometry and skill, not
   * from a coin flip that ignored where the ball went:
   *
   *   - the keeper goes the right way  -> a real chance of a save
   *   - the keeper goes the wrong way  -> goal (unless the shooter misses)
   *   - down the middle beats a diving keeper but is easy for one who stays
   *   - aiming for the corner carries a small risk of missing the target
   */
  _takeShootoutKick() {
    const so = this.shootout;
    const { side, shooter } = so.current;
    const gk = this.goalkeeperFor(this.opponentSide(side));
    const rng = this.rng;
    const a01 = (v) => clamp01((v - 10) / 85);
    const placement = a01(shooter.player.attr.shotPlacement) * 0.5 + a01(shooter.player.attr.penaltyComposure) * 0.5;
    const gkSkill = gk ? clamp01((gk.player.attr.reactionSpeed + gk.player.attr.setPositioning - 20) / 170) : 0;

    // Where the shot goes (-1 / 0 / +1 across the goal).
    let zone;
    if (so.humanShoots) zone = so.aimSide;
    else { const r = rng.next(); zone = r < 0.42 ? -1 : r < 0.84 ? 1 : 0; }

    // Where the keeper goes.
    let dive;
    if (so.humanKeeps) dive = so.dive ?? 0;
    else {
      // A good keeper sometimes reads the shooter; otherwise it is a guess.
      if (rng.chance(0.10 + gkSkill * 0.14)) dive = zone;
      else { const r = rng.next(); dive = r < 0.4 ? -1 : r < 0.8 ? 1 : 0; }
    }

    const outcome = shootoutOutcome({ zone, dive, placement, gkSkill, rng });
    so.outcome = outcome;
    so.dive = dive;

    // --- Show it ------------------------------------------------------------
    const f = this.profile.field;
    const half = f.goalWidth / 2;
    const gz = this.attackDir[side] * (f.length / 2);
    const from = shooter.handPoint();
    let tx = zone * half * lerp(0.62, 0.8, rng.next());
    let ty = lerp(0.35, 0.72, rng.next()) * f.goalHeight;
    so.diveX = dive * half * 0.7;
    if (outcome === 'miss') { tx = (zone || (rng.chance(0.5) ? 1 : -1)) * (half + 0.35); }
    else if (outcome === 'save') so.diveX = tx;                    // the keeper gets to it
    else if (dive === zone && zone !== 0) {
      // Right way, still beaten: into the top corner, past the fingertips -
      // not through a keeper standing where the ball goes.
      tx = zone * half * 0.9; ty = 0.82 * f.goalHeight; so.diveX = dive * half * 0.42;
    }
    const dx = tx - from.x, dz = gz - from.z;
    const flat = Math.hypot(dx, dz);
    const speed = 16.5;
    const t = flat / speed;
    const vy = (ty - from.y) / t + 0.5 * 9.81 * t;
    shooter.hasBall = false;
    shooter.pendingPenalty = false;
    shooter.stats.shots++;
    this.stats[side].shots++;
    this.ball.launch(from, { x: dx / flat * speed, y: vy, z: dz / flat * speed }, { x: 0, y: 0, z: 0 }, 'shot', shooter);
    this._lastShooter = { athlete: shooter, at: this.clockNow };
    this.bus.emit('shot', { shooter, res: { quality: 0.5 } });
    this.shootoutPrompt = null;
    so.phase = 'flight';
    so.timer = 2.6;
  }

  /** Put the keeper where they chose to go, so what you see matches the result. */
  _shootoutKeeperPose(dt) {
    const so = this.shootout;
    if (!so?.current) return;
    const gk = this.goalkeeperFor(this.opponentSide(so.current.side));
    if (!gk) return;
    const ownGoal = -gk.attackDir * (this.profile.field.length / 2);
    const x = so.phase === 'flight' ? so.diveX : 0;
    gk.pos.x += (x - gk.pos.x) * Math.min(1, dt * (so.phase === 'flight' ? 9 : 4));
    gk.pos.z = ownGoal + gk.attackDir * 0.3;
    gk.vel.set(0, 0);
    if (so.phase === 'flight' && so.dive !== 0) gk.elevation = Math.max(gk.elevation, 0.7);
  }

  _positionShootout(side, shooter) {
    const f = this.profile.field;
    const dir = this.attackDir[side];
    const gz = dir * (f.length / 2);

    for (const s of ['home', 'away']) {
      for (const a of this.activeAthletes(s)) {
        a.resetForRestart();
        a.hasBall = false;
        if (a.isGoalkeeper) {
          const ownGoal = -a.attackDir * (f.length / 2);
          a.pos.set(0, ownGoal + a.attackDir * 0.3);
          a.heading = a.attackDir > 0 ? 0 : Math.PI;
          a.shoulder = a.heading;
        } else if (a === shooter) {
          a.pos.set(0, gz - dir * f.penaltyLine);
          a.heading = dir > 0 ? 0 : Math.PI;
          a.shoulder = a.heading;
        } else {
          // Everyone else waits on the half-distance line.
          const i = this.activeAthletes(s).indexOf(a);
          a.pos.set((i - 3) * 1.5, s === 'home' ? -1.4 : 1.4);
        }
      }
    }
    this.ball.holder = null;
    this.ball.reset(0, 0.35, gz - dir * f.penaltyLine);
  }

  _onShootoutGoal(sign) {
    const so = this.shootout;
    if (!so || so.phase !== 'flight' || so.resolved) return;
    // Safety net: a kick decided as a save or a miss never counts, even if the
    // ball physically sneaks over the line.
    if (so.outcome && so.outcome !== 'goal') {
      const gk = this.goalkeeperFor(this.opponentSide(so.current.side));
      if (gk) { gk.stats.saves++; this.stats[gk.side].saves++; this.presentation.saveFlash = 1; }
      this._resolveShootoutAttempt(false);
      return;
    }
    const defendingSide = this.attackDir.home === sign ? 'away' : 'home';
    this._resolveShootoutAttempt(this.opponentSide(defendingSide) === so.current.side);
  }

  _resolveShootoutAttempt(scored) {
    const so = this.shootout;
    if (!so || so.resolved) return;
    so.resolved = true;
    this.shootoutPrompt = null;
    const { side, shooter } = so.current;
    so.attempts.push({ side, scored, shooter: shooter.id });
    if (scored) {
      this.score[side]++;
      shooter.stats.goals++;
      this.presentation.goalFlash = 1;
    }
    this._timeline(`${scored ? 'Scored' : 'Saved'} — ${this.teamOf(side).short} shootout ` +
      `${so.attempts.filter((a) => a.side === 'home' && a.scored).length}` +
      `-${so.attempts.filter((a) => a.side === 'away' && a.scored).length}.`);
    this._log('shootoutAttempt', { side, scored, shooter: shooter.id });

    const state = shootoutState(this.profile, so.attempts);
    if (state.finished) { this._finishShootout(state); return; }
    so.phase = 'between';
    so.timer = 1.4;
  }

  _finishShootout(state) {
    this.shootoutResult = { winner: state.winner, home: state.hScore, away: state.aScore };
    this._timeline(state.winner
      ? `${this.teamOf(state.winner).name} win the shootout ${Math.max(state.hScore, state.aScore)}-${Math.min(state.hScore, state.aScore)}.`
      : 'Shootout undecided.');
    this._log('shootoutEnd', this.shootoutResult);
    this._endMatch();
  }

  _updateTimeout(dt) {
    for (const a of this.allActive()) a.recoverOnBench(dt * 0.6);
    if (this.stateTimer <= 0) {
      this._beginLive();
      this.clockRunning = true;
    }
  }

  _updatePeriodEnd(dt) {
    if (this.stateTimer > 0) return;
    const t = periodTransition(this.profile, this.period, this.score);
    if (!t.matchOver) {
      this._setState(MATCH_STATE.INTERVAL, Math.min(t.intervalSeconds, 2.5)); // presentation-length interval
      this.intervalRealSeconds = t.intervalSeconds;
      this._timeline(t.intervalSeconds > 200 ? 'Half time.' : 'Interval.');
    } else if (t.needsShootout) {
      this.shootout = { attempts: [], order: { home: [], away: [] }, index: 0 };
      this._prepareShootout();
      this._setState(MATCH_STATE.SHOOTOUT, 2);
      this._timeline('Scores level - penalty shootout.');
    } else {
      this._endMatch();
    }
  }

  _updateInterval(dt) {
    // Athletes recover at the real interval rate even though the presentation is short.
    const scale = (this.intervalRealSeconds ?? 120) / Math.max(0.5, 6);
    for (const a of [...this.active.home, ...this.active.away]) a.recoverOnBench(dt * scale * 0.5);
    if (this.stateTimer <= 0) {
      this.period++;
      this.gameClock = this.profile.timing.periodSeconds;
      // Teams change ends at half time.
      if (this.period === this.profile.timing.periods / 2 + 1) {
        this.attackDir.home *= -1;
        this.attackDir.away *= -1;
        for (const side of ['home', 'away']) {
          for (const a of this.squads[side]) a.attackDir = this.attackDir[side];
        }
        this._timeline('Teams change ends.');
      }
      this.setupPeriod();
      this._setState(MATCH_STATE.PERIOD_SETUP, 1.1);
      this._log('periodStart', { period: this.period });
    }
  }

  _endMatch() {
    this._setState(MATCH_STATE.MATCH_END, 0);
    this.clockRunning = false;
    const winner = this.score.home === this.score.away ? null : (this.score.home > this.score.away ? 'home' : 'away');
    this._timeline(winner ? `Full time - ${this.teamOf(winner).name} win ${Math.max(this.score.home, this.score.away)}-${Math.min(this.score.home, this.score.away)}.` : `Full time - ${this.score.home}-${this.score.away} draw.`);
    this._log('matchEnd', { score: { ...this.score }, winner });
    this.bus.emit('matchEnd', { score: { ...this.score }, winner });
  }

  // =========================================================================
  // Locomotion drivers
  // =========================================================================

  _driveAthletes(dt, restingPhase) {
    const world = { profile: this.profile, pool: this.profile.field };
    for (const side of ['home', 'away']) {
      for (const a of this.active[side]) {
        if (!a.inPool) {
          // Excluded athletes wait in the re-entry corner.
          a.update(dt, emptyCommand(), world);
          continue;
        }
        let cmd = a.cmd ?? emptyCommand();
        if (restingPhase && a !== this.userAthlete) {
          cmd = { ...cmd, effort: cmd.effort * 0.25, rise: Math.max(cmd.rise * 0.5, 0.25) };
        }
        a.update(dt, cmd, world);
        a.cmd = null;
      }
    }
    // Charging shots / passes advance here so that the release window is honest.
    for (const a of this.allActive()) {
      if (a.charging) a.chargeTime += dt;
      if (a.justCaught) a.justCaught = Math.max(0, a.justCaught - dt);
    }
  }

  _driveGoalkeepers(dt) {
    for (const side of ['home', 'away']) {
      const brain = this.gkBrain[side];
      if (!brain) continue;
      const gk = brain.gk;
      if (!gk.inPool) continue;
      brain.decayFake(dt);
      const userDriving = this.userGkControl && side === this.userControlsSide && this.userAthlete === gk;
      if (!userDriving) {
        gk.cmd = brain.update(dt, { sim: this, difficulty: DIFFICULTY[this.difficultyFor(side)] });
      }
    }
  }

  _applyUserCommand() {
    if (this.userAthlete && this.userAthlete.inPool) this.userAthlete.cmd = this.userCommand;
    if (this.secondUserAthlete && this.secondUserAthlete.inPool) this.secondUserAthlete.cmd = this.secondUserCommand;
  }

  // =========================================================================
  // Ball interactions
  // =========================================================================

  _giveBall(athlete) {
    for (const a of this.allActive()) a.hasBall = false;
    athlete.hasBall = true;
    this.ball.holder = athlete;
    this.ball.lastHolder = athlete;
    this.ball.lastTouchSide = athlete.side;
    this.ball.state = athlete.isGoalkeeper ? BALL_STATE.HELD : BALL_STATE.DRIBBLE;
    athlete.justCaught = 0.55;
    athlete.pumpFakes = 0;
    if (this.possession !== athlete.side) this._setPossession(athlete.side, POSSESSION_EVENT.GAIN);
    // Touching the ball is what starts your shot clock.
    if (athlete.side === this.possession) this.shotClockArmed = true;
  }

  _resolveLooseBall(dt) {
    const b = this.ball;
    if (b.timeSinceLoose < 0.09) return;
    const candidates = this.allActive().filter((a) => a.catchCooldown <= 0);
    let best = null, bestScore = -1e9;
    for (const a of candidates) {
      const hand = a.handPoint();
      const d = b.distanceTo(hand.x, hand.y, hand.z);
      // Swimming ability widens the effective reach for a loose ball - a faster,
      // more explosive swimmer wins the dispute (the user's "disputa de bola").
      const swim = clamp01((a.player.attr.swimSpeed * 0.6 + a.player.attr.firstStroke * 0.4 - 10) / 85);
      // The intended receiver of a pass has the inside track on their own ball.
      // Without this, opponents pick off far too many passes, possessions last
      // only a few seconds and neither team ever gets to set up an attack.
      // A SHOT at your own goal is the save system's business, not a casual
      // pickup. The keeper's generous catch window was quietly gathering fast
      // shots as ordinary loose balls, bypassing attemptSave entirely - which is
      // why the goal looked impossible to beat from close range and why tuning
      // the save model changed nothing. Slow or spent shots are still gatherable.
      // A keeper still scrambling from the shot they just spilled cannot calmly
      // collect their own fumble. Without this they re-gathered nearly every
      // rebound and the put-back - the most dangerous ball in the sport -
      // effectively did not exist.
      if (a.isGoalkeeper && b.kind === 'deflection') {
        const brain = this.gkBrain[a.side];
        if (brain && brain.beaten > 0.2) continue;
      }

      if (a.isGoalkeeper && b.kind === 'shot' && b.speed > 6) {
        const gz = -a.attackDir * (this.profile.field.length / 2);
        const towardMyGoal = Math.sign(b.vel.z) === Math.sign(gz - b.pos.z);
        if (towardMyGoal && Math.abs(b.pos.z - gz) < 6) continue;
      }

      const isTarget = b.kind === 'pass' && b.intendedReceiver === a;
      // Intercepting a pass in flight is hard: an opponent must genuinely get a
      // hand in the lane, not merely be in the neighbourhood.
      const isPass = b.kind === 'pass';
      const opponentOfPasser = isPass && b.lastHolder && b.lastHolder.side !== a.side;
      const intercept = opponentOfPasser ? 0.40 : 1;
      // Now that the AI holds a real formation, passes cover water polo
      // distances instead of the one metre between two players in a scrum. The
      // receiver's advantage has to cover that range or two thirds of all
      // possessions end in a turnover.
      let window = ((a.isGoalkeeper ? 0.55 : 0.42) * (a === this.userAthlete ? this.assist.catchWindow : 1) +
        a.reach * 0.42 + a.elevation * 0.35 + swim * 0.35 * lerp(0.6, 1, a.freshness)) * intercept +
        (isTarget ? 1.05 : 0);
      // A pass is only picked off when a defender's hand is genuinely IN its
      // line. The window above let any opponent within about half a metre of a
      // passing ball take it - the passer's own marker standing beside him, or
      // a defender next to the lane - so passes "stopped in the middle" to a
      // player they were never thrown near. A raised arm in the path still wins
      // it: that is an obvious interception, and it should be.
      if (opponentOfPasser && !a.isGoalkeeper) window = 0.26 + a.armRaised * 0.14 + a.elevation * 0.08;
      // The swim-off is a race to touch the ball, so you have to actually reach
      // it. A metre-and-a-bit pickup radius meant the ball jumped to whoever got
      // close first and you never got a hand to it.
      if (this.state === MATCH_STATE.SWIM_OFF) window = Math.min(window, 0.45);
      if (d < window) {
        // Score by how comfortably they reach it, so the swimmer with margin wins.
        const score = (window - d) + swim * 0.25 + (isTarget ? 1.3 : 0);
        if (score > bestScore) { bestScore = score; best = a; }
      }
    }
    if (!best) return;

    const opp = this.activeAthletes(this.opponentSide(best.side));
    let result = resolveCatch(best, b, this.rng, { pressure: pressureOn(best, opp) });
    // A goalkeeper GATHERING a loose ball holds it. Stopping a shot is the save
    // model's business, and spilling one there is a real outcome; but here the
    // keeper was fumbling ordinary pickups in his own goal mouth with an
    // outfielder's catch reliability - about four times a match, sometimes twice
    // in a row - bobbling it around in front of his own net until an opponent
    // arrived and scored. The safest hands in the team do not do that.
    if (best.isGoalkeeper && !result.controlled && b.speed < 9) {
      result = { ...result, controlled: true, outcome: 'clean' };
    }
    const intended = b.intendedReceiver;

    if (result.controlled) {
      const wasPass = b.kind === 'pass';
      const previous = b.lastHolder;
      const intercepted = previous && previous.side !== best.side;
      this._giveBall(best);
      best.catchCooldown = 0.12;
      // A delayed control costs the receiver a beat before they can act.
      if (result.outcome === 'delayedControl') best.actionLock = 0.32;

      if (wasPass && previous && previous.side === best.side) {
        previous.stats.passesCompleted++;
        this.stats[previous.side].passesCompleted++;
        if (previous !== best) this._pendingAssist = { from: previous, at: this.clockNow };
        if (best.roleSlot?.role === 'CF') { best.stats.centreTouches++; this.stats[best.side].centreTouches++; }
      } else if (intercepted) {
        best.stats.steals++;
        this.stats[best.side].steals++;
        if (previous) { previous.stats.turnovers++; this.stats[previous.side].turnovers++; }
        this._timeline(`Interception - #${best.player.capNumber} ${best.player.name}.`);
        this._openTransition(best.side);
        const ev = shotClockAfter(this.profile, POSSESSION_EVENT.GAIN);
        this._applyShotClock(ev);
      } else if (b.kind === 'shot' || b.kind === 'deflection') {
        // Rebound control.
        best.stats.reboundsControlled++;
        this.stats[best.side].reboundsControlled++;
        const ev = intercepted || best.side !== b.lastTouchSide
          ? shotClockAfter(this.profile, POSSESSION_EVENT.GAIN)
          : shotClockAfter(this.profile, POSSESSION_EVENT.SHOT_SAVED_TO_ATTACK, { remaining: this.shotClock });
        this._applyShotClock(ev);
      }
      this.bus.emit('catch', { athlete: best, outcome: result.outcome });
    } else if (result.outcome === 'bobble' || result.outcome === 'deflection') {
      // A fumble, not a clearance. The ball pops up at the receiver's own hands
      // and they get the first chance at it. Sending it 3.4 m/s in a random
      // direction and then locking the receiver out for a third of a second
      // handed it straight to whoever was marking them: measured, 80% of all
      // possessions lost from a pass were opponents collecting these, not
      // genuine interceptions.
      const away = this.rng.range(0, Math.PI * 2);
      // Keep a fumble AT his hands. At 1.2 m/s the ball squirted a clear metre
      // away and died there, which is what it looks like when a pass "stops in
      // the middle" just short of the man.
      const s = result.outcome === 'deflection' ? 0.75 : 0.45;
      // As with a block: a fumble near your own line should not be as likely to
      // trickle into your own net as to go anywhere else.
      const ownGoalZ = -best.attackDir * (this.profile.field.length / 2);
      const outward = Math.sign(best.pos.z - ownGoalZ) || 1;
      let fz = Math.cos(away) * s;
      if (Math.sign(fz) !== outward) fz *= -0.35;
      b.launch(
        { x: b.pos.x, y: Math.max(0.15, b.pos.y), z: b.pos.z },
        { x: Math.sin(away) * s, y: 0.9, z: fz },
        { x: 0, y: 0, z: 0 }, 'deflection', best
      );
      best.catchCooldown = 0.10;
      b.eventFlags.splash = 0.5;
    } else if (result.outcome === 'drop') {
      best.catchCooldown = 0.42;
      if (b.kind === 'pass' && b.lastHolder && b.lastHolder.side === best.side) {
        best.stats.turnovers++;
        this.stats[best.side].turnovers++;
      }
    }
  }

  _resolveSaves(dt) {
    if (!this.ball.isLoose) return;
    // Saves resolve in the same frame as the goal-line check, straight after it.
    // Once a goal has been given the ball is in the net - it bounces back out,
    // and the keeper was catching it during the celebration. The player saw a
    // SAVE flash, the keeper holding the ball, and then a restart from the
    // centre: "the keeper saves and the game restarts". A goal is final.
    if (this.state === MATCH_STATE.GOAL) return;
    for (const side of ['home', 'away']) {
      const brain = this.gkBrain[side];
      const gk = this.goalkeeperFor(side);
      if (!gk || !brain) continue;
      // A keeper cannot "save" a ball their own team has just thrown.
      //
      // After holding a save the keeper outlets the ball, and that outlet is
      // loose, in the goal mouth, and moving off a hand half a metre in front of
      // the line - so it was being run straight back through the save model by
      // the same keeper who had just caught it. Measured: 67% of held saves put
      // the ball loose again within 0.52s, and the keeper then tipped their own
      // outlet for a corner, parried it, or deflected it into their own net.
      // That own goal is where the "keeper saves, then the game restarts from
      // half court as if it were a goal" came from.
      //
      // A shot deflected toward goal by an outfield DEFENDER must still be
      // savable, so this is deliberately narrow: only the keeper's own throw and
      // their own team's passes are excluded, not every touch by that side.
      if (this.ball.lastHolder === gk) continue;
      if ((this.ball.kind === 'pass' || this.ball.kind === 'outlet')
        && this.ball.lastTouchSide === side) continue;

      // Only the keeper whose goal is threatened.
      const gz = brain.goalZ(this.profile);
      if (Math.sign(this.ball.vel.z) !== Math.sign(gz - this.ball.pos.z)) continue;
      if (Math.abs(this.ball.pos.z - gz) > 2.6) continue;

      // Breakaway: see tryShot. The keeper gets a token chance, not a real one -
      // and it is ONE roll for the shot, decided when it was taken. Rolling it
      // here meant rolling every frame the ball was near the goal, which over
      // the ten or so frames of its flight came to a 46% chance of a save on a
      // ball nobody should be stopping.
      if (this.ball.breakaway && !this.ball.breakawaySave) continue;

      const manual = (this.userGkControl && this.userAthlete === gk) ? this.userCommand.saveAim : null;
      const res = attemptSave(gk, this.ball, brain, this.rng, { manualDirection: manual });
      if (!res) continue;

      // A slow ball is GATHERED, not saved. The save model spills about a
      // quarter of everything by design - right for a shot, absurd for a ball
      // rolling gently at the keeper: he parried it a metre away, it drifted
      // back, he parried it again, until an opponent arrived and scored. Held,
      // and only a real shot counts as a save or flashes SAVE.
      if (this.ball.speed < 7) {
        const wasShot = this.ball.kind === 'shot';
        const changesHands = this.possession !== side;
        this._lastShooter = null;
        this._giveBall(gk);
        if (changesHands || wasShot) {
          this._applyShotClock(shotClockAfter(this.profile, POSSESSION_EVENT.GAIN));
          this._openTransition(side);
        }
        if (wasShot) {
          gk.stats.saves++; this.stats[side].saves++;
          this.bus.emit('save', { gk, outcome: 'controlled' });
        }
        return;
      }

      gk.stats.saves++;
      this.stats[side].saves++;
      this.presentation.saveFlash = 1;
      // Whatever the keeper did with it - held, tipped, parried or spilled -
      // that shot has been SAVED, and a save cannot turn into a goal on its own.
      // Leaving the shooter on record meant a tip that dropped under the bar or
      // a parry that squirted over the line was still credited to the shot,
      // counted as a goal, and restarted the match from the centre. Only a new
      // shot (a put-back rebound goes through tryShot) can score now; a ball the
      // keeper merely pushes over their own line is a corner throw.
      this._lastShooter = null;
      this.bus.emit('save', { gk, outcome: res.outcome });
      this._timeline(`Save - #${gk.player.capNumber} ${gk.player.name} (${res.outcome}).`);

      if (res.outcome === 'tipped') {
        // Over the bar or round the post. It leaves play off the keeper's hand,
        // which is exactly what a corner throw is for.
        // Launched from ABOVE the crossbar - the keeper tips it over with a
        // raised hand. Starting it high is what makes this unambiguously a
        // corner rather than a ball scraping under the bar into their own net.
        const barY = this.profile.field.goalHeight + 0.35;
        // Drive it out in proportion to how far off the line the keeper is, so
        // the ball always clears - a keeper who had come out was tipping it into
        // the water short of the line, and the "corner" never happened.
        const toLine = Math.abs(gk.pos.z - gz);
        const back = Math.max(5, toLine * 7);
        // Always UP and over: a tip that left the hand already descending dropped
        // under the crossbar on its way out and went in.
        const tipVel = { ...res.vel, y: Math.max(res.vel.y, 3.2), z: Math.sign(gz - gk.pos.z) * back };
        // A keeper who has just punched the ball away cannot turn round and
        // catch it again. Without this they re-gathered their own tip before it
        // crossed, and the corner never happened.
        gk.catchCooldown = Math.max(gk.catchCooldown, 0.7);
        brain.beaten = Math.max(brain.beaten, 0.5);
        this.ball.launch(
          { x: this.ball.pos.x, y: Math.max(barY, this.ball.pos.y), z: this.ball.pos.z },
          tipVel, { x: 0, y: 0, z: 0 }, 'deflection', gk
        );
        this.ball.eventFlags.splash = 0.4;
      } else if (res.outcome === 'controlled') {
        // The keeper has caught and held it: that shot is finished. Leaving the
        // shooter on record meant a ball that later squirted over the line in a
        // scramble was still credited to their shot, which made it a goal
        // instead of a corner - and restarted the match from the centre after a
        // save the keeper had cleanly held.
        this._lastShooter = null;
        this._giveBall(gk);
        const ev = shotClockAfter(this.profile, POSSESSION_EVENT.GAIN);
        this._applyShotClock(ev);
        this._openTransition(side);
        gk.stats.reboundsControlled++;
      } else {
        // A keeper who has spilled the ball is scrambling, not set. The rebound
        // that follows meets a goalkeeper still recovering their position, which
        // is what makes a put-back the most dangerous ball in water polo.
        //
        // But a parry goes AWAY from the goal. A keeper who gets a hand to the
        // ball and pushes it backwards into their own net is not a save, it is a
        // goal they invented - and it was happening after one held save in ten,
        // which from the player's seat is "the keeper saved it and the match
        // restarted". Blocks and fumbles were already biased outward; the
        // keeper's own spill was not.
        const spillOut = Math.sign(gk.pos.z - gz) || 1;
        if (Math.sign(res.vel.z) !== spillOut) res.vel.z *= -0.4;
        brain.beaten = 0.95;
        this.ball.launch(
          { x: this.ball.pos.x, y: Math.max(0.2, this.ball.pos.y), z: this.ball.pos.z },
          res.vel, { x: 0, y: 0, z: 0 }, 'deflection', gk
        );
        this.ball.eventFlags.splash = 0.7;
      }
      return;
    }
  }

  _onGoalLineCrossed(ball, sign) {
    if (this.state === MATCH_STATE.GOAL) return;

    // Only a shot (or a shot the goalkeeper/defender deflected) may score. A
    // pass that happens to cross the line is the ball going out of play, not a
    // goal - otherwise the AI "scores" by lobbing passes into an empty net.
    if (ball.kind !== 'shot' && ball.kind !== 'deflection') {
      this._onEndLine(ball, sign);
      return;
    }

    const defendingSide = this.attackDir.home === sign ? 'away' : 'home';
    const scoringSide = this.opponentSide(defendingSide);

    // A deflection with no shot behind it is not a goal, it is the defence
    // putting the ball over their own line - which is a corner throw.
    //
    // This is the "the keeper saves it and the match restarts from half court"
    // bug. A save was followed by a fumble or a scramble in the goal mouth, the
    // ball trickled over the line with no attacker having shot at all, and it
    // was recorded as a goal, so the game restarted from the centre as if one
    // had been scored. A shot deflected in off a defender still counts, because
    // there the shooter IS attributable - that is a real own goal.
    const ls = this._lastShooter;
    const fromAShot = ls && ls.athlete.side === scoringSide && this.clockNow - ls.at < 4;
    if (ball.kind === 'deflection' && !fromAShot) {
      this._onEndLine(ball, sign);
      return;
    }

    // A ball put into their own goal still counts for the opponents.
    this._awardGoal(scoringSide, ball);
  }

  _onEndLine(ball, sign) {
    if (!this.isLive()) return;
    if (ball.timeSinceLoose < 0.05) return;
    // A ball in someone's hands has not gone anywhere.
    if (ball.holder) return;
    // The ball must actually be LEAVING the field across this line. The keeper
    // stands within a few centimetres of their own goal line, so an outlet pass
    // is released from behind it and was instantly judged to have gone out -
    // handing the attack a corner nearly every time the keeper touched the ball.
    // A ball travelling back into play has not gone out, wherever it started.
    if (Math.sign(ball.exitVelZ ?? ball.vel.z) !== sign) return;
    const defendingSide = this.attackDir.home === sign ? 'away' : 'home';
    const decision = endLineRestart(this.profile, ball.lastTouchSide, defendingSide, ball.pos.x);
    const f = this.profile.field;
    if (decision.kind === 'corner') {
      const attackingSide = decision.side;
      const spotZ = this.attackDir[attackingSide] * (f.length / 2 - f.restrictedLine);
      this._beginRestart(attackingSide, { x: decision.spot.x, z: spotZ }, POSSESSION_EVENT.CORNER, 'Corner throw');
    } else {
      const gk = this.goalkeeperFor(defendingSide);
      const spotZ = -this.attackDir[defendingSide] * (f.length / 2 - 0.6);
      this._beginRestart(defendingSide, { x: clamp(ball.pos.x, -3, 3), z: spotZ }, POSSESSION_EVENT.GOAL_THROW, 'Goal throw', gk);
    }
  }

  _awardGoal(side, ball) {
    this.score[side]++;
    let scorer = ball.lastHolder && ball.lastHolder.side === side ? ball.lastHolder : null;
    // Deflected in: credit the shooter whose attempt it was.
    const ls = this._lastShooter;
    if (!scorer && ls && ls.athlete.side === side && this.clockNow - ls.at < 4) scorer = ls.athlete;
    this.lastGoal = { side, scorer, at: this.clockNow, period: this.period, clock: this.gameClock };

    if (scorer) {
      scorer.stats.goals++;
      scorer.stats.shotsOnGoal++;
      this.stats[side].goals++;
      this.stats[side].shotsOnGoal++;
      // A rebound put back into the net is a shot attempt, even though it never
      // went through the deliberate shooting path. Without this the goal counts
      // but the attempt does not, and shooting percentage exceeds 100%.
      if (ball.kind !== 'shot' && scorer !== this._lastShooter?.athlete) {
        scorer.stats.shots++;
        this.stats[side].shots++;
      }
      // A counter goal is one scored within nine seconds of winning the ball,
      // before the defence could set. This used the 3.2s AI transition cue,
      // which expires long before a counter swum from your own half arrives,
      // so the stat read zero almost every match.
      const cb = this.counterBreak;
      if (cb && cb.side === side && this.clockNow - cb.at < 9) { scorer.stats.counterGoals++; this.stats[side].counterGoals++; }
      if (this._pendingAssist && this.clockNow - this._pendingAssist.at < 4 && this._pendingAssist.from.side === side) {
        this._pendingAssist.from.stats.assists++;
        this.stats[side].assists++;
      }
      if (this._extraPlayerAttack === side) this.stats[side].extraPlayerGoals++;
    }
    this._pendingAssist = null;

    this.presentation.goalFlash = 1;
    this.presentation.whistle = 1;
    this.presentation.shake = 1;
    this._timeline(`GOAL - ${this.teamOf(side).short} ${this.score.home}-${this.score.away}${scorer ? ` (#${scorer.player.capNumber} ${scorer.player.name})` : ''}.`);
    this._log('goal', { side, scorer: scorer?.id ?? null, score: { ...this.score }, period: this.period, clock: this.gameClock });
    this.bus.emit('goal', { side, scorer, score: { ...this.score } });

    // Excluded players of the conceding team may re-enter immediately.
    this._tickExclusions(0, { goalScored: true, scoringSide: side });

    this.clockRunning = false;
    this._setState(MATCH_STATE.GOAL, this.profile.timing.restartDelay.goal);
    for (const a of this.allActive()) { a.hasBall = false; a.resetForRestart(); }
    this.ball.holder = null;
  }

  /**
   * Place both teams in a real water polo shape for a centre restart, in their
   * own half, spread across the lanes their formation uses. Lining everyone up
   * in a row at half way (the old behaviour) made the game look like a scramble
   * every time anyone scored - and with frequent goals, that was most of it.
   */
  _positionForCentreRestart(restartSide) {
    const f = this.profile.field;
    for (const side of ['home', 'away']) {
      const dir = this.attackDir[side];
      const list = this.activeAthletes(side).filter((a) => !a.isGoalkeeper);
      const gk = this.activeAthletes(side).find((a) => a.isGoalkeeper);
      if (gk) { gk.pos.set(0, -dir * (f.length / 2 - 0.6)); gk.vel.set(0, 0); }

      // Lanes across the pool, and staggered depth, all inside their own half.
      const lanes = [-5.2, -3.0, 0.0, 3.0, 5.2, -1.5];
      const depth = [3.2, 5.0, 6.6, 5.0, 3.2, 8.0];   // metres back from half way
      const restarting = side === restartSide;
      list.forEach((a, i) => {
        const lane = lanes[i % lanes.length];
        const back = depth[i % depth.length] * (restarting ? 0.75 : 1.0);
        a.pos.set(lane, -dir * back);
        a.vel.set(0, 0);
        a.heading = dir > 0 ? 0 : Math.PI;
        a.shoulder = a.heading;
      });
      // The athlete taking the restart sits on the half-distance line.
      if (restarting && list.length) {
        const taker = list.slice().sort((x, y) => Math.abs(x.pos.x) - Math.abs(y.pos.x))[0];
        taker.pos.set(0, -dir * 0.8);
      }
    }
    this.roleDirty = true;
  }

  // =========================================================================
  // Fouls, exclusions, penalties
  // =========================================================================

  _awardFoul(foul) {
    if (!this.isLive()) return;
    const offender = foul.offender;
    const victim = foul.victim;
    const attackingSide = victim.side;

    // A player who has already fouled out cannot commit another foul - they are
    // out of the water. Guards against a stray contact event being charged to
    // someone past the personal-foul limit.
    if (!offender.inPool || offender.excludedForMatch ||
        offender.personalFouls >= this.profile.discipline.personalFoulLimit) {
      return;
    }

    this.presentation.whistle = 1;
    this.explain = explainFoul(this.profile, foul);
    this.bus.emit('foul', { foul, explanation: this.explain });
    this._log('foul', {
      type: foul.type, offender: offender.id, victim: victim.id,
      at: foul.at, reason: foul.reason, clock: this.gameClock, period: this.period,
    });

    if (foul.type === FOUL.ORDINARY) {
      offender.stats.ordinaryFouls++;
      this.stats[offender.side].ordinaryFouls++;
      const { spot, directShot } = freeThrowSpot(this.profile, foul.at, this.attackDir[attackingSide]);
      const sameTeam = this.possession === attackingSide;
      this._applyShotClock(shotClockAfter(this.profile, POSSESSION_EVENT.ORDINARY_FOUL, { sameTeam }));
      this._beginRestart(attackingSide, spot, null, `Free throw${directShot ? ' (direct shot permitted)' : ''}`, victim);
      return;
    }

    if (foul.type === FOUL.EXCLUSION || foul.type === FOUL.BRUTALITY) {
      const pf = personalFoulResult(this.profile, offender.personalFouls);
      offender.personalFouls = pf.count;
      offender.stats.personalFouls = pf.count;
      offender.stats.exclusionsConceded++;
      victim.stats.exclusionsDrawn++;
      this.stats[offender.side].exclusionsConceded++;
      this.stats[attackingSide].exclusionsDrawn++;

      const seconds = foul.type === FOUL.BRUTALITY
        ? this.profile.discipline.brutalityExclusionSeconds
        : this.profile.timing.exclusionSeconds;

      this._excludeAthlete(offender, seconds, pf.excludedForMatch);
      this._applyShotClock(shotClockAfter(this.profile, POSSESSION_EVENT.EXCLUSION_AWARDED));
      this._extraPlayerAttack = attackingSide;
      this.stats[attackingSide].extraPlayerAttacks++;

      const { spot } = freeThrowSpot(this.profile, foul.at, this.attackDir[attackingSide]);
      this._beginRestart(attackingSide, spot, null,
        pf.excludedForMatch ? 'Exclusion - third personal foul, substitute permitted' : 'Exclusion', victim,
        MATCH_STATE.EXCLUSION_FOUL);
      this._timeline(`Exclusion - #${offender.player.capNumber} ${offender.player.name} (${pf.count} personal).`);
      return;
    }

    if (foul.type === FOUL.PENALTY) {
      const pf = personalFoulResult(this.profile, offender.personalFouls);
      offender.personalFouls = pf.count;
      offender.stats.penaltiesConceded++;
      victim.stats.penaltiesDrawn++;
      this.stats[offender.side].penaltiesConceded++;
      this.stats[attackingSide].penaltiesDrawn++;
      this._excludeAthlete(offender, this.profile.timing.exclusionSeconds, pf.excludedForMatch);
      this._setupPenalty(attackingSide, victim);
      this._timeline(`Penalty throw to ${this.teamOf(attackingSide).short}.`);
    }
  }

  _excludeAthlete(athlete, seconds, forMatch) {
    athlete.inPool = false;
    athlete.excluded = true;
    athlete.hasBall = false;
    athlete.excludedForMatch = !!forMatch;
    athlete.exclusionRemaining = seconds;
    const f = this.profile.field;
    const dir = athlete.attackDir;
    athlete.pos.set(Math.sign(athlete.pos.x || 1) * (f.width / 2 - 0.3), -dir * (f.length / 2 - 0.8));
    athlete.vel.set(0, 0);

    this.exclusions.push({
      athlete, side: athlete.side, remaining: seconds, forMatch: !!forMatch,
      startedAt: this.clockNow,
    });
    this.roleDirty = true;

    if (forMatch) {
      // A substitute may enter immediately for a third personal foul.
      const sub = this.bench[athlete.side]
        .filter((b) => !b.excludedForMatch && !b.isGoalkeeper)
        .sort((a, b) => b.freshness * 40 + b.player.overall - (a.freshness * 40 + a.player.overall))[0];
      if (sub) this._pendingSubAfterExclusion = { side: athlete.side, out: athlete, in: sub, at: this.clockNow + seconds };
    }
  }

  _tickExclusions(dt, events) {
    if (!this.exclusions.length) return;
    const remaining = [];
    for (const ex of this.exclusions) {
      const res = exclusionTick(this.profile, ex, dt, {
        goalScored: events.goalScored && events.scoringSide !== ex.side,
        possessionRegained: events.possessionRegained,
      });
      ex.remaining = res.exclusion.remaining;
      ex.athlete.exclusionRemaining = Math.max(0, ex.remaining);
      if (res.done) {
        this._reenter(ex, res.reason);
      } else {
        remaining.push(ex);
      }
    }
    if (remaining.length !== this.exclusions.length) this.roleDirty = true;
    this.exclusions = remaining;
  }

  _reenter(ex, reason) {
    const a = ex.athlete;
    a.excluded = false;
    a.exclusionRemaining = 0;
    if (ex.forMatch) {
      // Stays out; the substitute takes the place.
      const pending = this._pendingSubAfterExclusion;
      if (pending && pending.out === a) {
        this._doSubstitution(pending.side, pending.out, pending.in, true);
        this._pendingSubAfterExclusion = null;
      }
      return;
    }
    const f = this.profile.field;
    a.inPool = true;
    a.pos.set(Math.sign(a.pos.x || 1) * (f.width / 2 - 0.5), -a.attackDir * (f.length / 2 - f.restrictedLine));
    a.vel.set(0, 0);
    a.elevation = 0;
    this._log('reentry', { athlete: a.id, reason });
    this.bus.emit('reentry', { athlete: a, reason });
    if (this._extraPlayerAttack && this.activeCount('home') === this.activeCount('away')) this._extraPlayerAttack = null;
  }

  _setupPenalty(attackingSide, victim) {
    const f = this.profile.field;
    const dir = this.attackDir[attackingSide];
    const gz = dir * (f.length / 2);
    // The best available penalty taker, or the fouled athlete if the user prefers.
    const takers = this.activeAthletes(attackingSide).filter((a) => !a.isGoalkeeper);
    const taker = takers.sort((a, b) =>
      (b.player.attr.penaltyComposure + b.player.attr.shotPlacement) -
      (a.player.attr.penaltyComposure + a.player.attr.shotPlacement))[0] ?? victim;

    taker.pos.set(0, gz - dir * f.penaltyLine);
    taker.vel.set(0, 0);
    taker.heading = dir > 0 ? 0 : Math.PI;
    taker.shoulder = taker.heading;

    // Everyone else clears to outside the 5m line, on the sides.
    let k = 0;
    for (const side of ['home', 'away']) {
      for (const a of this.activeAthletes(side)) {
        if (a === taker) continue;
        if (a.isGoalkeeper) {
          const ownGoal = -a.attackDir * (f.length / 2);
          a.pos.set(0, ownGoal + a.attackDir * 0.25);
          continue;
        }
        const sgn = k % 2 === 0 ? 1 : -1;
        a.pos.set(sgn * (f.width / 2 - 0.8), gz - dir * (f.penaltyLine + 1.6 + Math.floor(k / 2) * 0.9));
        a.vel.set(0, 0);
        k++;
      }
    }
    this.ball.reset(taker.pos.x, 0.4, taker.pos.z);
    this.pendingRestart = { taker, taken: false, kind: 'penalty' };
    this.clockRunning = false;
    this._setPossession(attackingSide, POSSESSION_EVENT.PENALTY);
    this._setState(MATCH_STATE.PENALTY_FOUL, this.profile.timing.restartDelay.penalty);
  }

  _beginRestart(side, spot, possessionEvent, label, preferredTaker = null, state = MATCH_STATE.ORDINARY_FOUL) {
    const takers = this.activeAthletes(side);
    let taker = preferredTaker && preferredTaker.inPool && preferredTaker.side === side ? preferredTaker : null;
    if (!taker) {
      taker = takers.filter((a) => !a.isGoalkeeper)
        .sort((a, b) => Math.hypot(a.pos.x - spot.x, a.pos.z - spot.z) - Math.hypot(b.pos.x - spot.x, b.pos.z - spot.z))[0]
        ?? takers[0];
    }
    if (possessionEvent) this._applyShotClock(shotClockAfter(this.profile, possessionEvent));
    this._setPossession(side, possessionEvent ?? POSSESSION_EVENT.ORDINARY_FOUL);

    this.ball.reset(spot.x, 0.25, spot.z);
    this.pendingRestart = { taker, spot, label };
    this.clockRunning = false;
    for (const a of this.allActive()) { a.hasBall = false; a.charging = null; }
    this.ball.holder = null;
    this._setState(state, this.profile.timing.restartDelay[state === MATCH_STATE.EXCLUSION_FOUL ? 'exclusion' : 'ordinary']);
    if (label) this._timeline(label);
  }

  _turnover(toSide, reason) {
    this._timeline(reason === 'shotClockExpired' ? 'Shot clock expired - turnover.' : 'Turnover.');
    this._log('turnover', { to: toSide, reason });
    const prev = this.opponentSide(toSide);
    this.stats[prev].turnovers++;
    if (this.ball.holder) this.ball.holder.stats.turnovers++;

    // The ball stays where the turnover happened and is picked up by the nearest
    // opponent. It used to be teleported the length of the pool to the new
    // team's goalkeeper, which handed them a free restart and wiped out any
    // counterattack the turnover had just created.
    const f = this.profile.field;
    const halfW = f.width / 2 - 0.4;
    const halfL = f.length / 2 - 0.4;
    const spot = {
      x: clamp(this.ball.pos.x, -halfW, halfW),
      z: clamp(this.ball.pos.z, -halfL, halfL),
    };
    const takers = this.activeAthletes(toSide).filter((a) => !a.isGoalkeeper && a.inPool);
    const taker = takers.sort((a, b) =>
      Math.hypot(a.pos.x - spot.x, a.pos.z - spot.z) -
      Math.hypot(b.pos.x - spot.x, b.pos.z - spot.z))[0]
      ?? this.goalkeeperFor(toSide);
    this._beginRestart(toSide, spot, POSSESSION_EVENT.GAIN, null, taker);
    this._openTransition(toSide);
  }

  _setPossession(side, event) {
    if (this.possession === side) return;
    const previous = this.possession;
    this.possession = side;
    this.shotClockArmed = false;   // re-armed when this team touches the ball
    this.roleDirty = true;
    if (previous) this._tickExclusions(0, { possessionRegained: side });
    // Any change of possession in open play can start a break - including a
    // goal throw after a missed shot, which never went through _openTransition.
    // A centre restart after a goal is a set play, not a counter.
    if (previous && event !== POSSESSION_EVENT.GOAL) this.counterBreak = { side, at: this.clockNow };
    this.bus.emit('possession', { side, previous, event });
    this._log('possession', { side, event });
    if (this._extraPlayerAttack && this._extraPlayerAttack !== side) this._extraPlayerAttack = null;
  }

  _applyShotClock(res) {
    if (!res) return;
    this.shotClock = res.value;
    this.shotClockSecondary = res.secondary;
  }

  _openTransition(side) {
    this.transitionTimer = 3.2;
    // Remember the break itself. transitionTimer is a 3.2s AI cue and runs out
    // long before a counter swum from your own half arrives at the goal - which
    // meant a player alone three metres out on a genuine break was scored as a
    // set attack, and could be saved or miss.
    this.counterBreak = { side, at: this.clockNow };
    this.stats[side].counterOpportunities++;
  }

  // =========================================================================
  // Public action API (called by input and by the AI)
  // =========================================================================

  tryPass(passer, target, type = PASS_TYPES.DRY, power = 0.6) {
    if (!passer.hasBall || passer.actionLock > 0) return false;
    const opponents = this.activeAthletes(this.opponentSide(passer.side));
    // Lead the receiver. A pass is aimed at where the swimmer WILL be, not where
    // they are: at 7-15 m/s a cross-pool pass is airborne for most of a second,
    // and a receiver swimming at 3 m/s has left by the time it arrives. This
    // only began to matter once the AI held a real formation - when the whole
    // team was bunched a metre apart, every pass was point blank and the missing
    // lead was invisible.
    const aim = target.pos
      ? (() => {
          const d = Math.hypot(target.pos.x - passer.pos.x, target.pos.z - passer.pos.z);
          // A lob hangs far longer than a flat pass, and guessing that as a flat
          // fraction of the throw speed put the ball behind or short of a
          // swimming team-mate. Ask the lob solver itself how long it will hang.
          const flight = type === PASS_TYPES.LOB
            ? lobFlight(d, passer.handPoint().y, 0.7).time
            : d / lerp(8.5, 15, clamp01((passer.player.attr.passVelocity - 10) / 85));
          const t = Math.min(flight, 1.6);
          return { x: target.pos.x + target.vel.x * t, z: target.pos.z + target.vel.z * t };
        })()
      : target;
    const assist = passer === this.userAthlete ? this.assist.pass : 0.55;

    const res = resolvePass(passer, aim, {
      type, power, opponents, rng: this.rng, receiver: target.pos ? target : null, assist,
    });

    passer.hasBall = false;
    passer.actionLock = lerp(0.34, 0.16, clamp01((passer.player.attr.quickRelease - 10) / 85));
    // Do not let the passer re-grab their own pass. tryShot has always done
    // this; tryPass never did, so the passer - who is by definition the closest
    // athlete to the ball the instant it leaves their hand - simply caught it
    // straight back. That is the "I press pass, the ball leaves my hand and
    // comes back" bug, and it hit the AI just as hard as the player.
    passer.catchCooldown = Math.max(passer.catchCooldown, 0.95);
    passer.stats.passesAttempted++;
    this.stats[passer.side].passesAttempted++;
    this.ball.intendedReceiver = res.receiver;
    this.ball.launch(res.from, res.vel, res.spin, 'pass', passer);
    this.ball.eventFlags.splash = 0.25;
    this.bus.emit('pass', { passer, res });
    this._log('pass', { by: passer.id, to: res.receiver?.id ?? null, type, quality: +res.quality.toFixed(3) });
    return true;
  }

  tryShot(shooter, aim, type = null, charge = 0.7) {
    if (!shooter.hasBall || shooter.actionLock > 0) return false;
    const attackDir = shooter.attackDir;
    const aimPoint = goalAimPoint(this.profile, attackDir, aim);
    const opponents = this.activeAthletes(this.opponentSide(shooter.side));
    const gk = this.goalkeeperFor(this.opponentSide(shooter.side));
    const distToGoal = Math.hypot(shooter.pos.x - aimPoint.x, shooter.pos.z - aimPoint.z);
    const shotType = type ?? contextualShotType(
      shooter, distToGoal, pressureOn(shooter, opponents), shooter.pumpFakes > 0,
      // "The keeper has come out" must mean genuinely stranded off the line. At
      // the old 1.0m a keeper standing normally counted as charging out.
      shooter.justCaught > 0, !!gk && Math.abs(gk.pos.z - aimPoint.z) > 3.6
    );

    // Release timing.
    //
    // A human holds the shoot button and releases inside a window; how close
    // they get to their athlete's ideal preparation time is their timing score.
    //
    // The AI does not press buttons, so scoring it on a charge time it never
    // accumulated would punish it for nothing. Instead its release quality comes
    // from the athlete's own release speed and composure, scaled by difficulty -
    // which is exactly where section 19.2 says difficulty is allowed to act.
    const ideal = lerp(0.55, 0.3, clamp01((shooter.player.attr.releaseSpeed - 10) / 85));
    let timing;
    if (shooter.charging === 'shot' || shooter.chargeTime > 0.01) {
      timing = clamp01(1 - Math.abs(shooter.chargeTime - ideal) / 0.55);
    } else {
      const skill = clamp01((shooter.player.attr.releaseSpeed * 0.5 + shooter.player.attr.composure * 0.5 - 10) / 85);
      const diff = DIFFICULTY[this.difficultyFor(shooter.side)] ?? DIFFICULTY.national;
      timing = clamp01(lerp(0.45, 0.95, skill) * lerp(0.82, 1.05, diff.recognition) +
        this.rng.gauss(0, diff.error * 0.5));
    }

    // A genuine breakaway is not a probability question. If you have broken away
    // on the counter, you are inside five metres, and there is no defender near
    // enough to touch you, then the ball goes in: the keeper is not consulted
    // (see _resolveSaves) and the shot is not allowed to fly wide either - a
    // quick press used to score as poor release timing and the auto-aim went for
    // the post, so a player alone three metres out could still miss the goal.
    // In a set attack from the same spot the keeper keeps every chance.
    // Only a defender who can still get between you and the goal counts. On a
    // real counter somebody is nearly always chasing BEHIND you - the old
    // "nobody within 3.5m in any direction" test let that trailing swimmer
    // switch the whole rule off, so a player alone in front of the keeper at
    // three metres was scored as a set attack and could miss.
    const toGoalX = aimPoint.x - shooter.pos.x, toGoalZ = aimPoint.z - shooter.pos.z;
    const toGoalLen = Math.hypot(toGoalX, toGoalZ) || 1;
    const chasers = opponents.filter((o) => {
      if (o.isGoalkeeper) return false;
      const dx = o.pos.x - shooter.pos.x, dz = o.pos.z - shooter.pos.z;
      const d = Math.hypot(dx, dz);
      const ahead = (dx * toGoalX + dz * toGoalZ) / toGoalLen;   // metres goalward of you
      return d < 2.2 && ahead > -0.6;                          // level with you or in front, within reach
    }).length;
    // On the break: your team won the ball recently enough that the defence has
    // not got back (a full-length counter takes six to eight seconds), and no
    // defender is between you and the goal.
    const cb = this.counterBreak;
    const onTheBreak = this.transitionTimer > 0 ||
      (cb && cb.side === shooter.side && this.clockNow - cb.at < 10);
    const gzShot = aimPoint.z;
    const goalside = opponents.some((o) => !o.isGoalkeeper &&
      Math.abs(gzShot - o.pos.z) < Math.abs(gzShot - shooter.pos.z) && Math.abs(o.pos.x - shooter.pos.x) < 2.5);
    const breakaway = onTheBreak && distToGoal < 5.0 && chasers === 0 && !goalside;

    const res = resolveShot(shooter, aimPoint, {
      breakaway,
      type: shotType, charge, timing, opponents, rng: this.rng,
      goalkeeper: gk, profile: this.profile, shotClock: this.shotClock,
    });

    shooter.hasBall = false;
    shooter.charging = null;
    shooter.chargeTime = 0;
    shooter.actionLock = shotType === SHOT_TYPES.QUICK ? 0.18 : 0.38;
    shooter.catchCooldown = Math.max(shooter.catchCooldown, 0.35);  // don't re-grab your own shot
    shooter.stats.shots++;
    shooter.stats.shotLocations.push({ x: +shooter.pos.x.toFixed(2), z: +shooter.pos.z.toFixed(2), type: shotType, q: +res.quality.toFixed(3) });
    this.stats[shooter.side].shots++;
    if (this._extraPlayerAttack === shooter.side) this.stats[shooter.side].extraPlayerShots++;

    this.ball.intendedReceiver = null;
    this.ball.launch(res.from, res.vel, res.spin, 'shot', shooter);

    this.ball.breakaway = breakaway;
    this.ball.breakawaySave = breakaway && this.rng.chance(0.06);

    this.lastShot = res;
    // Remember who shot, so a shot that goes in off a keeper's hand or a
    // blocker still belongs to the shooter. Otherwise the goal is recorded with
    // no scorer and no attempt, and shooting percentage climbs above 100%.
    this._lastShooter = { athlete: shooter, at: this.clockNow };
    this.bus.emit('shot', { shooter, res });
    this._log('shot', { by: shooter.id, shotType, quality: +res.quality.toFixed(3), timing: +timing.toFixed(2) });

    // The keeper's read of a shooter who fakes constantly.
    const brain = this.gkBrain[this.opponentSide(shooter.side)];
    if (brain && shooter.pumpFakes > 0) brain.noteFake();
    shooter.pumpFakes = 0;
    return true;
  }

  tryPumpFake(athlete) {
    if (!athlete.hasBall || athlete.actionLock > 0) return false;
    if (this.clockNow - athlete.lastPumpFakeAt < 0.45) return false;
    athlete.pumpFakes++;
    athlete.lastPumpFakeAt = this.clockNow;
    athlete.actionLock = 0.22;
    // Repeated fakes cost stability and burst (section 14.5).
    athlete.burst = clamp01(athlete.burst - 0.035 * athlete.pumpFakes);
    const brain = this.gkBrain[this.opponentSide(athlete.side)];
    if (brain) brain.noteFake();
    this.bus.emit('pumpFake', { athlete });
    return true;
  }

  trySteal(defender) {
    if (defender.stealCooldown > 0 || defender.actionLock > 0) return false;
    defender.stealCooldown = 0.75;
    defender.actionLock = 0.2;
    const carrier = this.ball.holder;
    if (!carrier || carrier.side === defender.side) return false;

    const d = dist2(defender.pos, carrier.pos);
    const ballD = this.ball.distanceTo(defender.pos.x, 0.25, defender.pos.z);
    const reachMax = defender.reach + 0.5;
    if (ballD > reachMax) return false;

    // The old formula SUBTRACTED ball security from steal timing, so two average
    // players cancelled out and every other term was a few per cent: measured,
    // a defender face to face at 0.6m succeeded 1.5% of the time, and 0% from
    // 1.2m. That is about seventy presses per steal - it existed on paper only.
    //
    // A steal is now a real, skill-shaped chance: best when you are right on the
    // ball and it is on your side of his body, better still if he has just
    // caught it or is swimming with it, and shaped by your timing against his
    // ball security rather than cancelled by it. A mistimed swipe still costs
    // you: you are left stranded for a moment, and the contact can be a foul.
    const timing = clamp01((defender.player.attr.stealTiming - 10) / 85);
    const security = clamp01((carrier.player.attr.ballSecurity - 10) / 85);
    const closeness = clamp01(1 - (ballD - 0.35) / Math.max(0.3, reachMax - 0.35));
    const exposure = clamp01(0.5 + (d - ballD) / 0.6);   // ball nearer you than his body is
    let p = 0.34 * closeness ** 1.6 * lerp(0.55, 1.2, exposure)
      * lerp(0.6, 1.25, timing) * lerp(1.3, 0.6, security);
    if (carrier.speed > 2.4) p += 0.05;
    if (carrier.justCaught > 0) p += 0.10;
    p = clamp(p * lerp(0.85, 1.1, defender.freshness), 0, 0.45);

    if (this.rng.chance(p)) {
      carrier.hasBall = false;
      carrier.stats.turnovers++;
      this.stats[carrier.side].turnovers++;
      defender.stats.steals++;
      this.stats[defender.side].steals++;
      this._giveBall(defender);
      this._applyShotClock(shotClockAfter(this.profile, POSSESSION_EVENT.GAIN));
      this._openTransition(defender.side);
      this._timeline(`Steal - #${defender.player.capNumber} ${defender.player.name}.`);
      this.bus.emit('steal', { defender, from: carrier });
      return true;
    }
    // A failed steal leaves the defender out of position - and often is a foul,
    // which the contact system will pick up on its own.
    defender.stunned = 0.25;
    return false;
  }

  /**
   * Deliberately foul the opponent you are marking (SPACE on defence).
   *
   * What it costs you is decided by where you are, exactly as in the real sport:
   * in front of your man it is an ordinary foul and simply stops the attack;
   * from behind him it is an exclusion and you leave the water for twenty
   * seconds. So the button is always "commit a foul", and your position decides
   * whether that was clever or expensive.
   */
  tryDeliberateFoul(defender) {
    if (!this.isLive() || !defender?.inPool || defender.actionLock > 0) return false;
    if (defender.foulCooldown > 0) return false;

    const opponents = this.activeAthletes(this.opponentSide(defender.side))
      .filter((o) => !o.isGoalkeeper);
    if (!opponents.length) return false;

    // The man you are marking: the carrier if he is within reach, else nearest.
    let victim = null, best = Infinity;
    for (const o of opponents) {
      const d = Math.hypot(o.pos.x - defender.pos.x, o.pos.z - defender.pos.z);
      const score = d - (o.hasBall ? 1.4 : 0);
      if (score < best) { best = score; victim = o; }
    }
    const reach = defender.reach + 1.2;
    if (!victim || Math.hypot(victim.pos.x - defender.pos.x, victim.pos.z - defender.pos.z) > reach) {
      return false;
    }

    // Behind him, or goalside of him? Measured against the direction HE attacks.
    const goalZ = victim.attackDir * (this.profile.field.length / 2);
    const gx = 0 - victim.pos.x, gz = goalZ - victim.pos.z;
    const glen = Math.hypot(gx, gz) || 1;
    const dx = defender.pos.x - victim.pos.x, dz = defender.pos.z - victim.pos.z;
    const dlen = Math.hypot(dx, dz) || 1;
    const goalside = ((gx / glen) * (dx / dlen) + (gz / glen) * (dz / dlen));

    const fromBehind = goalside < -0.25;
    defender.foulCooldown = 1.2;
    defender.actionLock = 0.28;

    this._awardFoul({
      type: fromBehind ? FOUL.EXCLUSION : FOUL.ORDINARY,
      reason: fromBehind
        ? 'holding and pulling an opponent back from behind'
        : 'holding an opponent while defending in front',
      offender: defender,
      victim,
      at: { x: victim.pos.x, z: victim.pos.z },
      deliberate: true,
    });
    return true;
  }

  tryBlock(defender) {
    if (defender.actionLock > 0) return false;
    defender.blockTimer = 0.55;
    // A block is a real volume: if the ball passes through the raised arm it
    // deflects. Resolved in _resolveBlocks each frame while blockTimer runs.
    return true;
  }

  _resolveBlocks(dt) {
    if (!this.ball.isLoose || this.ball.kind !== 'shot') return;
    for (const a of this.allActive()) {
      if (a.blockTimer <= 0 || a.side === this.ball.lastTouchSide) continue;
      const hand = a.handPoint();
      const reach = a.reach * (0.75 + 0.55 * a.armRaised) + a.elevation * 0.4;

      // You can only block a ball that is still coming AT you. The test was a
      // plain distance sphere, so an arm raised behind the shooter blocked a
      // shot that had already gone past it - which is not a block, it is the
      // ball hitting someone in the back of the hand on its way to goal.
      const toHandX = hand.x - this.ball.pos.x;
      const toHandZ = hand.z - this.ball.pos.z;
      // The arm has to be IN THE SHOT LANE and the ball still short of it - not
      // merely somewhere in the forward hemisphere, which let a defender off to
      // one side swat a ball that was passing them by.
      //
      // Measured against the ball's flight line, not as an angle to the ball: an
      // angular cone is ill-conditioned exactly when blocks happen, because the
      // ball->hand vector swings through 90 degrees as the ball passes close by
      // (measured 0.63 -> 0.24 -> -0.29 on three consecutive frames of a clean
      // block). Along-track distance and perpendicular offset stay stable.
      const ballSpeed = Math.hypot(this.ball.vel.x, this.ball.vel.z) || 1e-6;
      const vdx = this.ball.vel.x / ballSpeed;
      const vdz = this.ball.vel.z / ballSpeed;
      const along = toHandX * vdx + toHandZ * vdz;
      if (along <= 0) continue;                                    // ball is already past the arm
      const perp = Math.hypot(toHandX - along * vdx, toHandZ - along * vdz);
      if (perp > reach * 0.8) continue;                            // arm is not in the lane

      // And you cannot block facing away: the defender must be turned into the
      // incoming ball. Taken against the flight direction rather than the ball's
      // instantaneous position, for the same stability reason.
      if (-(Math.sin(a.shoulder) * vdx + Math.cos(a.shoulder) * vdz) <= 0) continue;

      if (this.ball.distanceTo(hand.x, hand.y + 0.25, hand.z) < reach) {
        // ONE swipe per defender per shot. This used to roll every frame for the
        // 0.55s the arm was up - about thirty rolls - so any defender within
        // reach blocked almost certainly, and 44% of all shots died on a
        // team-mate's arm rather than reaching the keeper.
        if (this.ball.blockTriedBy?.has(a.id)) continue;
        this.ball.blockTriedBy?.add(a.id);
        const timing = clamp01((a.player.attr.blockTiming - 10) / 85);
        if (this.rng.chance(0.12 + timing * 0.28)) {
          a.stats.blocks++;
          this.stats[a.side].blocks++;
          const s = this.ball.speed * 0.45;
          const ang = this.rng.range(0, Math.PI * 2);
          // A blocked ball must not be as likely to fly into your own net as
          // anywhere else. A uniformly random direction meant defenders blocking
          // near their own line regularly turned a save into an own goal:
          // measured, 5 of seed 777's 19 goals had no scorer at all and every
          // one of them came off a deflection. Blocks clear the ball away from
          // the goal being defended; it can still come off awkwardly, it just
          // isn't a coin flip.
          const ownGoalZ = -a.attackDir * (this.profile.field.length / 2);
          const outward = Math.sign(a.pos.z - ownGoalZ) || 1;
          let vz = Math.cos(ang) * s * 0.7;
          if (Math.sign(vz) !== outward) vz *= -0.35;
          this.ball.launch(
            { x: this.ball.pos.x, y: Math.max(0.25, this.ball.pos.y), z: this.ball.pos.z },
            { x: Math.sin(ang) * s * 0.7, y: s * 0.4 + 1.2, z: vz },
            { x: 0, y: 0, z: 0 }, 'deflection', a
          );
          this.presentation.saveFlash = 0.6;
          this._timeline(`Block - #${a.player.capNumber} ${a.player.name}.`);
          this.bus.emit('block', { athlete: a });
          return;
        }
      }
    }
  }

  /**
   * A substitution the manager asked for. Made now if the rules allow it, or
   * queued for the next stoppage if not (live play only allows flying swaps in
   * your own re-entry corner, which is not somewhere you can steer from a menu).
   */
  userSubstitution(side, outId, inId) {
    const out = this.active[side].find((a) => a.player.id === outId);
    const incoming = this.bench[side].find((a) => a.player.id === inId);
    if (!out || !incoming) return { ok: false, reason: 'unknown' };
    if (out.isGoalkeeper !== incoming.isGoalkeeper) return { ok: false, reason: 'goalkeeperForGoalkeeper' };
    if (incoming.excludedForMatch) return { ok: false, reason: 'excludedForMatch' };
    const r = this.requestSubstitution(side, out, incoming, 'user');
    if (r.ok) return { ok: true, when: 'now' };
    this.pendingSubs = (this.pendingSubs ?? []).filter((q) => q.outId !== outId && q.inId !== inId);
    this.pendingSubs.push({ side, outId, inId });
    return { ok: true, when: 'nextStoppage' };
  }

  _flushPendingSubs() {
    const queue = this.pendingSubs; this.pendingSubs = [];
    for (const q of queue) {
      const out = this.active[q.side].find((a) => a.player.id === q.outId);
      const incoming = this.bench[q.side].find((a) => a.player.id === q.inId);
      if (out && incoming) this.requestSubstitution(q.side, out, incoming, 'user');
    }
  }

  requestSubstitution(side, out, incoming, by = 'user') {
    const legal = substitutionLegal(this.profile, {
      state: this.state,
      enteringAt: out.pos,
      side,
      attackDir: this.attackDir[side],
      isGoalkeeper: incoming.isGoalkeeper,
      // The count once the outgoing player has LEFT, which is what the rule
      // expects. Passing the count before he left meant every outfield
      // substitution read as an eighth player - "squadFull" - so none ever
      // happened: measured, 0 of 134 AI substitutions went through, and tired
      // players never came off for either team in any mode.
      activeCount: this.activeCount(side) - (out?.inPool ? 1 : 0),
    });
    if (!legal.legal) {
      this.bus.emit('substitutionRejected', { side, reason: legal.reason });
      return { ok: false, reason: legal.reason };
    }
    this._doSubstitution(side, out, incoming, false);
    this.bus.emit('substitution', { side, out, in: incoming, reason: legal.reason, by });
    return { ok: true, reason: legal.reason };
  }

  _doSubstitution(side, out, incoming, forced) {
    const io = this.active[side].indexOf(out);
    const ib = this.bench[side].indexOf(incoming);
    if (io < 0 || ib < 0) return;
    this.active[side][io] = incoming;
    this.bench[side][ib] = out;

    incoming.attackDir = this.attackDir[side];
    incoming.inPool = true;
    const f = this.profile.field;
    incoming.pos.set(
      Math.sign(out.pos.x || 1) * (f.width / 2 - 0.5),
      -this.attackDir[side] * (f.length / 2 - f.restrictedLine)
    );
    incoming.vel.set(0, 0);
    incoming.heading = out.heading;
    incoming.shoulder = out.heading;

    if (out.hasBall) { out.hasBall = false; this.ball.holder = null; }
    out.inPool = false;
    if (out.isGoalkeeper && incoming.isGoalkeeper) {
      this.gkBrain[side] = new GoalkeeperBrain(incoming, side, this.rng.fork(side === 'home' ? 17 : 19));
    }
    if (this.userAthlete === out) this.userAthlete = incoming;
    this.roleDirty = true;
    this.stats[side].substitutions++;
    this._log('substitution', { side, out: out.id, in: incoming.id, forced });
    this._timeline(`Substitution ${this.teamOf(side).short}: #${incoming.player.capNumber} ${incoming.player.name} on for #${out.player.capNumber} ${out.player.name}.`);
  }

  /** Pull the goalkeeper for a seventh field player (section 16.4). */
  pullGoalkeeper(side) {
    const gk = this.goalkeeperFor(side);
    if (!gk) return { ok: false, reason: 'noGoalkeeper' };
    if (this.profile.squad.goalkeeperRequiredAtStart && this.state === MATCH_STATE.PERIOD_SETUP) {
      return { ok: false, reason: 'goalkeeperRequiredAtStart' };
    }
    const field = this.bench[side].find((b) => !b.isGoalkeeper && !b.excludedForMatch);
    if (!field) return { ok: false, reason: 'noFieldPlayerAvailable' };
    this._doSubstitution(side, gk, field, false);
    this.gkBrain[side] = null;
    this._timeline(`${this.teamOf(side).name} pull the goalkeeper.`);
    this._log('goalkeeperPulled', { side });
    return { ok: true };
  }

  callTimeout(side, by = 'user') {
    const check = timeoutEligible(this.profile, {
      possession: this.possession, side, state: this.state, timeoutsUsed: this.timeoutsUsed[side],
    });
    if (!check.allowed) return check;
    this.timeoutsUsed[side]++;
    this.clockRunning = false;
    this._setState(MATCH_STATE.TIMEOUT, 4);
    this._timeline(`Timeout - ${this.teamOf(side).name}.`);
    this._log('timeout', { side, by });
    this.bus.emit('timeout', { side });
    return { allowed: true };
  }

  requestChallenge(side) {
    if (!this.profile.review.coachChallenges) return { ok: false, reason: 'notSupported' };
    if (this.challengesUsed[side] >= this.profile.review.coachChallenges) return { ok: false, reason: 'noChallengesRemaining' };
    if (!this.lastGoal || this.clockNow - this.lastGoal.at > this.profile.review.challengeWindowSeconds) {
      return { ok: false, reason: 'windowClosed' };
    }
    this.challengesUsed[side]++;
    this._timeline(`${this.teamOf(side).name} challenge the decision. Video review...`);
    // The simulation is deterministic and the referee model already used full
    // information, so a challenge confirms unless the call was made with poor
    // visibility - which is exactly the case a review exists to correct.
    const overturn = (this.lastGoal.visibility ?? 1) < 0.5;
    this._log('coachChallenge', { side, overturn });
    return { ok: true, overturn };
  }

  // =========================================================================
  // User control helpers
  // =========================================================================

  /** Nearest teammate to the ball, used for automatic player switching. */
  autoSelectAthlete(side) {
    const list = this.activeAthletes(side).filter((a) => !a.isGoalkeeper);
    if (!list.length) return null;
    if (this.ball.holder && this.ball.holder.side === side) return this.ball.holder;
    return list.sort((a, b) =>
      this.ball.distanceTo(a.pos.x, 0.2, a.pos.z) - this.ball.distanceTo(b.pos.x, 0.2, b.pos.z))[0];
  }

  switchAthlete(side, direction = 1) {
    if (this.lockUserAthlete) return;  // you are locked to your own player
    const list = this.activeAthletes(side).filter((a) => !a.isGoalkeeper);
    if (!list.length) return;

    // SWITCH gives you the man nearest the ball. Press it again and you get the
    // next nearest - you pressed to get OUT of the one you had - and a third
    // press brings you back to the nearest. It used to walk the squad list in
    // roster order, so it handed you whoever happened to be next in the array,
    // wherever they were in the pool.
    const ball = this.ball;
    const dTo = (a) => ball.distanceTo(a.pos.x, 0.25, a.pos.z);
    const ranked = list.slice().sort((a, b) => dTo(a) - dTo(b));
    const next = ranked[0] === this.userAthlete ? (ranked[1] ?? ranked[0]) : ranked[0];
    this.setUserAthlete(next);
    this.manualSwitchCooldown = 1.2;  // let the manual pick stick for a moment
  }

  /**
   * Automatic control switching (EAFC style). On attack, control follows the ball
   * - you always drive the carrier, and the instant you pass, control jumps to the
   * player you passed to so you can meet your own pass. On defence, control snaps
   * to the teammate nearest the ball, with a little hysteresis so it does not
   * flicker between two equally close players. A manual switch is respected for a
   * short window, and goalkeeper control is never auto-overridden.
   */
  _autoSwitchControl(dt) {
    if (this.lockUserAthlete) return;  // Player Career locks control to your athlete
    if (!this.autoSwitch || !this.userControlsSide || this.userGkControl) return;
    this.manualSwitchCooldown = Math.max(0, this.manualSwitchCooldown - dt);
    const side = this.userControlsSide;
    const attacking = this.possession === side;
    const ball = this.ball;

    if (attacking) {
      // A deliberate switch sticks for its cooldown here too. Without this the
      // carrier-follow reclaimed control on the very next frame, so pressing
      // SWITCH while attacking did nothing at all.
      if (this.manualSwitchCooldown > 0) return;
      // Follow the carrier; while a pass is in the air, jump to the receiver.
      if (ball.holder && ball.holder.side === side && !ball.holder.isGoalkeeper) {
        if (this.userAthlete !== ball.holder) this.setUserAthlete(ball.holder);
      } else if (ball.isLoose && ball.kind === 'pass' && ball.intendedReceiver &&
                 ball.intendedReceiver.side === side && !ball.intendedReceiver.isGoalkeeper &&
                 ball.intendedReceiver.inPool) {
        if (this.userAthlete !== ball.intendedReceiver) this.setUserAthlete(ball.intendedReceiver);
      }
      return;
    }

    // Defending (or a loose ball we do not own): control the nearest defender.
    //
    // This is the single biggest thing that made the game feel uncontrollable.
    // Switching whenever someone was 0.6m closer, with no cooldown, handed the
    // player a different swimmer roughly once a second - measured at 103 switches
    // a match. You could never settle into anyone. A switch now needs a real
    // margin AND a minimum time on the current athlete, so control stays put
    // unless somebody else is clearly better placed.
    if (this.manualSwitchCooldown > 0) return;
    this.autoSwitchCooldown = Math.max(0, (this.autoSwitchCooldown ?? 0) - dt);
    const list = this.activeAthletes(side).filter((a) => !a.isGoalkeeper);
    if (!list.length) return;
    const dTo = (a) => ball.distanceTo(a.pos.x, 0.25, a.pos.z);
    let nearest = list[0];
    for (const a of list) if (dTo(a) < dTo(nearest)) nearest = a;
    const cur = this.userAthlete && list.includes(this.userAthlete) ? this.userAthlete : null;
    if (!cur) { this.setUserAthlete(nearest); this.autoSwitchCooldown = AUTO_SWITCH_HOLD; return; }

    // Switch when the BALL CARRIER changes, not whenever another defender drifts
    // marginally nearer. Continuous "nearest to the ball" switching moved your
    // control every time the attack shifted - measured, a quarter of all switches,
    // and one switch every three seconds overall - which is what made defending
    // feel chaotic: you never kept the same man long enough to do anything.
    const carrier = ball.holder && ball.holder.side !== side ? ball.holder : null;
    if (carrier && carrier !== this._lastOppCarrier) {
      this._lastOppCarrier = carrier;
      const toCarrier = (a) => Math.hypot(a.pos.x - carrier.pos.x, a.pos.z - carrier.pos.z);
      let best = list[0];
      for (const a of list) if (toCarrier(a) < toCarrier(best)) best = a;
      // ...and only if you are not already in the play. If your man is within a
      // few metres of the new carrier you keep him - hopping to whichever
      // defender is a metre closer on every catch was as jarring as before.
      if (best !== cur && toCarrier(cur) > 4 && toCarrier(best) < toCarrier(cur) - 1.5) {
        this.setUserAthlete(best);
        this.autoSwitchCooldown = AUTO_SWITCH_HOLD;
      }
      return;
    }
    // Otherwise only rescue you when you are genuinely out of the play.
    if (this.autoSwitchCooldown > 0) return;
    if (nearest !== cur && dTo(cur) > 8 && dTo(nearest) < dTo(cur) - AUTO_SWITCH_MARGIN * 2) {
      this.setUserAthlete(nearest);
      this.autoSwitchCooldown = AUTO_SWITCH_HOLD;
    }
  }

  setUserAthlete(a) {
    if (!a) return;
    this.userAthlete = a;
    this.userGkControl = a.isGoalkeeper;
    this.bus.emit('userAthleteChanged', { athlete: a });
  }

  toggleGoalkeeperControl() {
    const side = this.userControlsSide;
    if (this.userGkControl) {
      this.setUserAthlete(this.autoSelectAthlete(side));
    } else {
      const gk = this.goalkeeperFor(side);
      if (gk) this.setUserAthlete(gk);
    }
  }

  // =========================================================================
  // Bookkeeping
  // =========================================================================

  _setState(state, timer) {
    const prev = this.state;
    this.state = state;
    this.stateTimer = timer;
    this.bus.emit('stateChange', { from: prev, to: state });
    this._log('state', { from: prev, to: state, clock: +this.gameClock.toFixed(2), period: this.period });
  }

  _log(type, data) {
    // Spread data first so an event's own fields (e.g. a shot's shot-type) can
    // never overwrite the record's event `type`.
    this.record.push({ ...data, t: +this.clockNow.toFixed(3), type, seedCalls: this.rng.calls });
    if (this.record.length > 20000) this.record.splice(0, 5000);
  }

  _timeline(text) {
    this.timeline.push({
      text, period: this.period, clock: this.gameClock, at: this.clockNow,
      score: { ...this.score },
    });
    if (this.timeline.length > 200) this.timeline.shift();
    this.bus.emit('timeline', { text });
  }

  /** Post-match / live statistics package for the UI (section 29). */
  statsPackage() {
    const build = (side) => {
      const s = this.stats[side];
      const players = this.squads[side]
        .filter((a) => a.stats.timeInPool > 0.5 || a.stats.shots > 0)
        .map((a) => ({
          name: a.player.name, cap: a.player.capNumber, position: a.player.position,
          ...a.stats,
          distanceSwum: +a.distanceSwum.toFixed(1),
          sprintEfforts: a.sprintEfforts,
          fatigue: +(1 - a.freshness).toFixed(2),
          shootingPct: a.stats.shots ? Math.round((a.stats.goals / a.stats.shots) * 100) : 0,
        }))
        .sort((x, y) => y.goals - x.goals || y.shots - x.shots);
      return {
        team: this.teamOf(side),
        ...s,
        shootingPct: s.shots ? Math.round((s.goals / s.shots) * 100) : 0,
        savePct: (s.shotsFaced = this.stats[this.opponentSide(side)].shots) > 0
          ? Math.round((s.saves / Math.max(1, this.stats[this.opponentSide(side)].shots)) * 100) : 0,
        extraPlayerConversion: s.extraPlayerAttacks ? Math.round((s.extraPlayerGoals / s.extraPlayerAttacks) * 100) : 0,
        passCompletion: s.passesAttempted ? Math.round((s.passesCompleted / s.passesAttempted) * 100) : 0,
        possessionTime: Math.round(s.possessionTime),
        players,
      };
    };
    return { home: build('home'), away: build('away'), score: { ...this.score }, timeline: this.timeline.slice(-40) };
  }

  /** Serialise for save/load (section 40.1: save system). */
  serialise() {
    return {
      version: 2,
      seed: this.seed,
      profileId: this.profile.id,
      home: this.homeTeam.id,
      away: this.awayTeam.id,
      period: this.period,
      gameClock: this.gameClock,
      shotClock: this.shotClock,
      score: { ...this.score },
      state: this.state,
      possession: this.possession,
      timeoutsUsed: { ...this.timeoutsUsed },
      stats: structuredClone(this.stats),
      timeline: this.timeline.slice(-60),
      athletes: [...this.squads.home, ...this.squads.away].map((a) => ({
        id: a.id, x: a.pos.x, z: a.pos.z, heading: a.heading,
        burst: a.burst, pool: a.pool, matchFatigue: a.matchFatigue,
        personalFouls: a.personalFouls, inPool: a.inPool,
        excludedForMatch: a.excludedForMatch, stats: a.stats,
      })),
      exclusions: this.exclusions.map((e) => ({ id: e.athlete.id, remaining: e.remaining, forMatch: e.forMatch })),
      recordLength: this.record.length,
    };
  }

  restore(data) {
    if (data.version !== 2) throw new Error('Unsupported save version');
    this.period = data.period;
    this.gameClock = data.gameClock;
    this.shotClock = data.shotClock;
    this.score = { ...data.score };
    this.possession = data.possession;
    this.timeoutsUsed = { ...data.timeoutsUsed };
    this.stats = structuredClone(data.stats);
    this.timeline = data.timeline ?? [];
    const byId = new Map([...this.squads.home, ...this.squads.away].map((a) => [a.id, a]));
    for (const s of data.athletes) {
      const a = byId.get(s.id);
      if (!a) continue;
      a.pos.set(s.x, s.z);
      a.heading = s.heading; a.shoulder = s.heading;
      a.burst = s.burst; a.pool = s.pool; a.matchFatigue = s.matchFatigue;
      a.personalFouls = s.personalFouls; a.inPool = s.inPool;
      a.excludedForMatch = s.excludedForMatch;
      a.stats = s.stats;
    }
    this.active.home = this.squads.home.filter((a) => a.inPool).slice(0, this.profile.squad.activePlayers);
    this.active.away = this.squads.away.filter((a) => a.inPool).slice(0, this.profile.squad.activePlayers);
    this.bench.home = this.squads.home.filter((a) => !this.active.home.includes(a));
    this.bench.away = this.squads.away.filter((a) => !this.active.away.includes(a));
    this.exclusions = (data.exclusions ?? []).map((e) => ({
      athlete: byId.get(e.id), side: byId.get(e.id)?.side, remaining: e.remaining, forMatch: e.forMatch,
    })).filter((e) => e.athlete);
    this._setState(data.state, 0);
    this.roleDirty = true;
  }
}

function freshTeamStats() {
  return {
    goals: 0, assists: 0, shots: 0, shotsOnGoal: 0, saves: 0, blocks: 0, steals: 0,
    turnovers: 0, ordinaryFouls: 0, exclusionsDrawn: 0, exclusionsConceded: 0,
    penaltiesDrawn: 0, penaltiesConceded: 0, extraPlayerAttacks: 0, extraPlayerGoals: 0,
    extraPlayerShots: 0, manDownStops: 0, centreEntries: 0, centreTouches: 0,
    counterGoals: 0, counterOpportunities: 0, possessionTime: 0, passesAttempted: 0,
    passesCompleted: 0, reboundsControlled: 0, substitutions: 0,
  };
}

export function emptyCommand() {
  return { dir: null, effort: 0, rise: 0, face: null, brace: false, saveAim: null };
}
