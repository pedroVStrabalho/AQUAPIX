/**
 * Automated rules tests (Design Bible section 7.4).
 *
 * Covers the full list the brief asks for: possession-clock resets, exclusion
 * re-entry conditions, restart after a goal, restart after an exclusion, corner
 * and goal-throw decisions, penalty positioning, goalkeeper removal, third
 * personal foul handling, substitutions, period transitions, timeout
 * eligibility, shootout order, simultaneous fouls and video-review reversal.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORLD_AQUATICS_2026 as WA, YOUTH_U16, getProfile, PROFILES,
} from '../src/rules/RuleProfiles.js';
import {
  MATCH_STATE, POSSESSION_EVENT, shotClockAfter, freeThrowSpot, endLineRestart,
  exclusionTick, personalFoulResult, timeoutEligible, periodTransition,
  shootoutState, substitutionLegal, resolveSimultaneousFouls, applyReviewDecision,
  explainFoul,
} from '../src/rules/RulesEngine.js';

// ---------------------------------------------------------------------------
test('the 2026 baseline profile carries the correct regulation values', () => {
  assert.equal(WA.field.length, 25);
  assert.equal(WA.field.width, 20);
  assert.equal(WA.squad.activePlayers, 7);
  assert.equal(WA.squad.maxRoster, 14);
  assert.equal(WA.timing.periods, 4);
  assert.equal(WA.timing.periodSeconds, 8 * 60);
  assert.equal(WA.timing.normalPossession, 28);
  assert.equal(WA.timing.secondaryPossession, 18);
  assert.equal(WA.timing.exclusionSeconds, 18);
  assert.equal(WA.field.penaltyLine, 5);
  assert.equal(WA.discipline.personalFoulLimit, 3);
  assert.equal(WA.squad.goalkeeperRequiredAtStart, true);
  assert.equal(WA.squad.minGoalkeepers, 0, 'the goalkeeper may be removed once play has begun');
  assert.equal(WA.substitution.flying, true);
});

test('profiles are independent copies, so editing one never leaks into another', () => {
  const a = getProfile('wa-2026');
  const b = getProfile('youth-u16');
  assert.notEqual(a.timing, b.timing);
  assert.equal(b.field.length, 20);
  assert.equal(a.field.length, 25, 'the youth profile must not have mutated the baseline');
  assert.equal(b.timing.exclusionSeconds, 20);
  assert.equal(a.timing.exclusionSeconds, 18);
});

// --------------------------------------------------- possession clock ------
test('possession clock resets correctly for each event', () => {
  assert.deepEqual(shotClockAfter(WA, POSSESSION_EVENT.GAIN), { value: 28, secondary: false });
  assert.deepEqual(shotClockAfter(WA, POSSESSION_EVENT.GOAL), { value: 28, secondary: false });
  assert.deepEqual(shotClockAfter(WA, POSSESSION_EVENT.EXCLUSION_AWARDED), { value: 18, secondary: true });
  assert.deepEqual(shotClockAfter(WA, POSSESSION_EVENT.CORNER), { value: 18, secondary: true });
  assert.deepEqual(shotClockAfter(WA, POSSESSION_EVENT.GOAL_THROW), { value: 28, secondary: false });
});

test('a free throw to the team already in possession does not reset the clock', () => {
  assert.equal(shotClockAfter(WA, POSSESSION_EVENT.ORDINARY_FOUL, { sameTeam: true }), null);
  assert.deepEqual(
    shotClockAfter(WA, POSSESSION_EVENT.ORDINARY_FOUL, { sameTeam: false }),
    { value: 28, secondary: false }
  );
});

test('the attacking team recovering its own shot gets secondary possession, never less time', () => {
  const r = shotClockAfter(WA, POSSESSION_EVENT.SHOT_SAVED_TO_ATTACK, { remaining: 24 });
  assert.equal(r.secondary, true);
  assert.equal(r.value, 24, 'a team must not lose time it already had');
  const r2 = shotClockAfter(WA, POSSESSION_EVENT.SHOT_OFF_POST, { remaining: 3 });
  assert.equal(r2.value, 18);
});

// ----------------------------------------------------------- free throws ---
test('a foul inside the attacking six-metre area is taken on the six-metre line', () => {
  // Attacking toward +z; the goal line is at +12.5. A foul 2 m out sits at 10.5.
  const { spot, directShot } = freeThrowSpot(WA, { x: 1.2, z: 10.5 }, 1);
  assert.equal(spot.z, 12.5 - 6, 'moved out to the six-metre line');
  assert.equal(spot.x, 1.2, 'the lateral position is preserved');
  assert.equal(directShot, true, 'on the six-metre line a direct shot is permitted');
});

test('a foul outside six metres is taken where it happened and may be shot directly', () => {
  const { spot, directShot } = freeThrowSpot(WA, { x: -3, z: 4 }, 1);
  assert.equal(spot.z, 4);
  assert.equal(directShot, true);
});

test('a free throw is clamped inside the field of play', () => {
  const { spot } = freeThrowSpot(WA, { x: 40, z: 3 }, 1);
  assert.ok(spot.x <= WA.field.width / 2, 'never outside the side wall');
});

test('the same foul at the other end mirrors correctly', () => {
  const { spot } = freeThrowSpot(WA, { x: 0, z: -10.5 }, -1);
  assert.equal(spot.z, -(12.5 - 6));
});

// -------------------------------------------------- corner vs goal throw ---
test('the defending team putting the ball out concedes a corner', () => {
  const r = endLineRestart(WA, 'home', 'home', 4.2);
  assert.equal(r.kind, 'corner');
  assert.equal(r.side, 'away');
  assert.equal(r.event, POSSESSION_EVENT.CORNER);
  assert.ok(r.spot.x > 0, 'taken on the side the ball went out');
});

test('the attacking team putting the ball out concedes a goal throw', () => {
  const r = endLineRestart(WA, 'away', 'home', -3);
  assert.equal(r.kind, 'goalThrow');
  assert.equal(r.side, 'home');
  assert.equal(r.event, POSSESSION_EVENT.GOAL_THROW);
});

// ------------------------------------------------------------ exclusions ---
test('an exclusion expires after the profile duration', () => {
  let ex = { side: 'home', remaining: WA.timing.exclusionSeconds };
  for (let i = 0; i < 17; i++) {
    const r = exclusionTick(WA, ex, 1, {});
    assert.equal(r.done, false, `still excluded at ${i + 1}s`);
    ex = r.exclusion;
  }
  const last = exclusionTick(WA, ex, 1.1, {});
  assert.equal(last.done, true);
  assert.equal(last.reason, 'timeExpired');
});

test('an excluded player re-enters early on a goal', () => {
  const r = exclusionTick(WA, { side: 'home', remaining: 12 }, 0.1, { goalScored: true });
  assert.equal(r.done, true);
  assert.equal(r.reason, 'goalScored');
});

test('an excluded player re-enters early when their own team regains possession', () => {
  const r = exclusionTick(WA, { side: 'home', remaining: 12 }, 0.1, { possessionRegained: 'home' });
  assert.equal(r.done, true);
  assert.equal(r.reason, 'possessionRegained');

  const r2 = exclusionTick(WA, { side: 'home', remaining: 12 }, 0.1, { possessionRegained: 'away' });
  assert.equal(r2.done, false, 'the opponent regaining possession does not free the excluded player');
});

test('a profile without early re-entry keeps the player out for the full period', () => {
  const strict = { ...WA, discipline: { ...WA.discipline, exclusionEarlyReentry: false } };
  const r = exclusionTick(strict, { side: 'home', remaining: 12 }, 0.1, { goalScored: true });
  assert.equal(r.done, false);
});

// -------------------------------------------------------- personal fouls ---
test('the third personal foul removes the athlete for the match with a substitute', () => {
  let count = 0;
  let r = personalFoulResult(WA, count);
  assert.equal(r.count, 1);
  assert.equal(r.excludedForMatch, false);

  r = personalFoulResult(WA, r.count);
  assert.equal(r.count, 2);
  assert.equal(r.warning, true, 'two fouls is the warning state');
  assert.equal(r.excludedForMatch, false);

  r = personalFoulResult(WA, r.count);
  assert.equal(r.count, 3);
  assert.equal(r.excludedForMatch, true);
  assert.equal(r.substituteAllowed, true);
});

// ------------------------------------------------------------- timeouts ---
test('a timeout is only available to the team in possession with one remaining', () => {
  const base = { possession: 'home', side: 'home', state: MATCH_STATE.LIVE, timeoutsUsed: 0 };
  assert.equal(timeoutEligible(WA, base).allowed, true);
  assert.equal(timeoutEligible(WA, { ...base, possession: 'away' }).allowed, false);
  assert.equal(timeoutEligible(WA, { ...base, timeoutsUsed: 2 }).allowed, false);
  assert.equal(timeoutEligible(WA, { ...base, state: MATCH_STATE.PENALTY_FOUL }).allowed, false);
  assert.equal(timeoutEligible(WA, { ...base, state: MATCH_STATE.INTERVAL }).allowed, false);
});

// -------------------------------------------------------------- periods ---
test('period transitions produce the right interval and the right end of match', () => {
  const t1 = periodTransition(WA, 1, { home: 3, away: 2 });
  assert.equal(t1.matchOver, false);
  assert.equal(t1.nextPeriod, 2);
  assert.equal(t1.intervalSeconds, 120);

  const t2 = periodTransition(WA, 2, { home: 5, away: 5 });
  assert.equal(t2.intervalSeconds, 300, 'half time is the long interval');

  const t3 = periodTransition(WA, 3, { home: 8, away: 7 });
  assert.equal(t3.intervalSeconds, 120);

  const t4 = periodTransition(WA, 4, { home: 9, away: 8 });
  assert.equal(t4.matchOver, true);
  assert.equal(t4.drawn, false);
  assert.equal(t4.needsShootout, false);

  const drawn = periodTransition(WA, 4, { home: 9, away: 9 });
  assert.equal(drawn.matchOver, true);
  assert.equal(drawn.drawn, true);
  assert.equal(drawn.needsShootout, true);
});

// -------------------------------------------------------------- shootout ---
test('the shootout alternates teams and starts with the home team', () => {
  const s = shootoutState(WA, []);
  assert.equal(s.nextSide, 'home');
  const s2 = shootoutState(WA, [{ side: 'home', scored: true }]);
  assert.equal(s2.nextSide, 'away');
});

test('a shootout ends as soon as it cannot be caught', () => {
  // Home 2/3, away 1/3. Away has two attempts left and can still reach three,
  // so the contest is live.
  const attempts = [
    { side: 'home', scored: true }, { side: 'away', scored: true },
    { side: 'home', scored: true }, { side: 'away', scored: false },
    { side: 'home', scored: false }, { side: 'away', scored: false },
  ];
  assert.equal(shootoutState(WA, attempts).finished, false);

  // Home 3/4, away 1/4. Away can now only reach two: it is over.
  attempts.push({ side: 'home', scored: true }, { side: 'away', scored: false });
  const done = shootoutState(WA, attempts);
  assert.equal(done.finished, true, 'the trailing team can no longer catch up');
  assert.equal(done.winner, 'home');
  assert.equal(done.hScore, 3);
  assert.equal(done.aScore, 1);
});

test('a level shootout after five each goes to sudden death', () => {
  const attempts = [];
  for (let i = 0; i < 5; i++) {
    attempts.push({ side: 'home', scored: i < 3 });
    attempts.push({ side: 'away', scored: i < 3 });
  }
  const s = shootoutState(WA, attempts);
  assert.equal(s.finished, false);
  assert.equal(s.suddenDeath, true);
  assert.equal(s.nextSide, 'home');

  attempts.push({ side: 'home', scored: true }, { side: 'away', scored: false });
  const done = shootoutState(WA, attempts);
  assert.equal(done.finished, true);
  assert.equal(done.winner, 'home');
});

// --------------------------------------------------------- substitutions ---
test('flying substitutions are legal only in the team own re-entry area', () => {
  // Home attacks +z, so its own goal line is at -12.5 and the re-entry area is
  // the two metres in front of it.
  const inZone = substitutionLegal(WA, {
    state: MATCH_STATE.LIVE, enteringAt: { x: 9, z: -11.5 }, side: 'home',
    attackDir: 1, isGoalkeeper: false, activeCount: 6,
  });
  assert.equal(inZone.legal, true);
  assert.equal(inZone.reason, 'flyingSubstitution');

  const outOfZone = substitutionLegal(WA, {
    state: MATCH_STATE.LIVE, enteringAt: { x: 0, z: 4 }, side: 'home',
    attackDir: 1, isGoalkeeper: false, activeCount: 6,
  });
  assert.equal(outOfZone.legal, false);
  assert.equal(outOfZone.reason, 'outsideReentryArea');
});

test('substitutions during a stoppage are always legal, and a full squad is refused', () => {
  const stoppage = substitutionLegal(WA, {
    state: MATCH_STATE.ORDINARY_FOUL, enteringAt: { x: 0, z: 4 }, side: 'home',
    attackDir: 1, isGoalkeeper: false, activeCount: 6,
  });
  assert.equal(stoppage.legal, true);

  const full = substitutionLegal(WA, {
    state: MATCH_STATE.LIVE, enteringAt: { x: 9, z: -11.5 }, side: 'home',
    attackDir: 1, isGoalkeeper: false, activeCount: 7,
  });
  assert.equal(full.legal, false);
  assert.equal(full.reason, 'squadFull');
});

test('a profile that forbids flying substitutions refuses them during live play', () => {
  const noFly = { ...WA, substitution: { ...WA.substitution, flying: false } };
  const r = substitutionLegal(noFly, {
    state: MATCH_STATE.LIVE, enteringAt: { x: 9, z: -11.5 }, side: 'home',
    attackDir: 1, isGoalkeeper: false, activeCount: 6,
  });
  assert.equal(r.legal, false);
  assert.equal(r.reason, 'flyingSubstitutionsNotPermitted');
});

// ---------------------------------------------------- simultaneous fouls ---
test('simultaneous fouls of equal weight produce a neutral throw', () => {
  const r = resolveSimultaneousFouls({ type: 'ordinary' }, { type: 'ordinary' });
  assert.equal(r.decision, 'neutralThrow');
  assert.equal(r.apply.length, 0, 'neither ordinary foul is recorded against a player');
});

test('simultaneous exclusions are both recorded and still restart neutrally', () => {
  const r = resolveSimultaneousFouls({ type: 'exclusion' }, { type: 'exclusion' });
  assert.equal(r.decision, 'neutralThrow');
  assert.equal(r.apply.length, 2, 'both athletes serve their exclusion');
});

test('the more serious of two simultaneous fouls is the one applied', () => {
  const r = resolveSimultaneousFouls({ type: 'ordinary', id: 'a' }, { type: 'penalty', id: 'b' });
  assert.equal(r.decision, 'single');
  assert.equal(r.apply[0].id, 'b');
});

// -------------------------------------------------------- video review ----
test('confirming a review changes nothing', () => {
  const snap = { reviewType: 'goal', goalAwarded: true, score: { home: 5, away: 4 }, scoringSide: 'home', defendingSide: 'away' };
  const r = applyReviewDecision(snap, 'confirm');
  assert.equal(r.changed, false);
  assert.equal(r.snapshot.score.home, 5);
});

test('overturning an awarded goal removes it and restores possession correctly', () => {
  const snap = { reviewType: 'goal', goalAwarded: true, score: { home: 5, away: 4 }, scoringSide: 'home', defendingSide: 'away' };
  const r = applyReviewDecision(snap, 'overturn');
  assert.equal(r.changed, true);
  assert.equal(r.snapshot.score.home, 4);
  assert.equal(r.snapshot.goalAwarded, false);
  assert.equal(r.snapshot.possession, 'away');
  assert.equal(r.snapshot.restart, 'goalThrow');
  assert.equal(snap.score.home, 5, 'the original snapshot is not mutated');
});

test('overturning a disallowed goal awards it and restarts from the centre', () => {
  const snap = { reviewType: 'goal', goalAwarded: false, score: { home: 5, away: 4 }, scoringSide: 'home', defendingSide: 'away' };
  const r = applyReviewDecision(snap, 'overturn');
  assert.equal(r.snapshot.score.home, 6);
  assert.equal(r.snapshot.restart, 'centre');
});

test('a clock review restores the corrected time', () => {
  const snap = { reviewType: 'clock', gameClock: 12.4, correctedClock: 14.1 };
  const r = applyReviewDecision(snap, 'overturn');
  assert.equal(r.snapshot.gameClock, 14.1);
});

// ------------------------------------------------------------ explanation --
test('a call explanation tells the user everything section 15.6 requires', () => {
  const foul = {
    type: 'exclusion',
    reason: 'holding and pulling back an opponent not holding the ball',
    offender: { player: { capNumber: 4, name: 'Test Athlete' }, personalFouls: 2 },
    at: { x: -2.4, z: 8.1 },
  };
  const e = explainFoul(WA, foul);
  assert.match(e.headline, /Exclusion/);
  assert.match(e.headline, /18s/, 'the exclusion length comes from the active profile');
  assert.match(e.offender, /#4 Test Athlete/);
  assert.equal(e.reason, foul.reason);
  assert.match(e.location, /8\.1m/);
  assert.equal(e.personalFouls, 2);
  assert.equal(e.limit, 3);
});

test('the youth profile reports its own exclusion length in the explanation', () => {
  const foul = {
    type: 'exclusion', reason: 'holding', at: { x: 0, z: 0 },
    offender: { player: { capNumber: 2, name: 'A' }, personalFouls: 1 },
  };
  assert.match(explainFoul(YOUTH_U16, foul).headline, /20s/);
});

test('every registered profile is internally consistent', () => {
  for (const [id, p] of Object.entries(PROFILES)) {
    assert.equal(p.id, id);
    assert.ok(p.timing.secondaryPossession <= p.timing.normalPossession, `${id}: secondary must not exceed normal`);
    assert.ok(p.field.penaltyLine < p.field.length / 2, `${id}: the penalty line must be inside the field`);
    assert.ok(p.field.restrictedLine < p.field.penaltyLine, `${id}: two metres is inside five metres`);
    assert.ok(p.field.goalWidth < p.field.width, `${id}: the goal must fit in the pool`);
    assert.ok(p.timing.periods % 2 === 0, `${id}: periods must divide into halves`);
    assert.ok(p.squad.activePlayers <= p.squad.maxRoster, `${id}: cannot field more than the roster`);
  }
});
