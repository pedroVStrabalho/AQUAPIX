/**
 * Rules engine: pure decision functions over a rules profile.
 * Design Bible sections 7.1 - 7.4.
 *
 * Nothing in this file touches rendering, input or the scene graph. Every
 * function is a pure mapping from (profile, situation) to a decision, which is
 * what makes the automated rules tests in /tests possible and what allows the
 * whole rule set to be swapped for a different competition profile at runtime.
 */

import { clamp } from '../core/Math2.js';

export const MATCH_STATE = {
  PRE_MATCH: 'preMatch',
  TEAM_SETUP: 'teamSetup',
  PERIOD_SETUP: 'periodSetup',
  SWIM_OFF: 'swimOff',
  LIVE: 'live',
  LOOSE_BALL: 'looseBall',
  ORDINARY_FOUL: 'ordinaryFoul',
  EXCLUSION_FOUL: 'exclusionFoul',
  PENALTY_FOUL: 'penaltyFoul',
  GOAL: 'goal',
  GOAL_REVIEW: 'goalReview',
  TIMEOUT: 'timeout',
  INJURY: 'injury',
  CAP_REPLACEMENT: 'capReplacement',
  NEUTRAL_THROW: 'neutralThrow',
  PERIOD_END: 'periodEnd',
  INTERVAL: 'interval',
  MATCH_END: 'matchEnd',
  SHOOTOUT: 'shootout',
  ABANDONED: 'abandoned',
  REVIEW_CORRECTION: 'reviewCorrection',
};

export const POSSESSION_EVENT = {
  GAIN: 'gain',                 // new team wins the ball
  SHOT_SAVED_TO_ATTACK: 'savedRebound',
  SHOT_OFF_POST: 'postRebound',
  EXCLUSION_AWARDED: 'exclusionAwarded',
  ORDINARY_FOUL: 'ordinaryFoul',
  CORNER: 'corner',
  GOAL_THROW: 'goalThrow',
  GOAL: 'goal',
  NEUTRAL: 'neutral',
  PENALTY: 'penalty',
};

/**
 * Possession clock after an event (section 7.2: 28 seconds normally, 18 in the
 * applicable secondary situations). Returns `null` when the clock should keep
 * running unchanged.
 */
export function shotClockAfter(profile, event, ctx = {}) {
  const t = profile.timing;
  switch (event) {
    case POSSESSION_EVENT.GAIN:
    case POSSESSION_EVENT.GOAL:
    case POSSESSION_EVENT.NEUTRAL:
      return { value: t.normalPossession, secondary: false };

    case POSSESSION_EVENT.ORDINARY_FOUL:
      // A free throw to the team already in possession does not reset the clock.
      return ctx.sameTeam ? null : { value: t.normalPossession, secondary: false };

    case POSSESSION_EVENT.EXCLUSION_AWARDED:
      // Retained possession after an exclusion: the shorter secondary period.
      return { value: t.secondaryPossession, secondary: true };

    case POSSESSION_EVENT.SHOT_SAVED_TO_ATTACK:
    case POSSESSION_EVENT.SHOT_OFF_POST:
      // Attacking team recovers its own shot: secondary possession.
      return { value: Math.max(t.secondaryPossession, ctx.remaining ?? 0), secondary: true };

    case POSSESSION_EVENT.CORNER:
      return { value: t.secondaryPossession, secondary: true };

    case POSSESSION_EVENT.GOAL_THROW:
      return { value: t.normalPossession, secondary: false };

    case POSSESSION_EVENT.PENALTY:
      return { value: t.normalPossession, secondary: false };

    default:
      return null;
  }
}

/**
 * Where a free throw is taken from, and whether a direct shot is legal
 * (section 7.2: six-metre-area privileges and restrictions).
 */
export function freeThrowSpot(profile, foulAt, attackDir) {
  const f = profile.field;
  const goalZ = attackDir * (f.length / 2);
  const distToGoal = Math.abs(goalZ - foulAt.z);

  // A foul inside the attacking six-metre area is taken on the six-metre line.
  let z = foulAt.z;
  if (distToGoal < f.frontCourtLine) z = goalZ - attackDir * f.frontCourtLine;

  const x = clamp(foulAt.x, -f.width / 2 + 0.4, f.width / 2 - 0.4);
  const spot = { x, z };
  const directShot = Math.abs(goalZ - z) >= profile.restarts.directShotOutside - 0.05;
  return { spot, directShot };
}

/**
 * Corner throw versus goal throw when the ball leaves over a goal line
 * (section 7.4: "correct corner and goal-throw decisions").
 */
export function endLineRestart(profile, lastTouchSide, defendingSide, crossedAtX) {
  if (lastTouchSide === defendingSide) {
    const f = profile.field;
    return {
      kind: 'corner',
      side: lastTouchSide === 'home' ? 'away' : 'home',
      spot: {
        x: Math.sign(crossedAtX || 1) * (f.width / 2 - 0.5),
        z: 0, // filled by the caller with the two-metre line on the correct end
      },
      event: POSSESSION_EVENT.CORNER,
    };
  }
  return {
    kind: 'goalThrow',
    side: defendingSide,
    spot: null,
    event: POSSESSION_EVENT.GOAL_THROW,
  };
}

/**
 * Exclusion bookkeeping. Returns the updated exclusion or null when the player
 * may re-enter (section 7.2: 18 seconds, with earlier re-entry when permitted).
 */
export function exclusionTick(profile, exclusion, dt, events = {}) {
  const next = { ...exclusion, remaining: exclusion.remaining - dt };
  if (next.remaining <= 0) return { done: true, reason: 'timeExpired', exclusion: next };
  if (!profile.discipline.exclusionEarlyReentry) return { done: false, exclusion: next };
  if (events.goalScored) return { done: true, reason: 'goalScored', exclusion: next };
  if (events.possessionRegained === exclusion.side) return { done: true, reason: 'possessionRegained', exclusion: next };
  return { done: false, exclusion: next };
}

/**
 * Personal-foul accounting. The third personal foul removes the athlete for the
 * remainder of the match with substitution permitted (section 7.4).
 */
export function personalFoulResult(profile, currentCount) {
  const next = currentCount + 1;
  const limitReached = next >= profile.discipline.personalFoulLimit;
  return {
    count: next,
    excludedForMatch: limitReached,
    substituteAllowed: limitReached && profile.discipline.substituteAfterThirdFoul,
    warning: next === profile.discipline.personalFoulLimit - 1,
  };
}

/** Is a team allowed to call a timeout right now? (section 7.4) */
export function timeoutEligible(profile, { possession, side, state, timeoutsUsed }) {
  if (timeoutsUsed >= profile.timing.timeoutsPerTeam) return { allowed: false, reason: 'noTimeoutsRemaining' };
  if (state === MATCH_STATE.MATCH_END || state === MATCH_STATE.INTERVAL) return { allowed: false, reason: 'notInPlay' };
  if (state === MATCH_STATE.PENALTY_FOUL) return { allowed: false, reason: 'penaltyPending' };
  if (possession !== side) return { allowed: false, reason: 'notInPossession' };
  return { allowed: true };
}

/** Period transitions: which interval follows, and is the match over? */
export function periodTransition(profile, period, score) {
  const last = period >= profile.timing.periods;
  if (!last) {
    const interval = period === profile.timing.periods / 2
      ? profile.timing.halftimeSeconds
      : profile.timing.intervalSeconds;
    return { matchOver: false, nextPeriod: period + 1, intervalSeconds: interval };
  }
  const drawn = score.home === score.away;
  return {
    matchOver: true,
    drawn,
    needsShootout: drawn && profile.shootout.enabled,
  };
}

/**
 * Shootout order and completion. Teams alternate; after the initial round of
 * five each, sudden death continues in pairs (section 7.4: "correct shootout
 * order").
 */
export function shootoutState(profile, attempts) {
  const n = profile.shootout.shootersPerTeam;
  const home = attempts.filter((a) => a.side === 'home');
  const away = attempts.filter((a) => a.side === 'away');
  const hScore = home.filter((a) => a.scored).length;
  const aScore = away.filter((a) => a.scored).length;

  const nextSide = home.length <= away.length ? 'home' : 'away';
  const inRegulation = home.length < n || away.length < n;

  if (inRegulation) {
    // Early decision: can the trailing team still catch up?
    const hRemaining = n - home.length;
    const aRemaining = n - away.length;
    if (hScore > aScore + aRemaining) return { finished: true, winner: 'home', hScore, aScore };
    if (aScore > hScore + hRemaining) return { finished: true, winner: 'away', hScore, aScore };
    return { finished: false, nextSide, hScore, aScore, suddenDeath: false };
  }

  if (home.length === away.length) {
    if (hScore !== aScore) return { finished: true, winner: hScore > aScore ? 'home' : 'away', hScore, aScore };
    if (!profile.shootout.suddenDeath) return { finished: true, winner: null, hScore, aScore };
  }
  return { finished: false, nextSide, hScore, aScore, suddenDeath: true };
}

/**
 * Simultaneous fouls by both teams (section 7.4). Water polo resolves these with
 * a neutral throw unless one offence is materially more serious.
 */
export function resolveSimultaneousFouls(foulA, foulB) {
  const rank = { none: 0, ordinary: 1, exclusion: 2, penalty: 3, brutality: 4 };
  const ra = rank[foulA.type] ?? 0;
  const rb = rank[foulB.type] ?? 0;
  if (ra === rb) return { decision: 'neutralThrow', apply: [foulA, foulB].filter((f) => rank[f.type] >= 2) };
  return { decision: 'single', apply: [ra > rb ? foulA : foulB] };
}

/**
 * Apply a video-review reversal. Returns the corrected match delta so that the
 * caller can restore time, possession, score and statistics exactly
 * (section 22.3).
 */
export function applyReviewDecision(snapshot, decision) {
  if (decision === 'confirm') return { changed: false, snapshot };
  const s = structuredClone(snapshot);
  switch (snapshot.reviewType) {
    case 'goal':
      if (s.goalAwarded) {
        s.score[s.scoringSide] -= 1;
        s.goalAwarded = false;
        s.possession = s.defendingSide;
        s.restart = 'goalThrow';
      } else {
        s.score[s.scoringSide] += 1;
        s.goalAwarded = true;
        s.possession = s.defendingSide;
        s.restart = 'centre';
      }
      break;
    case 'penalty':
      s.penaltyAwarded = !s.penaltyAwarded;
      break;
    case 'clock':
      s.gameClock = s.correctedClock ?? s.gameClock;
      break;
    default:
      break;
  }
  s.reviewed = true;
  return { changed: true, snapshot: s };
}

/** Legal substitution check, including flying substitutions (section 17.3). */
export function substitutionLegal(profile, { state, enteringAt, side, attackDir, isGoalkeeper, activeCount }) {
  if (activeCount >= profile.squad.activePlayers && !isGoalkeeper) {
    return { legal: false, reason: 'squadFull' };
  }
  const stoppage = state !== MATCH_STATE.LIVE && state !== MATCH_STATE.LOOSE_BALL;
  if (stoppage) return { legal: true, reason: 'duringStoppage' };
  if (!profile.substitution.flying) return { legal: false, reason: 'flyingSubstitutionsNotPermitted' };

  // Flying substitutions must happen in the team's own re-entry area: the corner
  // of the pool by their own goal line.
  const f = profile.field;
  const ownGoalZ = -attackDir * (f.length / 2);
  const inZone = Math.abs(enteringAt.z - ownGoalZ) <= profile.substitution.reentryZoneLength + 0.5;
  return inZone
    ? { legal: true, reason: 'flyingSubstitution' }
    : { legal: false, reason: 'outsideReentryArea' };
}

/** Human-readable explanation of a call for the HUD (section 15.6). */
export function explainFoul(profile, foul) {
  const base = {
    ordinary: 'Ordinary foul - free throw awarded.',
    exclusion: `Exclusion - ${profile.timing.exclusionSeconds}s, or until a goal or change of possession.`,
    penalty: `Penalty throw from ${profile.field.penaltyLine} metres.`,
    brutality: `Brutality - ${profile.discipline.brutalityExclusionSeconds}s exclusion with substitution.`,
  }[foul.type] ?? '';
  return {
    headline: base,
    offender: foul.offender ? `#${foul.offender.player.capNumber} ${foul.offender.player.name}` : '',
    reason: foul.reason,
    location: `${foul.at.z.toFixed(1)}m / ${foul.at.x.toFixed(1)}m`,
    personalFouls: foul.offender ? foul.offender.personalFouls : 0,
    limit: profile.discipline.personalFoulLimit,
  };
}
