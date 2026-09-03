/**
 * Input shoot-path test - guards against the regression where holding SHOOT did
 * not fire (a brief action lock swallowed the press) or where the shoot latch
 * stuck after the first shot. Drives the real Input2D with a minimal DOM shim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser shims so Input2D can construct headlessly.
globalThis.window = { addEventListener() {}, removeEventListener() {} };
Object.defineProperty(globalThis, 'navigator', { value: { maxTouchPoints: 0 }, configurable: true });
globalThis.document = {
  getElementById() { return null; },
  createElement() { return { style: {}, dataset: {}, addEventListener() {}, appendChild() {}, querySelector() { return { style: {} }; }, querySelectorAll() { return []; }, set innerHTML(v) {} }; },
};

const { generateLeague } = await import('../src/data/Teams.js');
const { getProfile } = await import('../src/rules/RuleProfiles.js');
const { MatchSim } = await import('../src/core/MatchSim.js');
const { Input2D } = await import('../src/ui/Input2D.js');

function liveMatch() {
  const league = generateLeague();
  const sim = new MatchSim({ profile: getProfile('quick-2'), league, homeId: 'tidal', awayId: 'kraken', seed: 7, difficulty: 'national', assist: 'standard', refereeProfile: 'standard', userSide: 'home' });
  sim.start();
  const input = new Input2D(sim, { renderer: { flip: false } });
  const frame = (dt) => { sim.userCommand = input.update(dt); let acc = dt; const s = 1 / 120; while (acc >= s) { sim.update(s); acc -= s; } };
  for (let i = 0; i < 1600 && sim.state !== "live"; i++) frame(1 / 60);
  return { sim, input, frame };
}

test('holding SHOOT fires a shot even with a brief action lock, and the latch resets', () => {
  const { sim, input, frame } = liveMatch();
  assert.equal(sim.state, 'live');
  const me = sim.autoSelectAthlete('home');
  sim.setUserAthlete(me);
  const f = sim.profile.field;

  const fireOnce = (lock) => {
    sim.setUserAthlete(me);
    sim._giveBall(me); me.actionLock = lock;
    me.pos.set(0.3, me.attackDir * (f.length / 2 - 4)); me.heading = me.attackDir > 0 ? 0 : Math.PI; me.shoulder = me.heading;
    const before = sim.record.filter((r) => r.type === 'shot').length;
    input.down.add('action1');
    for (let i = 0; i < 30; i++) frame(1 / 60);
    input.down.delete('action1'); input.released.add('action1');
    for (let i = 0; i < 20; i++) frame(1 / 60);
    return sim.record.filter((r) => r.type === 'shot').length > before;
  };

  assert.ok(fireOnce(0.2), 'first held shot fires despite the action lock');
  assert.equal(input._shootLatch, false, 'the latch resets after release');
  assert.ok(fireOnce(0), 'a second shot fires on the next possession');
});
