/**
 * Controls, end to end: a real keyboard event all the way to a match action.
 *
 * The existing tests drove Input2D by poking `input.down` directly, which skips
 * the KEYMAP and the window listeners entirely - so a break anywhere in the real
 * keyboard path would pass every test and still leave the player unable to shoot
 * or pass. These tests dispatch actual key events instead.
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
/** Dispatch a real key event through the listeners Input2D registered. */
const fire = (type, code) => {
  for (const f of (listeners[type] || [])) f({ code, preventDefault() {} });
};

const { generateLeague } = await import('../src/data/Teams.js');
const { getProfile } = await import('../src/rules/RuleProfiles.js');
const { MatchSim, ASSIST_PROFILE } = await import('../src/core/MatchSim.js');
const { MATCH_STATE } = await import('../src/rules/RulesEngine.js');
const { Input2D } = await import('../src/ui/Input2D.js');

const league = generateLeague();

/** A live match with the ball in the user's hands, driven through real keys. */
function withBall(seed = 7) {
  const sim = new MatchSim({
    profile: getProfile('arcade'), league, homeId: 'tidal', awayId: 'kraken',
    seed, difficulty: 'national', assist: ASSIST_PROFILE.STANDARD,
    refereeProfile: 'standard', userSide: 'home',
  });
  sim.start();
  const input = new Input2D(sim, { renderer: { flip: false } });
  const frame = (dt = 1 / 60) => { sim.userCommand = input.update(dt); sim.update(dt); };
  for (let i = 0; i < 1500 && sim.state !== MATCH_STATE.LIVE; i++) frame();

  const me = sim.activeAthletes('home').find((a) => !a.isGoalkeeper);
  const give = () => {
    sim.setUserAthlete(me);
    if (!me.hasBall) sim._giveBall(me);
    me.actionLock = 0;
    me.justCaught = 0;
  };
  give();
  for (let i = 0; i < 30; i++) frame();
  give();
  return { sim, input, frame, me, give };
}

test('the match reaches live play so the controls can be exercised', () => {
  const { sim, me } = withBall();
  assert.equal(sim.state, MATCH_STATE.LIVE);
  assert.ok(me.hasBall, 'the user athlete is holding the ball');
  assert.equal(sim.userAthlete, me, 'and is the one under control');
});

test('pressing PASS (Z) actually releases the ball', () => {
  const { sim, frame, give } = withBall();
  give();
  const before = sim.stats.home.passesAttempted;
  fire('keydown', 'KeyZ'); frame(); fire('keyup', 'KeyZ'); frame();
  assert.ok(sim.stats.home.passesAttempted > before,
    'a key press produced a pass attempt');
});

test('LOB PASS (C) throws a genuinely lofted ball', () => {
  const { sim, frame, give } = withBall(31);
  give();
  const before = sim.stats.home.passesAttempted;
  fire('keydown', 'KeyC'); frame(); fire('keyup', 'KeyC');
  assert.ok(sim.stats.home.passesAttempted > before, 'C threw a pass');
  // A lob must actually leave the water, unlike a flat pass.
  let peak = 0;
  for (let i = 0; i < 90; i++) { frame(); peak = Math.max(peak, sim.ball.pos.y); }
  assert.ok(peak > 0.9, `the lob was lofted (peak ${peak.toFixed(2)}m)`);
});

test('SHOOT works on both X and Space', () => {
  for (const code of ['KeyX', 'Space']) {
    const { sim, frame, give } = withBall(11);
    give();
    const before = sim.stats.home.shots;
    fire('keydown', code);
    for (let i = 0; i < 30; i++) frame();
    fire('keyup', code); frame();
    assert.ok(sim.stats.home.shots > before, `${code} produced a shot`);
  }
});

test('a pass is not caught straight back by the player who threw it', () => {
  // The regression: tryPass never set a catch cooldown on the passer, so the
  // passer - by definition the closest athlete to the ball the moment it leaves
  // their hand - immediately re-caught it. Six passes in ten went nowhere.
  const { sim, frame, me, give } = withBall(21);
  let selfCaught = 0, thrown = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    give();
    for (let i = 0; i < 20; i++) frame();
    give();
    const before = sim.stats.home.passesAttempted;
    fire('keydown', 'KeyJ'); frame(); fire('keyup', 'KeyJ');
    if (sim.stats.home.passesAttempted === before) continue;
    thrown++;
    for (let i = 0; i < 45; i++) {
      frame();
      if (sim.ball.holder) break;
    }
    if (sim.ball.holder === me) selfCaught++;
  }
  assert.ok(thrown >= 5, `passes were thrown (${thrown})`);
  assert.ok(selfCaught / thrown < 0.35,
    `the passer rarely re-catches their own pass (${selfCaught}/${thrown})`);
});

test('every mapped control key reaches the input layer', () => {
  const { input } = withBall();
  const keys = {
    KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
    Space: 'action1', KeyX: 'action1', KeyZ: 'action2', KeyC: 'lob', KeyL: 'action3',
    ShiftLeft: 'sprint', KeyE: 'switch', KeyQ: 'modifier', KeyG: 'gk',
  };
  for (const [code, action] of Object.entries(keys)) {
    fire('keydown', code);
    assert.ok(input.isDown(action), `${code} registers as "${action}"`);
    fire('keyup', code);
    assert.ok(!input.isDown(action), `${code} clears on release`);
  }
});

test('Z raises the arm when defending', () => {
  const { sim, input, frame, me } = withBall(41);
  // Hand the ball to the other side so our athlete is defending.
  const theirs = sim.activeAthletes('away').find((a) => !a.isGoalkeeper);
  sim._giveBall(theirs);
  sim.setUserAthlete(me);
  for (let i = 0; i < 5; i++) frame();

  fire('keydown', 'KeyZ');
  for (let i = 0; i < 5; i++) frame();
  assert.ok(input.isDown('action2'), 'Z is registering');
  assert.ok(me.blockTimer > 0, 'holding Z raises the arm to block');
  fire('keyup', 'KeyZ');
});

test('SPACE commits a foul when defending, and position decides what it costs', () => {
  // In front of your man it is an ordinary foul; from behind him it is an
  // exclusion. Driven through a real SPACE key, not by poking the input state.
  for (const [where, side, expected] of [['in front', 1, 'ordinary'], ['behind', -1, 'exclusion']]) {
    const { sim, frame, me } = withBall(63);
    const theirs = sim.activeAthletes('away').find((a) => !a.isGoalkeeper);
    sim._giveBall(theirs);
    sim.setUserAthlete(me);
    // Clear everyone else so the man we are marking is unambiguous.
    for (const s of ['home', 'away']) {
      for (const a of sim.activeAthletes(s)) {
        if (a === me || a === theirs || a.isGoalkeeper) continue;
        a.pos.x = 13; a.pos.z = 0; a.vel.set(0, 0);
      }
    }
    theirs.pos.x = 0; theirs.pos.z = 0; theirs.vel.set(0, 0);
    me.pos.x = 0; me.pos.z = theirs.attackDir * side * 1.0; me.vel.set(0, 0);
    me.actionLock = 0; me.foulCooldown = 0;

    let type = null;
    sim.bus.on('foul', ({ foul }) => { type = type ?? foul.type; });
    fire('keydown', 'Space');
    frame();
    fire('keyup', 'Space');
    for (let i = 0; i < 10 && !type; i++) frame();

    assert.equal(type, expected, `SPACE ${where} of your man gives a ${expected} foul (got ${type})`);
  }
});

test('SPACE still shoots when you have the ball', () => {
  // The same key does both jobs; they must never collide.
  const { sim, frame, give, me } = withBall(64);
  give();
  let shot = false;
  sim.bus.on('shot', () => { shot = true; });
  fire('keydown', 'Space');
  for (let i = 0; i < 12 && !shot; i++) frame();
  fire('keyup', 'Space');
  assert.ok(shot, 'SPACE shoots while holding the ball');
  assert.ok(!me.hasBall, 'and the ball has left the hand');
});

test('a direct pass (Z) is flat, and only the lob (C) arcs', () => {
  const { sim, frame, give } = withBall(65);
  const apex = { direct: [], lob: [] };
  for (const [key, label] of [['KeyZ', 'direct'], ['KeyC', 'lob']]) {
    for (let n = 0; n < 12; n++) {
      give();
      let vy = null, y0 = null;
      sim.bus.on('pass', () => { vy = sim.ball.vel.y; y0 = sim.ball.pos.y; });
      fire('keydown', 'KeyD');
      fire('keydown', key);
      frame();
      fire('keyup', key);
      fire('keyup', 'KeyD');
      for (let i = 0; i < 4 && vy === null; i++) frame();
      if (vy !== null) apex[label].push(y0 + Math.max(0, vy) ** 2 / (2 * 9.81));
      for (let i = 0; i < 20; i++) frame();
    }
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  assert.ok(apex.direct.length >= 5 && apex.lob.length >= 5, 'both pass types were thrown');
  const d = mean(apex.direct), l = mean(apex.lob);
  // A long pass has to arc about a metre to arrive at all: at the pass speed
  // cap, a flatter ball than this simply lands in the water short of the man.
  // What matters is that it is nothing like the lob, which is checked below.
  assert.ok(d < 2.0, `a direct pass stays flat (peaks ${d.toFixed(2)}m)`);
  assert.ok(l > d * 1.8, `the lob is clearly a lob next to it (${l.toFixed(2)}m vs ${d.toFixed(2)}m)`);
});
