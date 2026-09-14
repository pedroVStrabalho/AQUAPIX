/**
 * Progression economy tests (XP, Fans, Money).
 *
 * The central promise these guard: a player who never watches an advertisement
 * can still progress. Nothing in the economy depends on an ad, so these tests
 * only ever exercise normal play.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GAME_ECONOMY_CONFIG, computeMatchEarnings, applyEarnings, newWallet, levelFromXp,
  computeWeeklyOperations,
} from '../src/modes/Economy.js';
import { generateLeague } from '../src/data/Teams.js';
import { ManagerCareer } from '../src/modes/ManagerCareer.js';

const base = { home: true, fans: 8000, streak: 0 };

test('winning pays more than drawing, which pays more than losing', () => {
  const win = computeMatchEarnings({ ...base, scored: 6, conceded: 3 });
  const draw = computeMatchEarnings({ ...base, scored: 4, conceded: 4 });
  const loss = computeMatchEarnings({ ...base, scored: 2, conceded: 5 });

  assert.ok(win.xp > draw.xp && draw.xp > loss.xp, 'XP follows the result');
  assert.ok(win.fans > draw.fans && draw.fans > loss.fans, 'support follows the result');
  assert.ok(win.money > draw.money && draw.money > loss.money, 'money follows the result');
  assert.equal(win.result, 'win');
  assert.ok(loss.fans < 0, 'losing costs you supporters');
});

test('performance inside a win still matters', () => {
  const narrow = computeMatchEarnings({ ...base, scored: 4, conceded: 3 });
  const thrashing = computeMatchEarnings({ ...base, scored: 9, conceded: 0 });
  assert.ok(thrashing.xp > narrow.xp, 'a bigger win is worth more XP');
  assert.ok(thrashing.fans > narrow.fans, 'a statement win wins supporters');
  assert.ok(
    thrashing.lines.some((l) => /clean sheet/i.test(l.label)),
    'a clean sheet is itemised'
  );
});

test('a winning streak multiplies earnings but is capped', () => {
  const single = computeMatchEarnings({ ...base, scored: 5, conceded: 2, streak: 1 });
  const onFire = computeMatchEarnings({ ...base, scored: 5, conceded: 2, streak: 6 });
  const absurd = computeMatchEarnings({ ...base, scored: 5, conceded: 2, streak: 500 });

  assert.ok(onFire.xp > single.xp, 'a run is worth more than a one-off');
  assert.ok(absurd.multiplier <= GAME_ECONOMY_CONFIG.streak.maxMultiplier + 1e-9,
    `the streak multiplier is capped (${absurd.multiplier})`);
});

test('a week of operations costs money every day, not only on match days', () => {
  const week = computeWeeklyOperations({
    squad: new Array(14), squadStars: 4, home: true,
    distanceKm: 0, fans: 12000, capacity: 4200, streak: 0,
  });
  const daily = week.lines.filter((l) => /days ×/.test(l.detail ?? ''));
  assert.ok(daily.length >= 4, 'ordinary days are itemised (wages, pool, medical, admin)');
  assert.ok(week.costs > 0, 'a week costs money');
  assert.ok(
    week.lines.some((l) => /wage/i.test(l.label)),
    'the wage bill is shown'
  );
});

test('an away trip costs more the further you travel, and far trips need a hotel', () => {
  const base = { squad: new Array(14), squadStars: 4, home: false, fans: 12000, capacity: 4200, streak: 0 };
  const local = computeWeeklyOperations({ ...base, distanceKm: 150 });
  const far = computeWeeklyOperations({ ...base, distanceKm: 900 });

  assert.ok(far.costs > local.costs, 'a longer trip costs more');
  assert.ok(!local.lines.some((l) => /overnight/i.test(l.label)), 'a local trip is a day trip');
  assert.ok(far.lines.some((l) => /overnight/i.test(l.label)), 'a long trip needs beds');
});

test('a home fixture takes money at the gate; an away fixture does not', () => {
  const base = { squad: new Array(14), squadStars: 4, fans: 12000, capacity: 4200, streak: 0 };
  const home = computeWeeklyOperations({ ...base, home: true, distanceKm: 0 });
  const away = computeWeeklyOperations({ ...base, home: false, distanceKm: 400 });

  assert.ok(home.attendance > 0, 'people came to the home fixture');
  assert.equal(away.attendance, 0, 'you take no gate on the road');
  assert.ok(home.income > away.income, 'a home week earns more');
  assert.ok(home.net > away.net, 'a home week is worth more than an away trip');
});

test('attendance is capped by the building, however many supporters you have', () => {
  const huge = computeWeeklyOperations({
    squad: new Array(14), squadStars: 4, home: true, distanceKm: 0,
    fans: 500000, capacity: 4200, streak: 0,
  });
  assert.equal(huge.attendance, 4200, 'you cannot admit more people than the pool holds');
});

test('a squad of stars costs more to run than a modest one', () => {
  const base = { squad: new Array(14), home: true, distanceKm: 0, fans: 12000, capacity: 4200, streak: 0 };
  const modest = computeWeeklyOperations({ ...base, squadStars: 2 });
  const galacticos = computeWeeklyOperations({ ...base, squadStars: 5 });
  assert.ok(galacticos.costs > modest.costs, 'stars are paid like stars');
});

test('levels come from accumulated XP and never run backwards', () => {
  const wallet = newWallet({ prestige: 80 });
  assert.equal(wallet.level, 1);
  let last = 0;
  for (let i = 0; i < 40; i++) {
    applyEarnings(wallet, computeMatchEarnings({ ...base, scored: 7, conceded: 1, streak: 0 }));
    assert.ok(wallet.level >= last, 'level never decreases');
    last = wallet.level;
  }
  assert.ok(wallet.level > 1, `sustained winning levels you up (reached ${wallet.level})`);
  const lv = levelFromXp(wallet.xp);
  assert.equal(lv.level, wallet.level, 'level is derivable from raw XP');
});

test('support has a floor: a terrible run cannot wipe out the club', () => {
  const wallet = newWallet({ prestige: 75 });
  for (let i = 0; i < 60; i++) {
    applyEarnings(wallet, computeMatchEarnings({ ...base, scored: 0, conceded: 9, fans: wallet.fans }));
  }
  assert.ok(wallet.fans >= GAME_ECONOMY_CONFIG.fans.floor, 'the diehards remain');
});

// ===========================================================================
test('a coach career awards XP, fans and money as matches are played', () => {
  const league = generateLeague();
  const career = new ManagerCareer(league, 'tidal');

  const startXp = career.wallet.xp;
  const startFans = career.wallet.fans;
  assert.equal(startXp, 0, 'a new manager starts at zero XP');

  // Play a third of a season.
  for (let i = 0; i < 6 && career.round < career.fixtures.length; i++) career.completeRound();

  assert.ok(career.wallet.xp > startXp, `XP accumulated (${career.wallet.xp})`);
  assert.ok(career.wallet.fans !== startFans, 'the supporter base moved');
  assert.ok(career.lastEarnings, 'the last match produced an itemised payout');
  assert.ok(career.lastEarnings.lines.length > 0, 'the payout is itemised for the UI');
});

test('wallet money is the same number as the board budget, always', () => {
  const league = generateLeague();
  const career = new ManagerCareer(league, 'tidal');
  assert.equal(career.wallet.money, career.board.budget);

  career.completeRound();
  assert.equal(career.wallet.money, career.board.budget, 'still in step after a match');

  // A transfer spends from the board budget; the wallet must follow.
  career.board.budget -= 5000;
  assert.equal(career.wallet.money, career.board.budget, 'still in step after spending');
});

test('a career save round-trips the progression wallet', () => {
  const league = generateLeague();
  const career = new ManagerCareer(league, 'tidal');
  for (let i = 0; i < 4; i++) career.completeRound();

  const data = JSON.parse(JSON.stringify(career.serialise()));
  const restored = ManagerCareer.restore(generateLeague(), data);

  assert.equal(restored.wallet.xp, career.wallet.xp, 'XP survives a save');
  assert.equal(restored.wallet.fans, career.wallet.fans, 'fans survive a save');
  assert.equal(restored.wallet.level, career.wallet.level, 'level survives a save');
  assert.equal(restored.wallet.money, restored.board.budget, 'money is still bound to the budget');
});

test('an older save without a wallet still loads', () => {
  const league = generateLeague();
  const career = new ManagerCareer(league, 'tidal');
  const data = JSON.parse(JSON.stringify(career.serialise()));
  delete data.wallet;

  const restored = ManagerCareer.restore(generateLeague(), data);
  assert.ok(restored.wallet, 'a wallet is created for a legacy save');
  assert.equal(restored.wallet.money, restored.board.budget);
});

test('sustained debt costs board confidence and eventually the job', () => {
  const league = generateLeague();
  const career = new ManagerCareer(league, 'tidal');

  // Blow the budget on nothing, the way an over-eager transfer window would.
  career.board.budget = -50000;
  const confidenceBefore = career.board.confidence;

  const limit = GAME_ECONOMY_CONFIG.debt.weeksBeforeSack;
  for (let i = 0; i < limit && career.round < career.fixtures.length; i++) {
    career.completeRound();
  }

  assert.ok(career.board.confidence < confidenceBefore, 'the board loses patience');
  assert.ok(career.weeksInDebt > 0, 'weeks in debt are counted');
  assert.ok(career.sacked, 'the board eventually acts');
});

test('a club that is solvent is never sacked for money', () => {
  const league = generateLeague();
  const career = new ManagerCareer(league, 'tidal');
  for (let i = 0; i < 10 && career.round < career.fixtures.length; i++) career.completeRound();
  assert.equal(career.weeksInDebt, 0, 'a solvent club owes nothing');
  assert.equal(career.sacked, false, 'and keeps its manager');
});

test('travel cost follows real distance between the two clubs', () => {
  const league = generateLeague();
  const career = new ManagerCareer(league, 'tidal');
  let sawAway = false;
  for (let i = 0; i < 8 && career.round < career.fixtures.length; i++) {
    career.completeRound();
    const ops = career.lastOperations;
    if (ops && !ops.home) {
      sawAway = true;
      assert.ok(ops.distanceKm > 0, 'an away trip has a real distance');
      assert.ok(ops.lines.some((l) => /coach/i.test(l.label)), 'the bus is itemised');
    }
  }
  assert.ok(sawAway, 'the fixture list contained an away match');
});

test('recorded results keep club ids and scores separate', () => {
  const league = generateLeague();
  const career = new ManagerCareer(league, 'tidal');
  for (let i = 0; i < 3; i++) career.completeRound();

  assert.ok(career.results.length > 0, 'results were recorded');
  for (const r of career.results) {
    assert.equal(typeof r.homeId, 'string', 'home club id is an id, not a score');
    assert.equal(typeof r.awayId, 'string', 'away club id is an id, not a score');
    assert.equal(typeof r.homeGoals, 'number', 'home goals is a number');
    assert.equal(typeof r.awayGoals, 'number', 'away goals is a number');
    // The bug this guards: spreading the score object over the fixture object
    // replaced the club ids with goal counts, and the league table crashed.
    assert.ok(league.teams.some((t) => t.id === r.homeId), `${r.homeId} is a real club`);
    assert.ok(league.teams.some((t) => t.id === r.awayId), `${r.awayId} is a real club`);
  }
});
