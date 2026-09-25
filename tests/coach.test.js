/**
 * Coach Career: the manager's decisions reach the pool.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { generateLeague } = await import('../src/data/Teams.js');
const { getProfile } = await import('../src/rules/RuleProfiles.js');
const { MatchSim, ASSIST_PROFILE } = await import('../src/core/MatchSim.js');
const { MATCH_STATE } = await import('../src/rules/RulesEngine.js');
const await_mc = await import('../src/modes/ManagerCareer.js');
const { ManagerCareer } = await_mc;

const mk = (league, opts = {}) => new MatchSim({
  profile: getProfile(opts.profile ?? 'arcade'), league, homeId: 'tidal', awayId: 'kraken',
  seed: opts.seed ?? 1, difficulty: 'national', assist: ASSIST_PROFILE.STANDARD,
  refereeProfile: 'standard', userSide: opts.userSide ?? 'home', lineups: opts.lineups,
});

test('the starting seven you pick is the seven that plays', () => {
  const league = generateLeague();
  const c = new ManagerCareer(league, 'tidal');
  const seven = c.startingSeven();
  const benchMan = c.squad.find((p) => !seven.includes(p) && p.position !== 'GK');
  const out = seven.find((p) => p.position !== 'GK');
  assert.deepEqual(c.swapStarter(benchMan.id, out.id), { ok: true });

  const sim = mk(league, { lineups: { home: c.startingSeven().map((p) => p.id) } });
  const ids = sim.active.home.map((a) => a.player.id);
  assert.ok(ids.includes(benchMan.id), 'your pick starts');
  assert.ok(!ids.includes(out.id), 'the man you dropped does not');
  assert.equal(ids.length, 7);
  assert.equal(c.serialise().lineup.length, 7, 'and the choice is saved with the career');
});

test('the seven is always legal: one keeper, nobody injured, never short', () => {
  const league = generateLeague();
  const c = new ManagerCareer(league, 'tidal');
  const gkBench = c.squad.find((p) => p.position === 'GK' && !c.startingSeven().includes(p));
  const fieldStarter = c.startingSeven().find((p) => p.position !== 'GK');
  assert.equal(c.swapStarter(gkBench.id, fieldStarter.id).reason, 'goalkeeperForGoalkeeper');

  const hurt = c.startingSeven()[3];
  c.state[hurt.id].injuryWeeks = 2;
  const after = c.startingSeven();
  assert.ok(!after.includes(hurt), 'an injured starter is replaced for the match');
  assert.equal(after.length, 7);
  assert.equal(after.filter((p) => p.position === 'GK').length, 1);

  // A nonsense lineup can never field six players or two keepers.
  assert.equal(mk(league, { lineups: { home: ['x'] } }).active.home.length, 7);
});

test('substitutions actually happen', () => {
  // The rule was handed the count BEFORE the outgoing player left, so every
  // outfield swap read as an eighth player: 0 of 134 AI substitutions went in.
  let made = 0, refused = 0;
  for (let m = 0; m < 3; m++) {
    const sim = mk(generateLeague(90000 + m), { profile: 'arcade-10', seed: 96000 + m, userSide: null });
    sim.bus.on('substitution', () => made++);
    sim.bus.on('substitutionRejected', () => refused++);
    sim.start();
    for (let i = 0; i < 60 * 60 * 30 && sim.state !== MATCH_STATE.MATCH_END; i++) sim.update(1 / 60);
  }
  assert.ok(made > 5, `tired players come off (${made} substitutions)`);
  assert.equal(refused, 0, 'and none is refused as a full squad');
});

test('your substitution is made at once, or at the next stoppage', () => {
  const league = generateLeague();
  const sim = mk(league, { seed: 7 });
  sim.start();
  for (let i = 0; i < 3000 && !sim.isLive(); i++) sim.update(1 / 60);
  for (let i = 0; i < 60; i++) sim.update(1 / 60);
  const out = sim.active.home.find((a) => !a.isGoalkeeper && Math.abs(a.pos.z) < 6);
  const sub = sim.bench.home.find((a) => !a.isGoalkeeper);
  const r = sim.userSubstitution('home', out.player.id, sub.player.id);
  assert.equal(r.ok, true);
  if (r.when === 'nextStoppage') {
    for (let i = 0; i < 60 * 90 && sim.pendingSubs.length; i++) sim.update(1 / 60);
  }
  assert.ok(sim.active.home.includes(sub), 'he came on');
  assert.ok(!sim.active.home.includes(out), 'and the other came off');
  assert.equal(sim.active.home.length, 7);
  const gk = sim.active.home.find((a) => a.isGoalkeeper);
  const field = sim.bench.home.find((a) => !a.isGoalkeeper);
  assert.equal(sim.userSubstitution('home', gk.player.id, field.player.id).reason, 'goalkeeperForGoalkeeper');
});

test('the transfer market has players worth buying, at prices that force a choice', () => {
  // Every target used to be 50-56 overall at ~$5,000: nobody on it would make
  // any team in the league, and it cost nothing against a $150k budget.
  const { ManagerCareer: MC, marketValue } = await_mc;
  const c = new MC(generateLeague(), 'zephyr');
  const ovr = c.market.map((p) => p.overall);
  const weakestStarter = Math.min(...c.startingSeven().map((p) => p.overall));
  assert.ok(Math.max(...ovr) > weakestStarter, `the best target (${Math.max(...ovr)}) would start for the weakest club (worst starter ${weakestStarter})`);
  assert.ok(ovr.filter((o) => o >= 80).length >= 2, 'there are stars');
  assert.ok(c.market.some((p) => p.age <= 21 && p.pot10 >= 8), 'and young prospects with real potential');
  const star = c.market[0];
  assert.ok(star.askingPrice > c.board.budget * 0.45, `a star costs a big share of the budget ($${star.askingPrice} of $${c.board.budget})`);
  assert.ok(marketValue({ overall: 90, age: 26 }) > marketValue({ overall: 80, age: 26 }) * 2.5, 'the price curve is steep');
});

test('you can sell for a fee, but never below eleven players or your last keeper', () => {
  const { ManagerCareer: MC } = await_mc;
  const c = new MC(generateLeague(), 'tidal');
  const before = c.board.budget;
  const p = [...c.squad].sort((a, b) => a.overall - b.overall).find((q) => q.position !== 'GK');
  const r = c.sellPlayer(p.id);
  assert.ok(r.ok && r.fee > 0 && c.board.budget === before + r.fee, 'a sale raises money');
  assert.ok(!c.squad.includes(p));
  while (c.squad.length > 11) {
    const q = c.squad.find((x) => x.position !== 'GK');
    c.sellPlayer(q.id);
  }
  const lastField = c.squad.find((x) => x.position !== 'GK');
  assert.equal(c.sellPlayer(lastField.id).reason, 'squadTooSmall');
  assert.equal(c.startingSeven().length, 7, 'the seven repairs itself after sales');
});
