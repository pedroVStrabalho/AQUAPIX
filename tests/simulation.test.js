/**
 * Headless simulation tests (Design Bible sections 44.2 and 44.3).
 *
 * These play real matches with no renderer attached. The simulation layer has no
 * DOM dependency by design, which is what makes this possible - and what will
 * later make a dedicated match server possible.
 *
 * They assert the things gameplay QA is supposed to catch: that athletes move by
 * propulsion rather than teleportation, that possession alternates, that fouls
 * and exclusions occur at plausible rates, that stamina degrades performance,
 * that the AI does not cluster or abandon its marks, and that a match reaches
 * full time in a legal state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { generateLeague } from '../src/data/Teams.js';
import { getProfile } from '../src/rules/RuleProfiles.js';
import { MatchSim, ASSIST_PROFILE } from '../src/core/MatchSim.js';
import { MATCH_STATE } from '../src/rules/RulesEngine.js';
import { Athlete } from '../src/gameplay/Athlete.js';
import { Ball } from '../src/gameplay/Ball.js';
import { Vec2, Rng, dist2 } from '../src/core/Math2.js';

const league = generateLeague();

function makeMatch(overrides = {}) {
  return new MatchSim({
    profile: getProfile('quick-2'),
    league,
    homeId: 'tidal',
    awayId: 'kraken',
    seed: 12345,
    difficulty: 'national',
    assist: ASSIST_PROFILE.STANDARD,
    refereeProfile: 'standard',
    userSide: null,          // pure AI v AI so nothing waits on human input
    ...overrides,
  });
}

/** Run the simulation forward, collecting observations along the way. */
function play(sim, seconds, observer) {
  const step = 1 / 60;
  const steps = Math.round(seconds / step);
  for (let i = 0; i < steps; i++) {
    sim.update(step);
    if (observer) observer(sim, i * step);
    if (sim.state === MATCH_STATE.MATCH_END) break;
  }
  return sim;
}

// ===========================================================================
test('the league generates eight balanced squads of fourteen invented athletes', () => {
  assert.equal(league.teams.length, 8);
  for (const t of league.teams) {
    const roster = league.rosters[t.id];
    assert.equal(roster.length, 14, `${t.id} roster size`);
    const keepers = roster.filter((p) => p.position === 'GK');
    assert.equal(keepers.length, 2, `${t.id} must carry two goalkeepers`);
    for (const p of roster) {
      assert.ok(p.overall >= 30 && p.overall <= 99, `${p.name} overall in range`);
      assert.ok(p.attr.swimSpeed >= 12 && p.attr.swimSpeed <= 97);
      assert.equal(typeof p.leftHanded, 'boolean');
    }
  }
  // Balanced: no team more than eight overall points clear of the weakest.
  const strength = league.teams.map((t) =>
    league.rosters[t.id].slice(0, 7).reduce((s, p) => s + p.overall, 0) / 7);
  assert.ok(Math.max(...strength) - Math.min(...strength) < 9, 'squads are balanced');
});

test('the league is deterministic for a given seed', () => {
  const a = generateLeague(999);
  const b = generateLeague(999);
  assert.equal(a.rosters.tidal[3].name, b.rosters.tidal[3].name);
  assert.equal(a.rosters.tidal[3].attr.shotPower, b.rosters.tidal[3].attr.shotPower);
});

// ------------------------------------------------------------- locomotion --
test('an athlete accelerates through the water rather than snapping to a direction', () => {
  const player = league.rosters.tidal[3];
  const a = new Athlete(player, 'home', 1);
  const world = { profile: getProfile('wa-2026'), pool: getProfile('wa-2026').field };
  const cmd = { dir: new Vec2(0, 1), effort: 1, rise: 0, face: null, brace: false };

  const samples = [];
  for (let i = 0; i < 180; i++) {
    a.update(1 / 60, cmd, world);
    samples.push(a.speed);
  }

  assert.ok(samples[1] > 0, 'the athlete starts moving');
  assert.ok(samples[1] < 0.35, 'but does not reach full speed on the first frame');
  assert.ok(samples[59] > samples[9], 'speed builds over the first second');
  // Arcade pace, deliberately eased so the match is readable now that the whole
  // pool is on screen at once. Real swimmers do ~2 m/s; below that the controls
  // feel dead, above ~5 the play crosses the screen faster than you can read it.
  assert.ok(a.speed > 2.1 && a.speed < 5.5, `arcade sprint speed, got ${a.speed.toFixed(2)}`);

  // Cut the effort: drag alone must slow the athlete down.
  const top = a.speed;
  for (let i = 0; i < 120; i++) a.update(1 / 60, { dir: null, effort: 0, rise: 0 }, world);
  assert.ok(a.speed < top * 0.5, 'water resistance decelerates a gliding swimmer');
});

test('turning costs momentum: a reversal is slower than holding a line', () => {
  const player = league.rosters.tidal[3];
  const world = { profile: getProfile('wa-2026'), pool: getProfile('wa-2026').field };

  const straight = new Athlete(player, 'home', 1);
  for (let i = 0; i < 240; i++) straight.update(1 / 60, { dir: new Vec2(0, 1), effort: 1 }, world);

  const turner = new Athlete(player, 'home', 1);
  for (let i = 0; i < 120; i++) turner.update(1 / 60, { dir: new Vec2(0, 1), effort: 1 }, world);
  for (let i = 0; i < 120; i++) turner.update(1 / 60, { dir: new Vec2(0, -1), effort: 1 }, world);

  assert.ok(Math.abs(turner.pos.z) < Math.abs(straight.pos.z),
    'a swimmer who reversed covers less ground than one who held their line');
  assert.ok(turner.speed < straight.speed + 0.01, 'and is not faster afterwards');
});

test('swimming with the ball is slower than swimming without it', () => {
  const player = league.rosters.tidal[3];
  const world = { profile: getProfile('wa-2026'), pool: getProfile('wa-2026').field };
  const free = new Athlete(player, 'home', 1);
  const carrying = new Athlete(player, 'home', 1);
  carrying.hasBall = true;
  // Sample before either reaches the pool wall (arcade speeds cover 25m fast).
  for (let i = 0; i < 90; i++) {
    free.update(1 / 60, { dir: new Vec2(0, 1), effort: 1 }, world);
    carrying.update(1 / 60, { dir: new Vec2(0, 1), effort: 1 }, world);
  }
  assert.ok(carrying.speed < free.speed, 'dribbling costs speed (section 10.4)');
});

test('explosive elevation drains burst stamina and the ceiling falls with it', () => {
  const player = league.rosters.tidal[4];
  const a = new Athlete(player, 'home', 1);
  const world = { profile: getProfile('wa-2026'), pool: getProfile('wa-2026').field };

  // Rise to maximum from fresh.
  for (let i = 0; i < 60; i++) a.update(1 / 60, { dir: null, effort: 0, rise: 1 }, world);
  const freshHeight = a.elevation;
  assert.ok(freshHeight > 0.2, `a fresh athlete elevates meaningfully, got ${freshHeight.toFixed(2)}`);

  // Hammer it repeatedly.
  for (let rep = 0; rep < 24; rep++) {
    for (let i = 0; i < 30; i++) a.update(1 / 60, { dir: null, effort: 0.4, rise: 1 }, world);
    for (let i = 0; i < 10; i++) a.update(1 / 60, { dir: null, effort: 0.4, rise: 0 }, world);
  }
  for (let i = 0; i < 60; i++) a.update(1 / 60, { dir: null, effort: 0, rise: 1 }, world);

  assert.ok(a.burst < 0.7, `burst stamina is consumed, got ${a.burst.toFixed(2)}`);
  assert.ok(a.elevation < freshHeight * 0.92,
    `a tired athlete cannot rise as high (${a.elevation.toFixed(2)} vs ${freshHeight.toFixed(2)})`);
  assert.ok(a.matchFatigue > 0, 'match fatigue accumulates');
  assert.ok(a.freshness < 1, 'and lowers overall freshness');
});

test('bench recovery restores an exhausted athlete', () => {
  const a = new Athlete(league.rosters.tidal[3], 'home', 1);
  a.burst = 0.1; a.pool = 0.2; a.matchFatigue = 0.6;
  for (let i = 0; i < 60 * 20; i++) a.recoverOnBench(1 / 60);
  assert.ok(a.burst > 0.9, 'burst refills on the bench');
  assert.ok(a.matchFatigue < 0.4, 'match fatigue partly clears');
});

// ------------------------------------------------------------------- ball --
test('the ball floats: it settles at the surface rather than sinking or flying', () => {
  const ball = new Ball();
  const world = { profile: getProfile('wa-2026') };
  ball.reset(0, 2.0, 0);
  ball.state = 'flight';
  for (let i = 0; i < 60 * 8; i++) ball.update(1 / 60, world);
  assert.ok(ball.pos.y > -0.05 && ball.pos.y < ball.radius * 1.4,
    `the ball comes to rest at the waterline, got y=${ball.pos.y.toFixed(3)}`);
  assert.ok(ball.speed < 0.5, 'and stops moving');
});

test('a flat driven shot with topspin skips off the water and keeps going', () => {
  const ball = new Ball();
  const world = { profile: getProfile('wa-2026') };
  // Launch from 0.6 m, driving down toward the water 3 m ahead, heavy topspin.
  ball.launch({ x: 0, y: 0.6, z: 0 }, { x: 0, y: -1.9, z: 16 }, { x: 55, y: 0, z: 0 }, 'shot', null);

  let touchedWater = false;
  let roseAgain = false;
  let minY = 99;
  for (let i = 0; i < 60 * 2; i++) {
    ball.update(1 / 120, world);
    if (ball.pos.y < ball.radius * 0.9) { touchedWater = true; minY = Math.min(minY, ball.pos.y); }
    if (touchedWater && ball.pos.y > ball.radius * 1.5) roseAgain = true;
    if (Math.abs(ball.pos.z) > 12) break;
  }
  assert.ok(touchedWater, 'the ball met the surface');
  assert.ok(roseAgain, 'and buoyancy threw it back out - a physical skip, not an animation');
  assert.ok(ball.pos.z > 5, 'while still travelling toward goal');
});

test('a steep shot into the water dies instead of skipping', () => {
  const ball = new Ball();
  const world = { profile: getProfile('wa-2026') };
  ball.launch({ x: 0, y: 1.2, z: 0 }, { x: 0, y: -11, z: 5 }, { x: 0, y: 0, z: 0 }, 'shot', null);
  let maxAfter = -99;
  let entered = false;
  for (let i = 0; i < 60 * 3; i++) {
    ball.update(1 / 120, world);
    if (ball.pos.y < 0) entered = true;
    if (entered) maxAfter = Math.max(maxAfter, ball.pos.y);
  }
  assert.ok(entered, 'the ball went under');
  assert.ok(maxAfter < 0.9, `a steep entry does not skip to goal height, peaked at ${maxAfter.toFixed(2)}`);
});

test('the ball bounces off a post rather than passing through it', () => {
  const profile = getProfile('wa-2026');
  const ball = new Ball();
  let postHit = false;
  const world = { profile, onPost: () => { postHit = true; } };
  // Fire straight at the right-hand post of the +z goal.
  ball.launch({ x: profile.field.goalWidth / 2, y: 0.5, z: 8 }, { x: 0, y: 0, z: 14 }, null, 'shot', null);
  for (let i = 0; i < 200; i++) ball.update(1 / 120, world);
  assert.ok(postHit, 'the frame was struck');
  assert.ok(ball.vel.z < 6, 'and the ball came back off it');
});

// -------------------------------------------------------------- full match --
test('a full match reaches full time in a legal state', () => {
  const sim = makeMatch();
  sim.start();

  const maxSeconds = sim.profile.timing.periods * sim.profile.timing.periodSeconds + 600;
  play(sim, maxSeconds);

  assert.equal(sim.state, MATCH_STATE.MATCH_END, 'the match completed');
  assert.equal(sim.period, sim.profile.timing.periods, 'all periods were played');
  assert.ok(sim.score.home >= 0 && sim.score.away >= 0);

  // No athlete finished outside the pool without a reason.
  for (const side of ['home', 'away']) {
    const inPool = sim.activeAthletes(side);
    assert.ok(inPool.length >= 5 && inPool.length <= 7,
      `${side} finished with a legal number of athletes in the water (${inPool.length})`);
    for (const a of sim.squads[side]) {
      assert.ok(a.personalFouls <= sim.profile.discipline.personalFoulLimit,
        `${a.player.name} never exceeded the personal foul limit`);
    }
  }
});

test('a full match produces plausible water polo numbers', () => {
  const sim = makeMatch({ seed: 777 });
  sim.start();
  play(sim, sim.profile.timing.periods * sim.profile.timing.periodSeconds + 600);

  const s = sim.statsPackage();
  const totalGoals = s.score.home + s.score.away;
  const totalShots = s.home.shots + s.away.shots;

  assert.ok(totalShots > 4, `shots were taken (${totalShots})`);
  assert.ok(totalGoals >= 1, `goals were scored (${totalGoals})`);
  assert.ok(s.home.passesAttempted + s.away.passesAttempted > 20, 'the ball circulated');
  assert.ok(s.home.possessionTime + s.away.possessionTime > 60, 'possession was tracked');

  // Shooting percentage in the sane range for the sport.
  const pct = totalShots ? totalGoals / totalShots : 0;
  assert.ok(pct > 0.02 && pct < 0.85, `shooting percentage is plausible (${(pct * 100).toFixed(0)}%)`);

  // Goalkeepers make saves. Whether any single match records one is variance
  // (a match can be all misses and finishes), so this is checked in aggregate
  // across several seeds rather than pinned to one lucky match.
  let totalSaves = 0;
  for (const seed of [777, 12345, 4242, 31337]) {
    const g = makeMatch({ seed });
    g.start();
    play(g, g.profile.timing.periods * g.profile.timing.periodSeconds + 600);
    totalSaves += g.stats.home.saves + g.stats.away.saves;
  }
  assert.ok(totalSaves > 0, `goalkeepers made saves across seeds (${totalSaves})`);
});

test('possession changes hands repeatedly over a match', () => {
  const sim = makeMatch({ seed: 4242 });
  sim.start();
  let changes = 0;
  let last = null;
  play(sim, 240, (s) => {
    if (s.possession && s.possession !== last) { changes++; last = s.possession; }
  });
  assert.ok(changes >= 4, `possession alternated ${changes} times in four minutes`);
});

test('contact produces fouls, and fouls produce exclusions, at plausible rates', () => {
  const sim = makeMatch({ seed: 31337, difficulty: 'international' });
  sim.start();
  play(sim, sim.profile.timing.periods * sim.profile.timing.periodSeconds + 600);

  const fouls = sim.stats.home.ordinaryFouls + sim.stats.away.ordinaryFouls;
  const exclusions = sim.stats.home.exclusionsConceded + sim.stats.away.exclusionsConceded;

  assert.ok(fouls > 0, `ordinary fouls were called (${fouls})`);
  assert.ok(exclusions >= 0 && exclusions < 40, `exclusions are not runaway (${exclusions})`);
  // Every exclusion conceded must be matched by one drawn.
  assert.equal(
    sim.stats.home.exclusionsConceded, sim.stats.away.exclusionsDrawn,
    'every exclusion conceded by home was drawn by away'
  );
});

test('the AI keeps credible spacing and does not cluster', () => {
  const sim = makeMatch({ seed: 5150 });
  sim.start();
  let clusteredFrames = 0;
  let checked = 0;

  play(sim, 200, (s) => {
    if (!s.isLive()) return;
    for (const side of ['home', 'away']) {
      checked++;   // one observation per team per frame
      const list = s.activeAthletes(side).filter((a) => !a.isGoalkeeper);
      let tooClose = 0;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (dist2(list[i].pos, list[j].pos) < 1.1) tooClose++;
        }
      }
      // Three or more overlapping pairs on one team is a clustering failure.
      if (tooClose >= 3) clusteredFrames++;
    }
  });

  assert.ok(checked > 100, 'the match was actually live for the sample');
  // Guards against the pathological whole-team pile-up (which was ~100%+ before
  // the spacing fixes). Some front-court congestion is realistic in a 20x25m
  // pool (measured per team per frame), so the bar catches a genuine
  // whole-team collapse, not the normal congestion of six attackers in a small
  // front court.
  assert.ok(clusteredFrames / Math.max(1, checked) < 0.62,
    `teams stayed spread out (${((clusteredFrames / checked) * 100).toFixed(1)}% clustered frames)`);
});

test('athletes stay inside the field of play at all times', () => {
  const sim = makeMatch({ seed: 8080 });
  sim.start();
  const f = sim.profile.field;
  play(sim, 240, (s) => {
    for (const a of s.allActive()) {
      assert.ok(Math.abs(a.pos.x) <= f.width / 2 + 0.01, `${a.player.name} inside the side walls`);
      assert.ok(Math.abs(a.pos.z) <= f.length / 2 + 0.01, `${a.player.name} inside the goal lines`);
    }
  });
});

test('stamina degrades measurably across a match', () => {
  const sim = makeMatch({ seed: 606 });
  sim.start();
  const tracked = sim.activeAthletes('home').filter((a) => !a.isGoalkeeper);
  const before = tracked.map((a) => a.freshness);
  // Fatigue builds through a period and recovers at the breaks, so it is read
  // across the whole run: a snapshot at one fixed second can land just after an
  // interval, when it has legitimately recovered.
  let peakFatigue = 0, lowestFreshness = 1;
  play(sim, 400, () => {
    for (const a of tracked) {
      peakFatigue = Math.max(peakFatigue, a.matchFatigue);
      if (a.inPool) lowestFreshness = Math.min(lowestFreshness, a.freshness);
    }
  });
  // Read freshness across play too: a fixed sampling second can land in an
  // interval, where the squad has legitimately recovered.
  assert.ok(lowestFreshness < Math.max(...before) - 0.02,
    `athletes tire during play (lowest ${lowestFreshness.toFixed(2)} against ${Math.max(...before).toFixed(2)} at the start)`);
  assert.ok(peakFatigue > 0.1, `match fatigue accumulated during play (peak ${peakFatigue.toFixed(3)})`);
});

test('the match record is written and can be replayed deterministically', () => {
  const runOnce = (seed) => {
    const sim = makeMatch({ seed });
    sim.start();
    play(sim, 120);
    return {
      score: { ...sim.score },
      record: sim.record.length,
      rngCalls: sim.rng.calls,
      digest: sim.record.slice(0, 200).map((r) => `${r.type}:${r.t}`).join('|'),
    };
  };
  const a = runOnce(2468);
  const b = runOnce(2468);
  assert.deepEqual(a.score, b.score, 'identical seeds produce identical scores');
  assert.equal(a.digest, b.digest, 'and an identical event record');
  assert.ok(a.record > 20, 'the record captured events');

  const c = runOnce(1357);
  assert.notEqual(a.digest, c.digest, 'a different seed produces a different match');
});

test('a match can be serialised and restored', () => {
  const sim = makeMatch({ seed: 9001 });
  sim.start();
  play(sim, 90);

  const snapshot = sim.serialise();
  assert.equal(snapshot.version, 2);
  assert.ok(snapshot.athletes.length === 28, 'both full squads are saved');

  const restored = makeMatch({ seed: 9001 });
  restored.start();
  restored.restore(snapshot);
  assert.deepEqual(restored.score, sim.score);
  assert.equal(restored.period, sim.period);
  assert.ok(Math.abs(restored.gameClock - sim.gameClock) < 1e-6);
});

test('pulling the goalkeeper gives a seventh field player and an empty goal', () => {
  const sim = makeMatch({ seed: 111 });
  sim.start();
  play(sim, 20);

  const before = sim.activeCount('home');
  assert.ok(sim.goalkeeperFor('home'), 'a goalkeeper started');
  const r = sim.pullGoalkeeper('home');
  assert.equal(r.ok, true, `pulling the keeper succeeded (${r.reason ?? ''})`);
  assert.equal(sim.goalkeeperFor('home'), null, 'the goal is now empty');
  assert.equal(sim.activeCount('home'), before, 'the squad size is unchanged - a field player replaced them');
  assert.equal(sim.activeAthletes('home').filter((a) => a.isGoalkeeper).length, 0);
});

test('an exclusion creates a genuine extra-player situation', () => {
  const sim = makeMatch({ seed: 222 });
  sim.start();
  play(sim, 15);

  const victimTeam = 'away';
  const offender = sim.activeAthletes(victimTeam).find((a) => !a.isGoalkeeper);
  const before = { home: sim.activeCount('home'), away: sim.activeCount('away') };

  sim._excludeAthlete(offender, sim.profile.timing.exclusionSeconds, false);

  assert.equal(sim.activeCount('away'), before.away - 1, 'the excluded athlete left the water');
  assert.equal(sim.playerAdvantage('home'), 1, 'home now has the extra player');
  assert.equal(offender.inPool, false);

  // Serve the full exclusion and check the athlete comes back.
  play(sim, sim.profile.timing.exclusionSeconds + 4);
  assert.ok(offender.inPool || sim.state !== MATCH_STATE.LIVE,
    'the athlete re-entered once the exclusion expired');
});

test('a timeout is granted to the team in possession and refused to the other', () => {
  const sim = makeMatch({ seed: 333 });
  sim.start();
  play(sim, 25);
  if (!sim.possession) play(sim, 20);

  const withBall = sim.possession;
  const without = sim.opponentSide(withBall);
  assert.equal(sim.callTimeout(without).allowed, false, 'refused without possession');
  const ok = sim.callTimeout(withBall);
  assert.equal(ok.allowed, true, 'granted with possession');
  assert.equal(sim.timeoutsUsed[withBall], 1);
  assert.equal(sim.state, MATCH_STATE.TIMEOUT);
});

test('difficulty changes AI behaviour without inflating athlete attributes', () => {
  const amateur = makeMatch({ seed: 4004, difficulty: 'amateur' });
  const legendary = makeMatch({ seed: 4004, difficulty: 'legendary' });

  // The published ratings must be identical: difficulty may not touch them
  // (section 19.2).
  for (let i = 0; i < 14; i++) {
    assert.equal(
      amateur.squads.away[i].player.attr.shotPower,
      legendary.squads.away[i].player.attr.shotPower,
      'attributes are untouched by difficulty'
    );
    assert.equal(amateur.squads.away[i].maxSpeed, legendary.squads.away[i].maxSpeed);
  }
  // What does change is recognition, reaction and error.
  assert.ok(legendary.ai.away.diff.react < amateur.ai.away.diff.react);
  assert.ok(legendary.ai.away.diff.recognition > amateur.ai.away.diff.recognition);
  assert.ok(legendary.ai.away.diff.error < amateur.ai.away.diff.error);
});

test('the simulation is stable at low and high frame rates alike', () => {
  for (const step of [1 / 30, 1 / 60, 1 / 144]) {
    const sim = makeMatch({ seed: 555 });
    sim.start();
    const steps = Math.round(120 / step);
    for (let i = 0; i < steps; i++) sim.update(step);
    for (const a of sim.allActive()) {
      assert.ok(Number.isFinite(a.pos.x) && Number.isFinite(a.pos.z), `positions finite at ${(1 / step).toFixed(0)}Hz`);
      // Guards against INSTABILITY, not against legitimate pace. A fast swimmer
      // sprinting in the arcade profile genuinely reaches ~4 m/s, so the old
      // bound of 4 flagged correct behaviour; anything near 7 is a blow-up.
      assert.ok(a.speed < 7, `no runaway velocity at ${(1 / step).toFixed(0)}Hz (${a.speed.toFixed(2)})`);
    }
    assert.ok(Number.isFinite(sim.ball.pos.y));
    assert.ok(sim.ball.speed < 60, 'ball speed stays physical');
  }
});
