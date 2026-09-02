/**
 * AQUAPIX Player Career - you ARE a water polo player.
 *
 * A light, fun life-sim between matches (the brief: money, working out, your life
 * in a menu, then the games you play). Each week you pick one life activity, then
 * play your club's fixture as your own athlete. Train to raise your stats, manage
 * energy and morale, earn and spend money, keep your manager happy to keep your
 * place, and chase contracts as your reputation grows.
 */

import { Rng, clamp, clamp01, lerp } from '../core/Math2.js';
import { TEAMS } from '../data/Teams.js';
import { ALL_ATTRIBUTES, ATTRIBUTE_GROUPS, POSITIONS, POSITION_NAMES, overallFor, TRAITS } from '../data/Attributes.js';
import { simulateByStars } from './SimResult.js';

const FIRST = ['Alex', 'Sam', 'Nico', 'Luca', 'Kai', 'Marco', 'Theo', 'Emil', 'Dario', 'Vito', 'Rafa', 'Milo', 'Bo', 'Ivo', 'Sven', 'Remy'];
const LAST = ['Marsh', 'Vega', 'Kane', 'Ferro', 'Dane', 'Roka', 'Sol', 'Vance', 'Rios', 'Adler', 'Meyer', 'Falk', 'Cruz', 'Nash'];

/** Weekly life activities (light-and-fun). */
export const ACTIVITIES = {
  trainPhysical: { name: 'Train: Swim & Power', desc: 'Raise physical stats. Costs energy.', energy: -28, morale: -2, money: 0, group: 'physical' },
  trainTechnical: { name: 'Train: Ball & Shooting', desc: 'Raise ball and shooting stats. Costs energy.', energy: -26, morale: -1, money: 0, group: 'shootBall' },
  trainDefensive: { name: 'Train: Defence & Tactics', desc: 'Raise defensive and mental stats. Costs energy.', energy: -24, morale: -1, money: 0, group: 'defMental' },
  gym: { name: 'Recovery & Gym', desc: 'Restore energy and reduce injury risk.', energy: +18, morale: +1, money: -60, group: null },
  rest: { name: 'Rest', desc: 'Fully recharge energy. No training.', energy: +40, morale: +3, money: 0, group: null },
  media: { name: 'Media & Appearances', desc: 'Earn money and reputation. Tiring.', energy: -14, morale: -2, money: 900, rep: 2, group: null },
  social: { name: 'See Friends & Relax', desc: 'Boost morale. Small cost.', energy: -6, morale: +12, money: -120, group: null },
  sponsor: { name: 'Sponsor Event', desc: 'Good money and reputation if your form is high.', energy: -16, morale: +2, money: 1500, rep: 3, group: null, needsForm: true },
};

/** Shop items - simple, fun boosts. */
export const SHOP = [
  { id: 'goggles', name: 'Pro Goggles', cost: 400, desc: '+2 to shot placement.', apply: (p) => bump(p, 'shotPlacement', 2) },
  { id: 'cap', name: 'Lucky Cap', cost: 300, desc: '+3 morale each week.', weekly: (c) => { c.morale = clamp(c.morale + 3, 0, 100); } },
  { id: 'diet', name: 'Nutritionist Plan', cost: 1200, desc: 'Energy costs reduced 20%.', flag: 'diet' },
  { id: 'trainer', name: 'Personal Trainer', cost: 2000, desc: 'Training gains +50%.', flag: 'trainer' },
  { id: 'physio', name: 'Private Physio', cost: 1600, desc: 'Halves injury length & risk.', flag: 'physio' },
  { id: 'apartment', name: 'Nicer Apartment', cost: 3500, desc: 'Rent up, but +5 morale weekly.', weekly: (c) => { c.morale = clamp(c.morale + 5, 0, 100); }, rent: 120 },
  { id: 'car', name: 'A Decent Car', cost: 5000, desc: 'Reputation +8. Status symbol.', once: (c) => { c.reputation += 8; } },
];

const LIFE_EVENTS = [
  { text: 'A local kid asks for your autograph. Morale up.', morale: +4 },
  { text: 'Tabloid rumour about your form. Morale down.', morale: -6 },
  { text: 'Great night out with teammates. Morale up, a little tired.', morale: +6, energy: -8 },
  { text: 'Coach praised your work rate in training.', morale: +5, rep: +1 },
  { text: 'Minor cold going round the squad. Energy down.', energy: -12 },
  { text: 'You went viral for a training-ground skip shot!', rep: +3, morale: +4 },
  { text: 'Unexpected bonus from the club.', money: +700 },
  { text: 'Car trouble. Unexpected bill.', money: -400 },
];

function bump(player, attr, n) { player.attr[attr] = clamp(player.attr[attr] + n, 1, 99); player.overall = overallFor(player); }

export class PlayerCareer {
  /**
   * @param {object} league  career-local league copy (rosters get your player)
   * @param {object} create  { name, position, clubId }
   * @param {number} seed
   */
  constructor(league, create, seed = Date.now() & 0xffffffff) {
    this.league = league;
    this.rng = new Rng(seed);
    this.clubId = create.clubId;
    this.season = 1;
    this.week = 0;

    // --- Your player ------------------------------------------------------
    this.me = this._buildMe(create);
    // Add yourself to the club roster so the match engine fields you.
    const roster = league.rosters[this.clubId];
    this.me.capNumber = nextCap(roster);
    roster.push(this.me);

    // --- Life state -------------------------------------------------------
    this.money = 500;
    this.energy = 100;
    this.morale = 70;
    this.reputation = 20;
    this.fitness = 100;
    this.injuryWeeks = 0;
    this.form = 1.0;
    this.seasonRating = [];
    this.items = new Set();
    this.rent = 90;
    this.news = [];
    this.appearances = 0;
    this.goals = 0;
    this.assists = 0;
    this.motm = 0;

    // --- Contract ---------------------------------------------------------
    this.contract = { club: this.clubId, weeksLeft: 34, wage: 700 };

    // --- Fixtures & table (reuse a simple round-robin) --------------------
    this.fixtures = buildFixtures(TEAMS.map((t) => t.id), this.rng);
    this.table = {};
    for (const t of TEAMS) this.table[t.id] = { id: t.id, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, pts: 0 };
    this.results = [];
    this.pendingActivity = null;
    this.lastMatch = null;

    this.pushNews(`You signed for ${this.club.name}. Show them what you've got.`);
  }

  get club() { return TEAMS.find((t) => t.id === this.clubId); }
  get roster() { return this.league.rosters[this.clubId]; }

  _buildMe(create) {
    const pos = create.position ?? 'DR';
    const rng = this.rng;
    const attr = {};
    for (const a of ALL_ATTRIBUTES) attr[a] = Math.round(clamp(rng.gauss(52, 8), 30, 70));
    // Small bump to your position's key stats so you feel like that position.
    const key = {
      GK: ['reactionSpeed', 'setPositioning', 'lateralMovement', 'verticalExplosion'],
      CF: ['upperStrength', 'leverage', 'backhand', 'shootUnderContact'],
      CD: ['centreDefence', 'fronting', 'legalLeverage', 'marking'],
      DR: ['swimSpeed', 'firstStroke', 'changeOfDirection', 'workRate'],
      WG: ['shotPlacement', 'skipControl', 'quickRelease', 'oneHandCatch'],
      PT: ['vision', 'entryPass', 'longPass', 'tacticalAwareness'],
      UT: ['adaptability', 'endurance', 'workRate'],
    }[pos] ?? [];
    for (const k of key) attr[k] = Math.round(clamp(attr[k] + rng.range(6, 14), 30, 78));

    const me = {
      id: 'ME', teamId: this.clubId, isUser: true,
      firstName: create.name?.split(' ')[0] ?? 'Alex',
      lastName: create.name?.split(' ').slice(1).join(' ') || rng.pick(LAST),
      position: pos, secondaryPosition: null,
      leftHanded: !!create.leftHanded,
      height: rng.int(182, 200), age: 18,
      attr, traits: [], form: 1, morale: 0.7, condition: 1,
      potential: rng.int(82, 94),
      contractYears: 2, wage: 700,
    };
    me.name = `${me.firstName} ${me.lastName}`;
    me.overall = overallFor(me);
    return me;
  }

  pushNews(text) { this.news.unshift({ text, week: this.week, season: this.season }); if (this.news.length > 40) this.news.pop(); }

  currentFixture() {
    const round = this.fixtures[this.week];
    if (!round) return null;
    return round.find((f) => f.home === this.clubId || f.away === this.clubId) ?? null;
  }
  isHome() { const fx = this.currentFixture(); return fx && fx.home === this.clubId; }

  hasItem(id) { return this.items.has(id); }
  flag(f) { return [...this.items].some((id) => SHOP.find((s) => s.id === id)?.flag === f); }

  // ---- Activities --------------------------------------------------------
  chooseActivity(key) {
    if (this.pendingActivity) return { ok: false, reason: 'alreadyChosen' };
    const act = ACTIVITIES[key];
    if (!act) return { ok: false, reason: 'unknown' };
    if (act.needsForm && this.form < 1.0) return { ok: false, reason: 'formTooLow' };
    if (act.money < 0 && this.money + act.money < 0) return { ok: false, reason: 'noMoney' };
    this.pendingActivity = key;
    return { ok: true };
  }

  _applyActivity() {
    const key = this.pendingActivity;
    this.pendingActivity = null;
    if (!key) return;
    const act = ACTIVITIES[key];
    const dietMul = this.flag('diet') ? 0.8 : 1;
    let energyCost = act.energy;
    if (energyCost < 0) energyCost *= dietMul;
    this.energy = clamp(this.energy + energyCost, 0, 100);
    this.morale = clamp(this.morale + (act.morale ?? 0), 0, 100);
    this.money += act.money ?? 0;
    if (act.rep) this.reputation += act.rep * (act.needsForm ? Math.max(1, this.form) : 1);

    // Training develops stats in the chosen group, gated by potential and energy.
    if (act.group) {
      const gain = this._train(act.group);
      if (gain.length) this.pushNews(`Training paid off: ${gain.join(', ')}.`);
    }
    if (key === 'media' || key === 'sponsor') this.pushNews(`You earned ${act.money} from an appearance.`);
  }

  _train(group) {
    const attrs = {
      physical: ['swimSpeed', 'firstStroke', 'endurance', 'burstStamina', 'legPower', 'explosiveness', 'upperStrength'],
      shootBall: ['shotPower', 'shotPlacement', 'skipControl', 'releaseSpeed', 'ballSecurity', 'oneHandCatch', 'quickRelease'],
      defMental: ['marking', 'centreDefence', 'blockTiming', 'anticipation', 'decisionMaking', 'tacticalAwareness', 'foulDiscipline'],
    }[group] ?? [];
    const room = this.me.potential - this.me.overall;
    if (room <= 0) return [];
    const trainerMul = this.flag('trainer') ? 1.5 : 1;
    const energyMul = clamp01(this.energy / 60);              // tired training is weak
    const youth = clamp01((26 - this.me.age) / 10);
    const before = { ...this.me.attr };
    const improved = [];
    for (const attr of attrs) {
      const chance = 0.5 * trainerMul * (0.4 + energyMul * 0.6) * (0.5 + youth) * clamp01(room / 10);
      if (this.rng.chance(chance) && this.me.attr[attr] < this.me.potential) {
        this.me.attr[attr] = Math.min(99, this.me.attr[attr] + 1);
        improved.push(shortName(attr));
      }
    }
    this.me.overall = overallFor(this.me);
    return improved;
  }

  // ---- Match integration -------------------------------------------------
  /** Is the user selected to start? Manager picks by form & overall vs squad. */
  managerVerdict() {
    const others = this.roster.filter((p) => p.id !== 'ME' && p.position === this.me.position);
    const rivalBest = others.sort((a, b) => b.overall - a.overall)[0];
    const myScore = this.me.overall + (this.form - 1) * 30 + this.morale * 0.05;
    const rivalScore = rivalBest ? rivalBest.overall : 0;
    if (this.injuryWeeks > 0) return { starts: false, reason: 'injured' };
    if (myScore >= rivalScore - 2) return { starts: true, reason: 'selected' };
    return { starts: false, reason: 'benched' };
  }

  /** Apply the result of a match you played. */
  applyMyMatch(myStats, teamResult) {
    this.appearances++;
    this.goals += myStats.goals;
    this.assists += myStats.assists;

    // Match rating out of 10, from your contribution and the result.
    let rating = 6.0;
    rating += myStats.goals * 1.1 + myStats.assists * 0.7 + myStats.steals * 0.25 + myStats.blocks * 0.2 + myStats.saves * 0.12;
    rating -= myStats.turnovers * 0.15 + myStats.personalFouls * 0.2;
    if (teamResult === 'win') rating += 0.6; else if (teamResult === 'loss') rating -= 0.4;
    rating = clamp(rating, 2, 10);
    this.seasonRating.push(rating);
    const motm = rating >= 8.2;
    if (motm) this.motm++;

    // Form is a rolling average of recent ratings.
    const recent = this.seasonRating.slice(-4);
    this.form = clamp(0.7 + (recent.reduce((s, r) => s + r, 0) / recent.length - 6) * 0.12, 0.7, 1.35);
    this.morale = clamp(this.morale + (rating - 6) * 3, 0, 100);
    this.reputation += clamp((rating - 6) * 0.8, -2, 4);

    // Match fee + potential win bonus.
    const fee = this.contract.wage + (teamResult === 'win' ? 300 : 0) + myStats.goals * 120;
    this.money += fee;

    this.pushNews(`You rated ${rating.toFixed(1)}${motm ? ' - Man of the Match!' : ''} (${myStats.goals}G ${myStats.assists}A). Earned ${fee}.`);
    this.lastMatch = { rating, motm, ...myStats, fee, result: teamResult };
    return { rating, motm };
  }

  /** Resolve every other fixture in the round with a light model. */
  resolveOtherFixtures(myFixtureResult) {
    const round = this.fixtures[this.week];
    if (!round) return;
    for (const fx of round) {
      const isMine = fx.home === this.clubId || fx.away === this.clubId;
      const res = isMine && myFixtureResult ? myFixtureResult : this._quickResolve(fx);
      this._applyResult(fx, res);
    }
  }

  _quickResolve(fx) {
    // Star-based, with a one-in-four upset, matching the sim rules elsewhere.
    const res = simulateByStars(this.league.rosters[fx.home], this.league.rosters[fx.away], this.rng);
    return { home: res.home, away: res.away, upset: res.upset };
  }

  _applyResult(fx, res) {
    const h = this.table[fx.home], a = this.table[fx.away];
    h.played++; a.played++; h.gf += res.home; h.ga += res.away; a.gf += res.away; a.ga += res.home;
    if (res.home > res.away) { h.won++; a.lost++; h.pts += 3; }
    else if (res.home < res.away) { a.won++; h.lost++; a.pts += 3; }
    else { h.drawn++; a.drawn++; h.pts++; a.pts++; }
    this.results.push({ week: this.week, ...fx, ...res });
  }

  // ---- Weekly advance ----------------------------------------------------
  advanceWeek() {
    // Weekly upkeep: rent, contract, morale item effects, natural energy drift.
    this.money -= this.rent;
    for (const id of this.items) {
      const item = SHOP.find((s) => s.id === id);
      item?.weekly?.(this);
    }
    this.energy = clamp(this.energy + 6, 0, 100);   // baseline recovery
    if (this.injuryWeeks > 0) { this.injuryWeeks--; if (this.injuryWeeks === 0) this.pushNews('You are fit again.'); }
    if (this.contract.weeksLeft > 0) this.contract.weeksLeft--;

    // Random life event (sometimes).
    if (this.rng.chance(0.5)) {
      const ev = this.rng.pick(LIFE_EVENTS);
      this.morale = clamp(this.morale + (ev.morale ?? 0), 0, 100);
      this.energy = clamp(this.energy + (ev.energy ?? 0), 0, 100);
      this.money += ev.money ?? 0;
      this.reputation += ev.rep ?? 0;
      this.pushNews(ev.text);
    }

    // Injury from low fitness/energy during a match week already handled; small
    // random niggle if chronically exhausted.
    if (this.energy < 15 && this.rng.chance(0.2) && this.injuryWeeks === 0) {
      this.injuryWeeks = this.flag('physio') ? 1 : this.rng.int(1, 3);
      this.pushNews(`You picked up a strain from overtraining - out ${this.injuryWeeks} week(s).`);
    }

    this.week++;
    this.me.form = this.form;
    if (this.week >= this.fixtures.length) this._endSeason();
    else if (this.contract.weeksLeft <= 0) this._offerContract();
  }

  buyItem(id) {
    const item = SHOP.find((s) => s.id === id);
    if (!item) return { ok: false, reason: 'unknown' };
    if (this.items.has(id)) return { ok: false, reason: 'owned' };
    if (this.money < item.cost) return { ok: false, reason: 'noMoney' };
    this.money -= item.cost;
    this.items.add(id);
    if (item.rent) this.rent += item.rent;
    item.apply?.(this.me);
    item.once?.(this);
    this.pushNews(`Bought ${item.name}.`);
    return { ok: true };
  }

  _offerContract() {
    // Renewal from current club, wage scaled by reputation and overall.
    const wage = Math.round((this.me.overall * 10 + this.reputation * 8) / 10) * 10;
    this.contractOffer = { club: this.clubId, weeksLeft: 34, wage, from: this.club.name };
    // A rival club may bid if your reputation is high enough.
    if (this.reputation > 55) {
      const rivals = TEAMS.filter((t) => t.id !== this.clubId).sort((a, b) => b.prestige - a.prestige);
      const rival = rivals[this.rng.int(0, 2)];
      this.transferOffer = { club: rival.id, weeksLeft: 34, wage: Math.round(wage * 1.25), from: rival.name };
    }
    this.pushNews('Your contract is up. Review your offers.');
  }

  acceptOffer(which) {
    const offer = which === 'transfer' ? this.transferOffer : this.contractOffer;
    if (!offer) return { ok: false };
    if (offer.club !== this.clubId) {
      // Move clubs: remove yourself from old roster, add to new.
      const old = this.league.rosters[this.clubId];
      const i = old.findIndex((p) => p.id === 'ME');
      if (i >= 0) old.splice(i, 1);
      this.clubId = offer.club;
      this.me.teamId = offer.club;
      this.me.capNumber = nextCap(this.league.rosters[offer.club]);
      this.league.rosters[offer.club].push(this.me);
      this.pushNews(`You transferred to ${offer.from}!`);
    } else {
      this.pushNews(`You re-signed with ${offer.from}.`);
    }
    this.contract = { club: this.clubId, weeksLeft: offer.weeksLeft, wage: offer.wage };
    this.contractOffer = null; this.transferOffer = null;
    return { ok: true };
  }

  _endSeason() {
    const table = this.standings();
    const pos = table.findIndex((t) => t.id === this.clubId) + 1;
    const avg = this.seasonRating.length ? (this.seasonRating.reduce((s, r) => s + r, 0) / this.seasonRating.length) : 6;
    this.seasonSummary = { pos, avgRating: avg, goals: this.goals, assists: this.assists, motm: this.motm, appearances: this.appearances };
    this.pushNews(`Season ${this.season} done. ${this.club.short} finished ${ordinal(pos)}. You averaged ${avg.toFixed(1)}.`);
    this.finished = true;
    if (this.contract.weeksLeft <= 0) this._offerContract();
  }

  startNextSeason() {
    this.season++; this.week = 0; this.finished = false; this.seasonSummary = null;
    this.me.age++;
    this.goals = 0; this.assists = 0; this.motm = 0; this.appearances = 0; this.seasonRating = [];
    this.fixtures = buildFixtures(TEAMS.map((t) => t.id), this.rng);
    for (const t of TEAMS) this.table[t.id] = { id: t.id, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, pts: 0 };
    this.results = [];
    // Aging: gentle decline after 30 for physicals.
    if (this.me.age > 30) {
      for (const k of ['swimSpeed', 'firstStroke', 'explosiveness', 'burstStamina']) if (this.rng.chance(0.4)) bump(this.me, k, -1);
    }
    this.pushNews(`Season ${this.season} begins. You are ${this.me.age}.`);
  }

  standings() {
    return Object.values(this.table).sort((a, b) => b.pts - a.pts || (b.gf - b.ga) - (a.gf - a.ga) || b.gf - a.gf);
  }

  seasonAvgRating() {
    return this.seasonRating.length ? this.seasonRating.reduce((s, r) => s + r, 0) / this.seasonRating.length : 0;
  }

  serialise() {
    return {
      version: 1, clubId: this.clubId, season: this.season, week: this.week,
      me: this.me, money: this.money, energy: this.energy, morale: this.morale,
      reputation: this.reputation, fitness: this.fitness, injuryWeeks: this.injuryWeeks,
      form: this.form, seasonRating: this.seasonRating, items: [...this.items], rent: this.rent,
      news: this.news, appearances: this.appearances, goals: this.goals, assists: this.assists, motm: this.motm,
      contract: this.contract, contractOffer: this.contractOffer, transferOffer: this.transferOffer,
      fixtures: this.fixtures, table: this.table, results: this.results, rosters: this.league.rosters,
    };
  }

  static restore(league, data) {
    const c = Object.create(PlayerCareer.prototype);
    if (data.rosters) league.rosters = data.rosters;
    Object.assign(c, {
      league, rng: new Rng(12345), clubId: data.clubId, season: data.season, week: data.week,
      me: data.me, money: data.money, energy: data.energy, morale: data.morale, reputation: data.reputation,
      fitness: data.fitness, injuryWeeks: data.injuryWeeks, form: data.form, seasonRating: data.seasonRating,
      items: new Set(data.items), rent: data.rent, news: data.news, appearances: data.appearances,
      goals: data.goals, assists: data.assists, motm: data.motm, contract: data.contract,
      contractOffer: data.contractOffer, transferOffer: data.transferOffer, fixtures: data.fixtures,
      table: data.table, results: data.results, pendingActivity: null, lastMatch: null,
    });
    // Ensure ME is present in the roster.
    const roster = league.rosters[c.clubId];
    if (!roster.some((p) => p.id === 'ME')) roster.push(c.me);
    return c;
  }
}

function nextCap(roster) {
  const used = new Set(roster.map((p) => p.capNumber));
  for (let i = 2; i <= 25; i++) if (!used.has(i)) return i;
  return 25;
}
function shortName(a) { return a.replace(/([A-Z])/g, ' $1').trim().split(' ').slice(0, 2).join(' '); }
function ordinal(n) { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]); }

function buildFixtures(ids, rng) {
  const teams = ids.slice();
  for (let i = teams.length - 1; i > 0; i--) { const j = rng.int(0, i); [teams[i], teams[j]] = [teams[j], teams[i]]; }
  const n = teams.length, rounds = [], arr = teams.slice();
  for (let r = 0; r < n - 1; r++) {
    const round = [];
    for (let i = 0; i < n / 2; i++) {
      const home = arr[i], away = arr[n - 1 - i];
      round.push(r % 2 === 0 ? { home, away } : { home: away, away: home });
    }
    rounds.push(round);
    arr.splice(1, 0, arr.pop());
  }
  const second = rounds.map((r) => r.map((f) => ({ home: f.away, away: f.home })));
  return [...rounds, ...second];
}
