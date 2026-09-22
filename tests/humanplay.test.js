/**
 * What a HUMAN sees, in every mode.
 *
 * Quick Match, Coach Career and Player Career all run the same MatchSim through
 * the same keyboard layer. The bugs these tests pin down only appeared with a
 * person actually playing - earlier measurements left the user's athlete idle
 * and missed them entirely - so every test here drives real key events.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const listeners = {};
globalThis.window = {
  addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
  removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
};
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
const fire = (type, code) => { for (const f of (listeners[type] || [])) f({ code, preventDefault() {} }); };

const { generateLeague } = await import('../src/data/Teams.js');
const { getProfile } = await import('../src/rules/RuleProfiles.js');
const { MatchSim, ASSIST_PROFILE, shootoutOutcome } = await import('../src/core/MatchSim.js');
const { MATCH_STATE } = await import('../src/rules/RulesEngine.js');
const { Input2D } = await import('../src/ui/Input2D.js');
const { Rng } = await import('../src/core/Math2.js');

const league = generateLeague();

function match(seed, awayId = 'kraken', difficulty = 'national') {
  for (const k in listeners) listeners[k] = [];
  const sim = new MatchSim({
    profile: getProfile('arcade'), league, homeId: 'tidal', awayId,
    seed, difficulty, assist: ASSIST_PROFILE.STANDARD, refereeProfile: 'standard', userSide: 'home',
  });
  sim.start();
  const input = new Input2D(sim, { renderer: { flip: false } });
  const frame = () => { sim.userCommand = input.update(1 / 60); sim.update(1 / 60); };
  return { sim, input, frame };
}

/** A simple human: carries toward goal, passes with Z, shoots with X when close, chases and steals with X. */
function playAsHuman(sim, frame, seconds, onFrame = () => {}) {
  const held = new Set();
  const press = (c) => { if (!held.has(c)) { fire('keydown', c); held.add(c); } };
  const release = (c) => { if (held.has(c)) { fire('keyup', c); held.delete(c); } };
  const tap = [];
  let holdT = 0;
  for (let i = 0; i < 60 * seconds && !sim.finished; i++) {
    for (const c of tap.splice(0)) release(c);
    for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) release(k);
    const me = sim.userAthlete;
    if (me && sim.isLive()) {
      const gz = me.attackDir * sim.profile.field.length / 2;
      const steer = (tx, tz) => {
        const dz = tz - me.pos.z, dx = tx - me.pos.x;
        if (dz > 0.4) press('KeyD'); else if (dz < -0.4) press('KeyA');
        if (dx > 0.4) press('KeyS'); else if (dx < -0.4) press('KeyW');
      };
      if (me.hasBall) {
        holdT += 1 / 60;
        steer(0, gz - me.attackDir * 5);
        if (holdT > 1.2) {
          const k = Math.hypot(me.pos.x, gz - me.pos.z) < 7 ? 'KeyX' : 'KeyZ';
          press(k); tap.push(k); holdT = 0;
        }
      } else {
        holdT = 0;
        const car = sim.ball.holder;
        if (car && car.side !== me.side) steer(car.pos.x, car.pos.z);
        else if (!car) steer(sim.ball.pos.x, sim.ball.pos.z);
      }
    }
    frame();
    onFrame();
  }
}

test('a save never turns into a centre restart when a human is playing', () => {
  // The keeper was "saving" the ball as it bounced back out of the net after a
  // goal had already been given: SAVE flash, keeper holding it, then a restart
  // from the centre. And a tip or parry that squirted over the line counted.
  let saves = 0, restarts = 0;
  for (let m = 0; m < 8; m++) {
    const { sim, frame } = match(11000 + m, ['kraken', 'solaris', 'atlas', 'obsidian'][m % 4]);
    let watch = null;
    sim.bus.on('save', () => {
      saves++;
      if (sim.state === MATCH_STATE.GOAL) restarts++;       // saved AFTER the goal was given
      watch = { t: 0 };
    });
    playAsHuman(sim, frame, 60 * 6, () => {
      if (!watch) return;
      watch.t += 1 / 60;
      if (sim.state === MATCH_STATE.GOAL) { restarts++; watch = null; }
      else if (sim.ball.holder || !sim.isLive() || watch.t > 6) watch = null;
    });
  }
  assert.ok(saves >= 15, `saves happened (${saves})`);
  assert.equal(restarts, 0, `no save was followed by a centre restart (${restarts} of ${saves})`);
});

test('a full-length counter, alone against the keeper, ends in a goal', () => {
  // A counter swum from your own half takes six to eight seconds. The break used
  // to expire after 3.2, so a player alone three metres out was scored as a set
  // attack and could be saved or miss.
  let goals = 0, n = 0;
  for (let t = 0; t < 20; t++) {
    const { sim, frame } = match(7300 + t);
    for (let i = 0; i < 2000 && !sim.isLive(); i++) frame();
    const me = sim.activeAthletes('home').find((a) => !a.isGoalkeeper);
    sim.setUserAthlete(me);
    const gz = me.attackDir * sim.profile.field.length / 2;
    for (const s of ['home', 'away']) {
      for (const a of sim.activeAthletes(s)) {
        if (a === me || a.isGoalkeeper) continue;
        a.pos.x = ((t * 7 + a.id.length) % 8) - 4; a.pos.z = -gz * 0.75; a.vel.set(0, 0);
      }
    }
    me.pos.x = 0; me.pos.z = -gz * 0.55; me.vel.set(0, 0);
    sim._giveBall(me); sim._setPossession('home'); sim._openTransition('home');
    let out = null, shot = false;
    sim.bus.on('goal', () => { out ??= 'goal'; });
    sim.bus.on('save', () => { out ??= 'save'; });
    const k = me.attackDir > 0 ? 'KeyD' : 'KeyA';
    for (let i = 0; i < 60 * 14 && !out; i++) {
      if (!shot) {
        fire('keydown', k);
        if (me.hasBall && Math.abs(gz - me.pos.z) < 3.2) {
          fire('keyup', k); fire('keydown', 'KeyX'); frame(); fire('keyup', 'KeyX'); shot = true; n++; continue;
        }
        if (!me.hasBall) break;
      }
      frame();
    }
    fire('keyup', k);
    if (out === 'goal') goals++;
  }
  assert.ok(n >= 18, `the counters reached shooting range (${n})`);
  assert.ok(goals / n >= 0.9, `alone on the break inside 3m is a goal (${goals}/${n})`);
});

test('a steal is a real chance when you are right on the ball', () => {
  // It used to succeed 1.5% of the time face to face - seventy presses a steal.
  let ok = 0, far = 0;
  const N = 120;
  for (let t = 0; t < N; t++) {
    for (const [gap, count] of [[0.6, 'near'], [2.4, 'far']]) {
      const { sim, frame } = match(2000 + t);
      for (let i = 0; i < 2000 && !sim.isLive(); i++) frame();
      const car = sim.activeAthletes('away').filter((a) => !a.isGoalkeeper)[t % 6];
      const me = sim.activeAthletes('home').filter((a) => !a.isGoalkeeper)[t % 6];
      car.pos.x = 0; car.pos.z = 0; car.vel.set(0, 0);
      me.pos.x = 0; me.pos.z = car.attackDir * gap; me.vel.set(0, 0);
      me.shoulder = me.heading = Math.atan2(car.pos.x - me.pos.x, car.pos.z - me.pos.z);
      sim._giveBall(car);
      sim.setUserAthlete(me);
      me.stealCooldown = 0; me.actionLock = 0;
      if (sim.trySteal(me)) { if (count === 'near') ok++; else far++; }
    }
  }
  const rate = ok / N;
  assert.ok(rate > 0.2 && rate < 0.55, `face to face at 0.6m a steal works about a third of the time (${(rate * 100).toFixed(0)}%)`);
  assert.equal(far, 0, 'out of reach, it never works');
});

test('X steals and SPACE fouls when defending - through the real keys', () => {
  const { sim, frame } = match(64);
  for (let i = 0; i < 2000 && !sim.isLive(); i++) frame();
  const car = sim.activeAthletes('away').find((a) => !a.isGoalkeeper);
  const me = sim.activeAthletes('home').find((a) => !a.isGoalkeeper);
  sim._giveBall(car);
  sim.setUserAthlete(me);
  let tries = 0;
  const orig = sim.trySteal.bind(sim);
  sim.trySteal = (d) => { tries++; return orig(d); };
  car.pos.x = 0; car.pos.z = 0; me.pos.x = 0; me.pos.z = car.attackDir * 0.7;
  me.stealCooldown = 0; me.actionLock = 0;
  fire('keydown', 'KeyX'); frame(); fire('keyup', 'KeyX');
  assert.equal(tries, 1, 'X is a steal attempt on defence');
});

test('passes reach a team-mate unless a defender is genuinely in the way', () => {
  // A defender only had to be within about half a metre of a passing ball to
  // take it - the passer's own marker beside him, or anyone next to the lane.
  let thrown = 0, mate = 0, opp = 0;
  for (let m = 0; m < 4; m++) {
    const { sim, frame } = match(4000 + m);
    let live = null;
    sim.bus.on('pass', ({ passer }) => { thrown++; live = { side: passer.side, passer }; });
    playAsHuman(sim, frame, 60 * 5, () => {
      if (!live || !sim.ball.holder) return;
      if (sim.ball.holder === live.passer) { /* re-grab */ }
      else if (sim.ball.holder.side === live.side) mate++;
      else opp++;
      live = null;
    });
  }
  assert.ok(thrown > 200, `passes were thrown (${thrown})`);
  assert.ok(mate / thrown > 0.74, `most passes arrive (${(mate / thrown * 100).toFixed(1)}%)`);
  assert.ok(opp / thrown < 0.13, `few are picked off (${(opp / thrown * 100).toFixed(1)}%)`);
});

test('shootout rule: where the keeper goes decides it, not a coin flip', () => {
  const rng = new Rng(5);
  const rate = (zone, dive) => {
    let saved = 0;
    for (let i = 0; i < 4000; i++) if (shootoutOutcome({ zone, dive, placement: 0.5, gkSkill: 0.5, rng }) === 'save') saved++;
    return saved / 4000;
  };
  // The complaint: shots down the middle going in. A keeper who STAYS saves them.
  assert.ok(rate(0, 0) > 0.8, `down the middle against a keeper who stays: saved ${(rate(0, 0) * 100).toFixed(0)}%`);
  assert.ok(rate(0, 1) < 0.05, `down the middle against a keeper who dives: goes in (${(rate(0, 1) * 100).toFixed(0)}% saved)`);
  assert.ok(rate(1, 1) > 0.35, `keeper guessed the corner: real chance (${(rate(1, 1) * 100).toFixed(0)}% saved)`);
  assert.ok(rate(1, -1) < 0.05, `keeper went the wrong way: goal (${(rate(1, -1) * 100).toFixed(0)}% saved)`);
});

test('shootout: you take every one of your kicks, aim them, and keep goal against theirs', () => {
  const { sim, input, frame } = match(515);
  sim._prepareShootout();
  sim._setState(MATCH_STATE.SHOOTOUT, 2);
  let mine = 0, humanShot = 0, waited = true, aimedUp = 0, humanKept = 0, theirs = 0;
  let aimT = 0;
  for (let i = 0; i < 60 * 300 && !sim.finished; i++) {
    for (const c of ['KeyW', 'KeyS', 'KeyX']) fire('keyup', c);
    const so = sim.shootout;
    if (so?.phase === 'aim') {
      aimT += 1 / 60;
      if (so.humanShoots) {
        fire('keydown', 'KeyW');                       // up corner
        if (aimT > 0.8) fire('keydown', 'KeyX');
      }
    } else aimT = 0;
    const before = so?.phase, t = aimT;
    frame();
    const after = sim.shootout;
    if (before === 'aim' && after?.phase === 'flight') {
      if (after.current.side === 'home') {
        mine++;
        if (after.humanShoots) humanShot++;
        if (t < 0.75) waited = false;
        if (Math.sign(sim.ball.vel.x) === -1) aimedUp++;   // screen UP = world -x with no flip
      } else {
        theirs++;
        if (after.humanKeeps) humanKept++;
      }
    }
  }
  assert.ok(mine >= 5, `the shootout ran (${mine} of our kicks)`);
  assert.equal(humanShot, mine, 'the human took every one of their team\'s kicks');
  assert.ok(waited, 'no kick went before the human pressed SHOOT');
  assert.equal(aimedUp, mine, 'every kick went to the corner the human picked');
  assert.equal(humanKept, theirs, 'the human kept goal against every one of theirs');
});

test('a counter with a defender chasing on your back still ends in a goal', () => {
  // The break used to demand nobody within 3.5m in ANY direction, so the
  // defender trailing behind you - who is always there on a counter - switched
  // it off. Only a defender level with you or goalside counts. The break here
  // also starts the way a goal throw after a missed shot does: possession just
  // changes hands, without the steal/save transition.
  let goals = 0, n = 0;
  for (let t = 0; t < 20; t++) {
    const { sim, frame } = match(7400 + t);
    for (let i = 0; i < 2000 && !sim.isLive(); i++) frame();
    const me = sim.activeAthletes('home').find((a) => !a.isGoalkeeper);
    sim.setUserAthlete(me);
    const gz = me.attackDir * sim.profile.field.length / 2;
    for (const s of ['home', 'away']) {
      for (const a of sim.activeAthletes(s)) {
        if (a === me || a.isGoalkeeper) continue;
        a.pos.x = ((t * 5 + a.id.length) % 8) - 4; a.pos.z = -gz * 0.75; a.vel.set(0, 0);
      }
    }
    const chaser = sim.activeAthletes('away').find((a) => !a.isGoalkeeper);
    me.pos.x = 0; me.pos.z = -gz * 0.55; me.vel.set(0, 0);
    sim._giveBall(me);
    sim.possession = 'away'; sim._setPossession('home', 'restart');
    let out = null, shot = false;
    sim.bus.on('goal', () => { out ??= 'goal'; });
    sim.bus.on('save', () => { out ??= 'save'; });
    const k = me.attackDir > 0 ? 'KeyD' : 'KeyA';
    for (let i = 0; i < 60 * 14 && !out; i++) {
      if (!shot) {
        fire('keydown', k);
        if (!me.hasBall) break;
        chaser.pos.x = me.pos.x + 0.3; chaser.pos.z = me.pos.z - me.attackDir * 1.1; chaser.vel.set(0, 0);
        if (Math.abs(gz - me.pos.z) < 3.2) {
          fire('keyup', k); fire('keydown', 'KeyX'); frame(); fire('keyup', 'KeyX'); shot = true; n++; continue;
        }
      }
      frame();
    }
    fire('keyup', k);
    if (out === 'goal') goals++;
  }
  assert.ok(n >= 15, `the counters reached shooting range (${n})`);
  assert.ok(goals / n >= 0.9, `alone in front of the keeper on the break is a goal, chaser or not (${goals}/${n})`);
});

test('a keeper gathering a loose ball holds it - no bobbling in front of his own net', () => {
  // Keepers were fumbling ordinary pickups with an outfielder's catch
  // reliability, about four times a match, sometimes twice in a row, until an
  // opponent arrived and scored.
  let pickups = 0, fumbles = 0;
  for (let t = 0; t < 80; t++) {
    const { sim, frame } = match(8800 + t);
    for (let i = 0; i < 2000 && !sim.isLive(); i++) frame();
    const gk = sim.goalkeeperFor('home');
    for (const s of ['home', 'away']) {
      for (const a of sim.activeAthletes(s)) { if (!a.isGoalkeeper) { a.pos.x = 9; a.pos.z = 0; a.vel.set(0, 0); } }
    }
    // A slow ball drifting to the keeper, last touched by an opponent.
    const opp = sim.activeAthletes('away').find((a) => !a.isGoalkeeper);
    sim.ball.launch({ x: gk.pos.x + 0.9, y: 0.3, z: gk.pos.z + gk.attackDir * 0.9 },
      { x: -1.5, y: 0.5, z: -gk.attackDir * 1.5 }, { x: 0, y: 0, z: 0 }, 'deflection', opp);
    let fumbled = false;
    const orig = sim.ball.launch.bind(sim.ball);
    sim.ball.launch = (f, v, sp, kind, by) => { if (kind === 'deflection' && by === gk) fumbled = true; return orig(f, v, sp, kind, by); };
    for (let i = 0; i < 90 && sim.ball.holder !== gk; i++) frame();
    if (sim.ball.holder === gk || fumbled) { pickups++; if (fumbled) fumbles++; }
  }
  assert.ok(pickups >= 40, `the keeper reached the ball (${pickups})`);
  assert.equal(fumbles, 0, `and never bobbled it (${fumbles}/${pickups})`);
});
