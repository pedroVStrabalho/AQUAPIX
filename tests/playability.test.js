/**
 * Can a human actually PLAY this?
 *
 * These drive the real Input2D through the real match simulation and assert the
 * things a person would notice in the first thirty seconds: that pressing a
 * direction moves your athlete THAT way, that it is responsive rather than
 * sluggish, that you can switch players, pass and shoot, and that the AI on the
 * other side plays a recognisable game of water polo rather than swarming the
 * ball or never shooting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser shims so Input2D can construct headlessly.
globalThis.window = { addEventListener() {}, removeEventListener() {} };
Object.defineProperty(globalThis, 'navigator', { value: { maxTouchPoints: 0 }, configurable: true });
globalThis.document = {
  getElementById() { return null; },
  createElement() {
    return {
      style: {}, dataset: {}, addEventListener() {}, appendChild() {},
      querySelector() { return { style: {} }; }, querySelectorAll() { return []; },
      set innerHTML(v) {},
    };
  },
};

const { generateLeague } = await import('../src/data/Teams.js');
const { getProfile } = await import('../src/rules/RuleProfiles.js');
const { MatchSim, ASSIST_PROFILE } = await import('../src/core/MatchSim.js');
const { MATCH_STATE } = await import('../src/rules/RulesEngine.js');
const { Input2D } = await import('../src/ui/Input2D.js');

const league = generateLeague();

function liveMatch(seed = 7) {
  const sim = new MatchSim({
    profile: getProfile('quick-2'), league, homeId: 'tidal', awayId: 'kraken',
    seed, difficulty: 'national', assist: ASSIST_PROFILE.STANDARD,
    refereeProfile: 'standard', userSide: 'home',
  });
  sim.start();
  // Pin control for measurement: EAFC-style auto-switching would hand the
  // athlete we are measuring back to the AI mid-test, which looks exactly like
  // broken controls but is the harness's fault, not the game's.
  sim.autoSwitch = false;
  const input = new Input2D(sim, { renderer: { flip: false } });
  const frame = (dt) => {
    sim.userCommand = input.update(dt);
    let acc = dt; const s = 1 / 120;
    while (acc >= s) { sim.update(s); acc -= s; }
  };
  for (let i = 0; i < 1600 && sim.state !== MATCH_STATE.LIVE; i++) frame(1 / 60);
  return { sim, input, frame };
}

/** Hold a set of input actions for n frames and report the displacement. */
function nudge(ctx, actions, frames = 45, athlete = null) {
  const { sim, input, frame } = ctx;
  const me = athlete ?? sim.autoSelectAthlete('home');
  sim.setUserAthlete(me);
  me.vel.set(0, 0);
  const from = { x: me.pos.x, z: me.pos.z };
  input.down.clear();
  for (const a of actions) input.down.add(a);
  for (let i = 0; i < frames; i++) frame(1 / 60);
  // Settled heading matters as much as raw displacement: an athlete asked to
  // reverse has to turn first, so the path out includes the turn arc.
  const vx = me.vel.x, vz = me.vel.z;
  input.down.clear();
  return { dx: me.pos.x - from.x, dz: me.pos.z - from.z, vx, vz, me };
}

test('pressing a direction moves your athlete, and the opposite key reverses it', () => {
  const ctx = liveMatch();
  assert.equal(ctx.sim.state, MATCH_STATE.LIVE);

  // Don't assume a world-axis convention (input is screen-space and the
  // renderer may flip): assert that opposed inputs produce opposed motion, and
  // that each one actually covers ground.
  const subject = ctx.sim.autoSelectAthlete('home');
  for (const [a, b] of [['up', 'down'], ['left', 'right']]) {
    const first = nudge(ctx, [a], 45, subject);
    const second = nudge(ctx, [b], 45, subject);

    const magA = Math.hypot(first.dx, first.dz);
    const magB = Math.hypot(second.dx, second.dz);
    assert.ok(magA > 0.4, `holding ${a} moves the athlete (${magA.toFixed(2)}m)`);
    assert.ok(magB > 0.4, `holding ${b} moves the athlete (${magB.toFixed(2)}m)`);

    // Opposed directions, measured on the settled swimming direction.
    const sa = Math.hypot(first.vx, first.vz) || 1;
    const sb = Math.hypot(second.vx, second.vz) || 1;
    const dot = (first.vx * second.vx + first.vz * second.vz) / (sa * sb);
    assert.ok(dot < -0.4, `${a} and ${b} swim in opposite directions (dot ${dot.toFixed(2)})`);
  }
});

test('movement is responsive, not sluggish: a second of input covers real water', () => {
  const ctx = liveMatch(11);
  const { dx, dz } = nudge(ctx, ['up'], 60);
  const travelled = Math.hypot(dx, dz);
  // The whole point of the arcade retune: one second of holding a direction has
  // to feel like something. Below ~1.5m it reads as "the controls don't work".
  assert.ok(travelled > 1.5, `one second of input covers ${travelled.toFixed(2)}m`);
  assert.ok(travelled < 8, `...without teleporting (${travelled.toFixed(2)}m)`);
});

test('sprint is faster than cruising', () => {
  const c1 = liveMatch(21);
  const a = nudge(c1, ['up'], 60, c1.sim.autoSelectAthlete('home'));
  const cruise = Math.hypot(a.dx, a.dz);
  const c2 = liveMatch(21);
  const s = nudge(c2, ['up', 'sprint'], 60, c2.sim.autoSelectAthlete('home'));
  const sprint = Math.hypot(s.dx, s.dz);
  assert.ok(sprint > cruise, `sprinting covers more water (${sprint.toFixed(2)}m vs ${cruise.toFixed(2)}m)`);
});

test('releasing the keys brings the athlete to rest', () => {
  const ctx = liveMatch(13);
  const { me } = nudge(ctx, ['up'], 40);
  for (let i = 0; i < 90; i++) ctx.frame(1 / 60);
  assert.ok(me.speed < 1.0, `the athlete coasts to a stop (${me.speed.toFixed(2)} m/s)`);
});

test('you can switch which athlete you control', () => {
  const { sim, frame } = liveMatch(17);
  const mine = sim.activeAthletes('home').filter((a) => !a.isGoalkeeper);
  assert.ok(mine.length > 1, 'there is more than one athlete to switch between');

  sim.setUserAthlete(mine[0]);
  const first = sim.userAthlete;
  sim.cycleUserAthlete?.();
  frame(1 / 60);

  // Either an explicit cycle exists, or selecting directly works. Both are
  // legitimate; what matters is that control can move to another athlete.
  if (sim.userAthlete === first) sim.setUserAthlete(mine[1]);
  assert.notEqual(sim.userAthlete, first, 'control moved to a different athlete');
  assert.ok(sim.userAthlete.side === 'home', 'and stayed on your own team');
});

test('the goalkeeper stays in their goal instead of wandering upfield', () => {
  const sim = new MatchSim({
    profile: getProfile('quick-2'), league, homeId: 'tidal', awayId: 'kraken',
    seed: 99, difficulty: 'national', assist: ASSIST_PROFILE.STANDARD,
    refereeProfile: 'standard', userSide: null,
  });
  sim.start();
  const half = sim.profile.field.length / 2;
  let worst = 0;
  for (let i = 0; i < 200 * 60; i++) {
    sim.update(1 / 60);
    if (!sim.isLive()) continue;
    for (const side of ['home', 'away']) {
      const gk = sim.goalkeeperFor(side);
      if (!gk || !gk.inPool || gk.hasBall) continue;
      const ownGoalZ = -gk.attackDir * half;
      worst = Math.max(worst, Math.abs(gk.pos.z - ownGoalZ));
    }
  }
  assert.ok(worst < 7, `the keeper never strays far from their line (worst ${worst.toFixed(1)}m)`);
});

test('a shot from half court is not a realistic way to score', () => {
  // The keeper has most of a second to read a long shot and should take it.
  let goals = 0;
  const trials = 40;
  for (let t = 0; t < trials; t++) {
    const sim = new MatchSim({
      profile: getProfile('quick-2'), league, homeId: 'tidal', awayId: 'kraken',
      seed: 2000 + t, difficulty: 'national', assist: ASSIST_PROFILE.STANDARD,
      refereeProfile: 'standard', userSide: null,
    });
    sim.start();
    for (let i = 0; i < 180; i++) sim.update(1 / 60);

    const shooter = sim.activeAthletes('home').find((a) => !a.isGoalkeeper);
    const gz = shooter.attackDir * (sim.profile.field.length / 2);
    // Clear everyone else out so this measures the KEEPER, not a lucky block.
    for (const s of ['home', 'away']) {
      for (const a of sim.activeAthletes(s)) {
        if (a === shooter || a.isGoalkeeper) continue;
        a.pos.x = 9; a.pos.z = -shooter.attackDir * 11; a.vel.set(0, 0);
      }
    }
    shooter.pos.x = 0;
    shooter.pos.z = gz - shooter.attackDir * 12;   // half court
    shooter.vel.set(0, 0);
    sim._giveBall(shooter);

    const before = sim.score.home;
    sim.tryShot(shooter, { x: 0.7, y: 0.45 }, 'power', 1);
    // Only the SHOT itself. Beyond about a second any goal is a put-back off
    // the rebound, which is a different thing entirely - and with every other
    // athlete parked out of the way the shooter would collect it unopposed.
    for (let i = 0; i < 60; i++) sim.update(1 / 60);
    if (sim.score.home > before) goals++;
  }
  const rate = goals / trials;
  assert.ok(rate < 0.25, `half-court shots rarely beat the keeper (${(rate * 100).toFixed(0)}%)`);
});

test('close-range shooting beats long-range shooting', () => {
  const convert = (distance) => {
    let goals = 0;
    const trials = 30;
    for (let t = 0; t < trials; t++) {
      const sim = new MatchSim({
        profile: getProfile('quick-2'), league, homeId: 'tidal', awayId: 'kraken',
        seed: 3000 + t, difficulty: 'national', assist: ASSIST_PROFILE.STANDARD,
        refereeProfile: 'standard', userSide: null,
      });
      sim.start();
      for (let i = 0; i < 180; i++) sim.update(1 / 60);
      const shooter = sim.activeAthletes('home').find((a) => !a.isGoalkeeper);
      const gz = shooter.attackDir * (sim.profile.field.length / 2);
      for (const s of ['home', 'away']) {
        for (const a of sim.activeAthletes(s)) {
          if (a === shooter || a.isGoalkeeper) continue;
          a.pos.x = 9; a.pos.z = -shooter.attackDir * 11; a.vel.set(0, 0);
        }
      }
      shooter.pos.x = 0;
      shooter.pos.z = gz - shooter.attackDir * distance;
      shooter.vel.set(0, 0);
      sim._giveBall(shooter);
      const before = sim.score.home;
      sim.tryShot(shooter, { x: 0.7, y: 0.45 }, 'power', 1);
      for (let i = 0; i < 150; i++) sim.update(1 / 60);
      if (sim.score.home > before) goals++;
    }
    return goals / trials;
  };
  assert.ok(convert(3) > convert(12), 'distance is the dominant factor in scoring');
});

test('both teams shoot: the AI actually attacks the goal', () => {
  const sim = new MatchSim({
    profile: getProfile('quick-2'), league, homeId: 'tidal', awayId: 'kraken',
    seed: 4242, difficulty: 'national', assist: ASSIST_PROFILE.STANDARD,
    refereeProfile: 'standard', userSide: null,
  });
  sim.start();
  for (let i = 0; i < 60 * 60 * 8; i++) {
    sim.update(1 / 60);
    if (sim.state === MATCH_STATE.MATCH_END) break;
  }
  // The regression this guards: the AI stopped shooting entirely because the
  // shot-value heuristic had been miscalibrated, and every possession ended in
  // a drive or a turnover instead of an attempt on goal.
  assert.ok(sim.stats.home.shots >= 3, `home had a go (${sim.stats.home.shots} shots)`);
  assert.ok(sim.stats.away.shots >= 3, `away had a go (${sim.stats.away.shots} shots)`);
});

test('a full match finishes in a legal, complete state', () => {
  const sim = new MatchSim({
    profile: getProfile('quick-2'), league, homeId: 'tidal', awayId: 'kraken',
    seed: 5150, difficulty: 'national', assist: ASSIST_PROFILE.STANDARD,
    refereeProfile: 'standard', userSide: null,
  });
  sim.start();
  let frames = 0;
  while (sim.state !== MATCH_STATE.MATCH_END && frames < 60 * 60 * 20) {
    sim.update(1 / 60);
    frames++;
  }
  assert.equal(sim.state, MATCH_STATE.MATCH_END, 'the match reached full time');
  assert.ok(sim.score.home >= 0 && sim.score.away >= 0, 'the score is sane');
  const pkg = sim.statsPackage();
  assert.ok(pkg.home && pkg.away, 'a stats package is produced for both sides');
});
