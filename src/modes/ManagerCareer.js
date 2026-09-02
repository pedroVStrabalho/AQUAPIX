/**
 * Manager Career (Design Bible section 30).
 *
 * A working season loop: club identity, squad management, lineup selection,
 * tactical identity, training focus, fixtures, table, form, fatigue carrying
 * between matches, injuries, transfers from a free-agent pool, board
 * expectations and save/load.
 *
 * Matches you are involved in are played on the full simulation. Other fixtures
 * in the round are resolved by a statistical model built from the same athlete
 * attributes - that is stated plainly in the interface rather than dressed up as
 * a full simulation of every match (section 46, step 6).
 */

import { Rng, clamp, clamp01, lerp } from '../core/Math2.js';
import { TEAMS, defaultLineup } from '../data/Teams.js';
import { overallFor, POSITION_NAMES, TRAIT_BY_ID, OVERALL_WEIGHTS, POSITIONS } from '../data/Attributes.js';
import { starRating, starString } from '../data/DisplayStats.js';
import { registerScreen, shell, menuItem, chipRow, field, el } from '../ui/Screens.js';
import { simulateByStars } from './SimResult.js';
import { OFFENSIVE_SYSTEMS, DEFENSIVE_SYSTEMS, EXTRA_PLAYER_SYSTEMS, MAN_DOWN_SYSTEMS, TACTICAL_TRIGGERS } from '../ai/Tactics.js';
import { humanise } from '../ui/HUD.js';

export const TRAINING_FOCUS = {
  swimming: { name: 'Swimming and Conditioning', attrs: ['swimSpeed', 'firstStroke', 'endurance', 'burstStamina', 'recoverySpeed'], fatigue: 1.25 },
  legs: { name: 'Leg Strength and Elevation', attrs: ['legPower', 'verticalReach', 'explosiveness', 'balance'], fatigue: 1.2 },
  shooting: { name: 'Shooting', attrs: ['shotPower', 'shotPlacement', 'skipControl', 'releaseSpeed', 'lobControl'], fatigue: 0.9 },
  ballHandling: { name: 'Ball Handling', attrs: ['ballSecurity', 'oneHandCatch', 'firstTouch', 'quickRelease', 'wetPassControl'], fatigue: 0.8 },
  weakHand: { name: 'Weak-Hand Development', attrs: ['weakHandControl', 'weakHandShot'], fatigue: 0.85 },
  centrePlay: { name: 'Centre Play', attrs: ['upperStrength', 'leverage', 'backhand', 'shootUnderContact', 'centreDefence'], fatigue: 1.15 },
  defence: { name: 'Defensive Discipline', attrs: ['marking', 'laneDenial', 'foulDiscipline', 'legalLeverage', 'blockTiming'], fatigue: 1.0 },
  goalkeeping: { name: 'Goalkeeper Specialisation', attrs: ['reactionSpeed', 'setPositioning', 'lateralMovement', 'skipTracking', 'reboundControl'], fatigue: 0.9 },
  tactical: { name: 'Tactical Understanding', attrs: ['tacticalAwareness', 'decisionMaking', 'anticipation', 'vision', 'communication'], fatigue: 0.6 },
  recovery: { name: 'Recovery Week', attrs: [], fatigue: 0.25 },
};

export class ManagerCareer {
  /**
   * @param {object} league  the generated league
   * @param {string} clubId  the club the user manages
   * @param {number} seed
   */
  constructor(league, clubId, seed = 20260728) {
    this.league = league;
    this.clubId = clubId;
    this.rng = new Rng(seed);
    this.season = 1;
    this.round = 0;
    this.fixtures = buildFixtures(TEAMS.map((t) => t.id), this.rng);
    this.results = [];
    this.table = {};
    this.trainingFocus = 'tactical';
    this.freeAgents = [];
    this.news = [];
    this.finished = false;

    for (const t of TEAMS) {
      this.table[t.id] = { id: t.id, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, pts: 0 };
    }

    // Per-athlete season state kept outside the roster records so the underlying
    // roster stays editable and shareable.
    this.state = {};
    for (const t of TEAMS) {
      for (const p of league.rosters[t.id]) {
        this.state[p.id] = {
          condition: 1, matchFatigue: 0, injuryWeeks: 0, form: p.form,
          apps: 0, goals: 0, assists: 0, exclusions: 0, saves: 0,
        };
      }
    }

    this._buildFreeAgents();
    this.squadMorale = 72;             // 0-100 club morale
    this.academyIntake = [];          // youth prospects to sign at season start
    this.market = this._buildMarket(); // transfer market
    this.pendingDecisions = [];        // coach decisions awaiting a choice
    this.transferBudgetUsed = 0;
    this._genAcademy();

    const club = TEAMS.find((t) => t.id === clubId);
    this.board = {
      expectation: club.prestige >= 85 ? 'win' : club.prestige >= 80 ? 'top3' : club.prestige >= 77 ? 'top5' : 'survive',
      confidence: 0.6,
      budget: Math.round(club.prestige * 1800),
    };
    this.pushNews(`You have been appointed at ${club.name}. The board expects ${this.expectationText()}.`);
  }

  get club() { return TEAMS.find((t) => t.id === this.clubId); }
  get squad() { return this.league.rosters[this.clubId]; }

  expectationText() {
    return {
      win: 'the title', top3: 'a top-three finish',
      top5: 'a top-five finish', survive: 'steady progress and youth development',
    }[this.board.expectation];
  }

  _buildFreeAgents() {
    // A small, honest free-agent pool generated from the same athlete model.
    const { generateLeague } = { generateLeague: null };
    const rng = this.rng.fork(0xFA);
    const pool = [];
    const names = ['Ilie Varga', 'Nuno Bastos', 'Kai Lindmark', 'Sergi Tordera', 'Vuk Ivanovic', 'Otto Brenner', 'Rafa Quintela', 'Levi Amsel'];
    const positions = ['DR', 'WG', 'CF', 'CD', 'PT', 'GK', 'UT', 'DR'];
    for (let i = 0; i < 8; i++) {
      const base = rng.range(58, 74);
      const src = this.league.rosters[TEAMS[i % TEAMS.length].id][rng.int(7, 13)];
      const p = structuredClone(src);
      p.id = `fa${i + 1}`;
      p.teamId = null;
      p.name = names[i];
      const [first, ...rest] = names[i].split(' ');
      p.firstName = first;
      p.lastName = rest.join(' ');
      p.position = positions[i];
      p.capNumber = 0;
      for (const k of Object.keys(p.attr)) {
        p.attr[k] = Math.round(clamp(p.attr[k] * rng.range(0.88, 1.12) + (base - 66) * 0.4, 15, 95));
      }
      p.overall = overallFor(p);
      p.wage = Math.round((p.overall ** 2.2) / 60) * 10;
      p.askingPrice = Math.round(p.overall ** 2.4 / 22) * 10;
      pool.push(p);
      this.state[p.id] = { condition: 1, matchFatigue: 0, injuryWeeks: 0, form: 1, apps: 0, goals: 0, assists: 0, exclusions: 0, saves: 0 };
    }
    this.freeAgents = pool;
  }

  pushNews(text) {
    this.news.unshift({ text, round: this.round, season: this.season });
    if (this.news.length > 40) this.news.pop();
  }

  currentRound() { return this.fixtures[this.round] ?? null; }

  /** The user's fixture this round, or null on a bye. */
  userFixture() {
    const r = this.currentRound();
    if (!r) return null;
    return r.find((f) => f.home === this.clubId || f.away === this.clubId) ?? null;
  }

  /** Advance the round after the user's match has been resolved. */
  completeRound(userResult) {
    const r = this.currentRound();
    if (!r) return;
    for (const fx of r) {
      const isUser = fx.home === this.clubId || fx.away === this.clubId;
      const result = isUser && userResult ? userResult : this.quickResolve(fx);
      this.applyResult(fx, result);
    }
    this.applyTrainingWeek();
    this._maybeGenerateDecision();
    this.round++;
    if (this.round >= this.fixtures.length) this.endSeason();
  }

  /**
   * Statistical resolution for fixtures the user is not playing. Built from the
   * same athlete attributes the full simulation uses, so the league table stays
   * consistent with what you feel on the water - but it is a model, not a match.
   */
  /**
   * Star-based resolution for simmed fixtures: the winner and margin come from
   * the gap in team star level, with a one-in-four chance of an upset.
   */
  quickResolve(fx) {
    const res = simulateByStars(this.league.rosters[fx.home], this.league.rosters[fx.away], this.rng);
    return { home: res.home, away: res.away, simulated: true, upset: res.upset };
  }

  applyResult(fx, res) {
    const h = this.table[fx.home], a = this.table[fx.away];
    h.played++; a.played++;
    h.gf += res.home; h.ga += res.away;
    a.gf += res.away; a.ga += res.home;
    if (res.home > res.away) { h.won++; a.lost++; h.pts += 3; }
    else if (res.home < res.away) { a.won++; h.lost++; a.pts += 3; }
    else { h.drawn++; a.drawn++; h.pts++; a.pts++; }

    this.results.push({ round: this.round, ...fx, ...res });

    if (fx.home === this.clubId || fx.away === this.clubId) {
      const us = fx.home === this.clubId ? res.home : res.away;
      const them = fx.home === this.clubId ? res.away : res.home;
      const opp = TEAMS.find((t) => t.id === (fx.home === this.clubId ? fx.away : fx.home));
      const verdict = us > them ? 'Win' : us < them ? 'Defeat' : 'Draw';
      this.pushNews(`${verdict} ${us}-${them} against ${opp.name}.`);
      this.board.confidence = clamp01(this.board.confidence + (us > them ? 0.07 : us < them ? -0.06 : 0));

      // Match load on the athletes who played.
      for (const p of defaultLineup(this.squad)) {
        const s = this.state[p.id];
        s.condition = clamp01(s.condition - this.rng.range(0.08, 0.2));
        s.apps++;
        if (this.rng.chance(0.035 * (1.5 - s.condition))) {
          s.injuryWeeks = this.rng.int(1, 4);
          this.pushNews(`${p.name} picked up a shoulder problem and misses ${s.injuryWeeks} week(s).`);
        }
      }
    }
  }

  /** Weekly training: development, recovery, injuries. */
  applyTrainingWeek() {
    const focus = TRAINING_FOCUS[this.trainingFocus];
    for (const p of this.squad) {
      const s = this.state[p.id];
      if (s.injuryWeeks > 0) { s.injuryWeeks--; s.condition = clamp01(s.condition + 0.10); continue; }

      s.condition = clamp01(s.condition + lerp(0.30, 0.08, focus.fatigue / 1.25));
      s.form = clamp(s.form + this.rng.gauss(0, 0.04), 0.8, 1.2);

      // Development is gated by potential, age and coachability.
      const room = p.potential - p.overall;
      if (room > 0 && focus.attrs.length) {
        const youth = clamp01((30 - p.age) / 12);
        const coach = clamp01((p.attr.coachability - 30) / 60);
        const chance = 0.16 * youth * (0.4 + coach) * clamp01(room / 12);
        for (const attr of focus.attrs) {
          if (this.rng.chance(chance)) {
            p.attr[attr] = Math.min(99, p.attr[attr] + 1);
          }
        }
        const before = p.overall;
        p.overall = overallFor(p);
        if (p.overall > before) this.pushNews(`${p.name} improved to ${p.overall} overall.`);
      }
    }
  }

  signFreeAgent(playerId) {
    const i = this.freeAgents.findIndex((p) => p.id === playerId);
    if (i < 0) return { ok: false, reason: 'notAvailable' };
    const p = this.freeAgents[i];
    if (p.askingPrice > this.board.budget) return { ok: false, reason: 'insufficientBudget' };
    if (this.squad.length >= 16) return { ok: false, reason: 'squadFull' };

    this.board.budget -= p.askingPrice;
    this.freeAgents.splice(i, 1);
    p.teamId = this.clubId;
    p.capNumber = nextCapNumber(this.squad);
    this.squad.push(p);
    this.pushNews(`Signed ${p.name} (${POSITION_NAMES[p.position]}, ${p.overall} overall) for ${p.askingPrice}.`);
    return { ok: true };
  }

  releasePlayer(playerId) {
    const i = this.squad.findIndex((p) => p.id === playerId);
    if (i < 0 || this.squad.length <= 13) return { ok: false, reason: 'squadTooSmall' };
    const [p] = this.squad.splice(i, 1);
    p.teamId = null;
    this.freeAgents.push(p);
    this.pushNews(`${p.name} released.`);
    return { ok: true };
  }

  standings() {
    return Object.values(this.table).sort((a, b) =>
      b.pts - a.pts || (b.gf - b.ga) - (a.gf - a.ga) || b.gf - a.gf);
  }

  endSeason() {
    this.finished = true;
    const table = this.standings();
    const pos = table.findIndex((t) => t.id === this.clubId) + 1;
    const met = {
      win: pos === 1, top3: pos <= 3, top5: pos <= 5, survive: pos <= 8,
    }[this.board.expectation];
    this.pushNews(`Season ${this.season} complete. Finished ${ordinal(pos)}. The board is ${met ? 'satisfied' : 'disappointed'}.`);
    this.board.confidence = clamp01(this.board.confidence + (met ? 0.2 : -0.25));
    this.seasonSummary = { position: pos, met, table };
  }

  startNextSeason() {
    this.season++;
    this.round = 0;
    this.finished = false;
    this.seasonSummary = null;
    this.fixtures = buildFixtures(TEAMS.map((t) => t.id), this.rng);
    for (const t of TEAMS) this.table[t.id] = { id: t.id, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, pts: 0 };
    this.results = [];
    this.board.budget += 3200;
    for (const p of this.squad) {
      p.age++;
      const s = this.state[p.id] ?? (this.state[p.id] = { condition: 1, matchFatigue: 0, injuryWeeks: 0, form: 1, apps: 0, goals: 0, assists: 0, exclusions: 0, saves: 0 });
      // Decline after thirty, gentle and attribute-driven.
      if (p.age > 30) {
        for (const k of ['swimSpeed', 'firstStroke', 'explosiveness', 'burstStamina', 'legPower']) {
          if (this.rng.chance(0.35)) p.attr[k] = Math.max(20, p.attr[k] - 1);
        }
        p.overall = overallFor(p);
      }
    }
    // Development happens over the summer, then reset season counters.
    this.developSquad();
    for (const p of this.squad) { const s = this.state[p.id]; if (s) { s.condition = 1; s.matchFatigue = 0; s.apps = 0; s.goals = 0; } }
    // New academy intake and a refreshed transfer market.
    this._genAcademy();
    this.market = this._buildMarket();
    this.pushNews(`Season ${this.season} begins. Budget: ${this.board.budget}. ${this.academyIntake.length} academy prospects await your decision.`);
  }


  // ======================================================================
  // Coach Career depth: development, academy, market, decisions, morale
  // ======================================================================

  /** Multi-season development driven by the 1-10 potential score. */
  developSquad() {
    for (const p of this.squad) {
      const s = this.state[p.id] ?? {};
      const apps = s.apps ?? 0;
      const youth = clamp01((27 - p.age) / 12);
      const playing = clamp01(apps / 12);
      const pot = (p.pot10 ?? 5) / 10;
      const cap = p.potential ?? 90;
      const room = Math.max(0, cap - p.overall);
      if (room <= 0) continue;
      // Facilities/board confidence give a small development multiplier.
      const facility = 0.9 + this.board.confidence * 0.3;
      let growth = Math.round((1.5 + pot * 11) * (0.35 + youth * 0.85) * (0.45 + playing * 0.9) *
        clamp01(room / 6) * facility * this.rng.range(0.75, 1.15));
      growth = clamp(growth, 0, room);
      if (growth <= 0) continue;
      const before = p.overall;
      const weights = OVERALL_WEIGHTS[p.position] ?? OVERALL_WEIGHTS.UT;
      for (const attr of Object.keys(weights)) {
        p.attr[attr] = Math.min(99, (p.attr[attr] ?? 50) + growth);
      }
      p.overall = overallFor(p);
      // Never overshoot the cap.
      if (p.overall > cap) p.overall = cap;
      if (p.overall > before && p.id !== undefined) {
        const gained = p.overall - before;
        if (gained >= 3) this.pushNews(`${p.name} developed sharply: ${before} -> ${p.overall} overall (${starWord(before)} to ${starWord(p.overall)}).`);
      }
    }
  }

  _makeProspect(idx, opts = {}) {
    const rng = this.rng.fork(0xAC + idx * 131 + this.season * 977);
    const position = opts.position ?? rng.pick(POSITIONS);
    const attr = {};
    for (const a of Object.keys(this.squad[0]?.attr ?? {})) attr[a] = Math.round(clamp(rng.gauss(48, 7), 28, 66));
    // Boost position keys a little.
    const weights = OVERALL_WEIGHTS[position] ?? OVERALL_WEIGHTS.UT;
    for (const k of Object.keys(weights)) attr[k] = Math.round(clamp(attr[k] + rng.range(2, 10), 28, 72));
    const age = opts.academy ? rng.int(16, 18) : rng.int(19, 29);
    const p = {
      id: (opts.academy ? 'ac' : 'mk') + '_' + this.season + '_' + idx,
      teamId: null, firstName: rng.pick(FIRST_NAMES), lastName: rng.pick(LAST_NAMES),
      position, secondaryPosition: null, leftHanded: rng.chance(0.15),
      height: rng.int(180, 202), age, attr, traits: [], form: 1, morale: 0.7, condition: 1,
    };
    p.name = `${p.firstName} ${p.lastName}`;
    p.overall = overallFor(p);
    // Potential: academy prospects skew high (gems); market skews to their level.
    p.pot10 = opts.academy ? Math.round(clamp(rng.gauss(6.5, 2), 3, 10))
                           : Math.round(clamp(rng.gauss(5, 2), 1, 9));
    p.potential = Math.round(clamp(52 + p.pot10 * 4.3 + (30 - age) * 0.4, p.overall, 99));
    p.wage = Math.round((p.overall ** 2.1) / 60) * 10;
    p.askingPrice = opts.academy ? Math.round(150 + p.pot10 * 60)
                                 : Math.round((p.overall ** 2.5) / 40) * 10;
    this.state[p.id] = { condition: 1, matchFatigue: 0, injuryWeeks: 0, form: 1, apps: 0, goals: 0, assists: 0, exclusions: 0, saves: 0 };
    return p;
  }

  _genAcademy() {
    this.academyIntake = [];
    const n = 3 + this.rng.int(0, 2);
    for (let i = 0; i < n; i++) this.academyIntake.push(this._makeProspect(i, { academy: true }));
  }

  _buildMarket() {
    const pool = [];
    for (let i = 0; i < 12; i++) pool.push(this._makeProspect(i, { academy: false }));
    return pool.sort((a, b) => b.overall - a.overall);
  }

  signProspect(id, from) {
    const src = from === 'academy' ? this.academyIntake : from === 'market' ? this.market : this.freeAgents;
    const i = src.findIndex((p) => p.id === id);
    if (i < 0) return { ok: false, reason: 'unavailable' };
    const p = src[i];
    const fee = from === 'free' ? 0 : (p.askingPrice ?? 0);
    if (fee > this.board.budget) return { ok: false, reason: 'insufficientBudget' };
    if (this.squad.length >= 18) return { ok: false, reason: 'squadFull' };
    this.board.budget -= fee;
    this.transferBudgetUsed += fee;
    src.splice(i, 1);
    p.teamId = this.clubId;
    p.capNumber = nextCapNumber(this.squad);
    this.squad.push(p);
    this.pushNews(`Signed ${p.name} (${POSITION_NAMES[p.position]}, ${p.overall} OVR, potential ${p.pot10}/10)${fee ? ` for ${fee}` : ' on a free'}.`);
    return { ok: true };
  }

  // ---- Coach decisions --------------------------------------------------
  _maybeGenerateDecision() {
    if (this.pendingDecisions.length > 0) return;
    if (this.rng.next() > 0.4) return;
    const squad = this.squad.filter((p) => p.id !== 'ME');
    const star = squad.sort((a, b) => b.overall - a.overall)[0];
    const benched = squad.filter((p) => (this.state[p.id]?.apps ?? 0) < this.round * 0.3);
    const templates = [
      {
        text: `${star?.name} wants assurances he is your key player.`,
        options: [
          { label: 'Promise him a central role', effect: { morale: +6, confidence: -0.02 } },
          { label: 'Tell him to earn it', effect: { morale: -4, confidence: +0.03 } },
        ],
      },
      {
        text: 'The board offers extra transfer funds if you cut the wage bill.',
        options: [
          { label: 'Take the funds (+2500 budget)', effect: { budget: +2500, morale: -5 } },
          { label: 'Decline, keep the squad happy', effect: { morale: +3 } },
        ],
      },
      {
        text: benched.length ? `${benched[0].name} is frustrated with a lack of minutes.` : 'A youngster asks for more game time.',
        options: [
          { label: 'Promise more minutes', effect: { morale: +5 } },
          { label: 'Loan-list him', effect: { morale: -3, budget: +400 } },
        ],
      },
      {
        text: 'A sponsor wants a pre-season friendly tour.',
        options: [
          { label: 'Accept (+1800 budget, tiring)', effect: { budget: +1800, morale: -3 } },
          { label: 'Decline, focus on training', effect: { morale: +2, confidence: +0.01 } },
        ],
      },
    ];
    const t = this.rng.pick(templates);
    this.pendingDecisions.push(t);
  }

  resolveDecision(optionIndex) {
    const d = this.pendingDecisions.shift();
    if (!d) return;
    const eff = d.options[optionIndex]?.effect ?? {};
    if (eff.budget) this.board.budget += eff.budget;
    if (eff.confidence) this.board.confidence = clamp01(this.board.confidence + eff.confidence);
    if (eff.morale) this.squadMorale = clamp(this.squadMorale + eff.morale, 0, 100);
    this.pushNews(`Decision: "${d.options[optionIndex]?.label}".`);
  }

  teamStarAvg() {
    const seven = this.squad.slice().sort((a, b) => b.overall - a.overall).slice(0, 7);
    return seven.reduce((s, p) => s + starRating(p.overall), 0) / Math.max(1, seven.length);
  }

  serialise() {
    return {
      version: 1, season: this.season, round: this.round, clubId: this.clubId,
      table: this.table, results: this.results, trainingFocus: this.trainingFocus,
      board: this.board, news: this.news, state: this.state,
      fixtures: this.fixtures,
      rosters: this.league.rosters,
      freeAgents: this.freeAgents,
      squadMorale: this.squadMorale, academyIntake: this.academyIntake,
      market: this.market, pendingDecisions: this.pendingDecisions, transferBudgetUsed: this.transferBudgetUsed,
    };
  }

  static restore(league, data) {
    const c = new ManagerCareer(league, data.clubId);
    Object.assign(c, {
      season: data.season, round: data.round, table: data.table, results: data.results,
      trainingFocus: data.trainingFocus, board: data.board, news: data.news,
      state: data.state, fixtures: data.fixtures, freeAgents: data.freeAgents,
      squadMorale: data.squadMorale ?? 72, academyIntake: data.academyIntake ?? [],
      market: data.market ?? c.market, pendingDecisions: data.pendingDecisions ?? [],
      transferBudgetUsed: data.transferBudgetUsed ?? 0,
    });
    if (data.rosters) league.rosters = data.rosters;
    return c;
  }
}

const FIRST_NAMES = ['Marko','Iker','Teo','Luka','Nils','Andrei','Dario','Emil','Sandor','Vito','Kasper','Renzo','Milos','Arno','Bram','Zoran','Tomas','Elio','Rafa','Osian','Janek','Nico','Sten','Alvaro','Erol','Pau','Vasco','Hektor','Joris','Matej'];
const LAST_NAMES = ['Vaquero','Draskovic','Lindqvist','Marchetti','Petrov','Kovacic','Nyland','Barsi','Ferreiro','Oksanen','Delfino','Radovic','Weiss','Nowak','Milic','Sorrentino','Aguirre','Bakker','Cortese','Zoric','Almeida','Hedberg','Lourenco','Vasilev','Brand','Mestre','Kallio','Duarte','Simic','Rovere'];
function starWord(overall) {
  const st = starRating(overall);
  return `${st}\u2605`;
}

/** Double round robin, shuffled, using the circle method. */
function buildFixtures(ids, rng) {
  const teams = ids.slice();
  for (let i = teams.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [teams[i], teams[j]] = [teams[j], teams[i]];
  }
  const n = teams.length;
  const rounds = [];
  const arr = teams.slice();
  for (let r = 0; r < n - 1; r++) {
    const round = [];
    for (let i = 0; i < n / 2; i++) {
      const home = arr[i];
      const away = arr[n - 1 - i];
      round.push(r % 2 === 0 ? { home, away } : { home: away, away: home });
    }
    rounds.push(round);
    arr.splice(1, 0, arr.pop());
  }
  // Reverse fixtures.
  const second = rounds.map((r) => r.map((f) => ({ home: f.away, away: f.home })));
  return [...rounds, ...second];
}

function nextCapNumber(squad) {
  const used = new Set(squad.map((p) => p.capNumber));
  for (let i = 2; i <= 20; i++) if (!used.has(i)) return i;
  return 20;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

// ===========================================================================
// Career screens
// ===========================================================================

registerScreen('careerSetup', (game, params, mgr) => shell('Coach Career', (body) => {
  body.appendChild(el('p', null, 'Choose the club you will manage. Board expectations follow club prestige.'));

  const saved = game.loadCareerSave();
  if (saved) {
    const resume = el('div', 'menu-list');
    resume.appendChild(menuItem(
      'Continue Saved Career',
      `${TEAMS.find((t) => t.id === saved.clubId)?.name} · season ${saved.season}, round ${saved.round + 1}`,
      'Saved', () => game.resumeCareer(saved)));
    body.appendChild(resume);
  }

  const grid = el('div', 'grid grid-3');
  grid.style.marginTop = '16px';
  for (const t of TEAMS) {
    const card = el('div', 'card team-card');
    card.style.setProperty('--team', t.colors.primary);
    card.appendChild(el('div', 'tc-name', t.name));
    card.appendChild(el('div', 'tc-city', `${t.city} · prestige ${t.prestige}`));
    card.appendChild(el('div', 'tc-bio', t.bio));
    const exp = el('div', 'mi-desc');
    exp.textContent = `Board expects: ${t.prestige >= 85 ? 'the title' : t.prestige >= 80 ? 'top three' : t.prestige >= 77 ? 'top five' : 'progress'}`;
    exp.style.color = t.colors.primary;
    card.appendChild(exp);
    card.addEventListener('click', () => game.startCareer(t.id));
    grid.appendChild(card);
  }
  body.appendChild(grid);

  const a = el('div', 'actions');
  const back = el('button', 'btn ghost', 'Back');
  back.addEventListener('click', () => mgr.show('main'));
  a.appendChild(back);
  body.appendChild(a);
}));

registerScreen('careerHub', (game, params, mgr) => shell('Career', (body) => {
  const c = game.career;
  const club = c.club;

  // ---- Header ------------------------------------------------------------
  const head = el('div', 'card');
  head.style.borderLeft = `4px solid ${club.colors.primary}`;
  head.appendChild(el('div', 'tc-name', club.name));
  head.appendChild(el('div', 'tc-city',
    `Season ${c.season} · Round ${Math.min(c.round + 1, c.fixtures.length)} of ${c.fixtures.length} · Budget ${c.board.budget}`));
  const conf = el('div', 'pcb');
  conf.style.marginTop = '12px';
  conf.style.gridTemplateColumns = '140px 1fr';
  conf.appendChild(el('span', 'pcb-l', 'Board confidence'));
  const cb = el('div', 'pcb-bar');
  const cf = el('i');
  cf.style.width = `${c.board.confidence * 100}%`;
  cf.style.background = c.board.confidence > 0.6 ? '#4ade80' : c.board.confidence > 0.3 ? '#fbbf24' : '#f87171';
  cb.appendChild(cf);
  conf.appendChild(cb);
  head.appendChild(conf);
  // Team stars + squad morale readout.
  const teamInfo = el('div', 'tc-stats');
  const addI = (label, val, color) => { const d = el('div', 'tc-stat'); const b = el('b', null, val); if (color) b.style.color = color; d.appendChild(b); d.appendChild(document.createTextNode(label)); teamInfo.appendChild(d); };
  addI('TEAM STARS', c.teamStarAvg ? c.teamStarAvg().toFixed(1) + '\u2605' : '-', '#f4c430');
  addI('SQUAD MORALE', Math.round(c.squadMorale ?? 72), (c.squadMorale ?? 72) > 55 ? '#5ef08a' : '#ffcf4d');
  addI('TRANSFER BUDGET', '$' + (c.board.budget));
  head.appendChild(teamInfo);
  body.appendChild(head);

  // Pending coach decision.
  if (c.pendingDecisions && c.pendingDecisions.length) {
    const d = c.pendingDecisions[0];
    const dc = el('div', 'card');
    dc.style.marginTop = '14px'; dc.style.borderLeft = '4px solid #f4c430';
    dc.appendChild(el('h3', null, 'A Decision To Make'));
    dc.appendChild(el('p', null, d.text));
    const opts = el('div', 'field-control');
    d.options.forEach((o, i) => {
      const b = el('button', 'chip', o.label);
      b.addEventListener('click', () => { c.resolveDecision(i); game.saveCareer(); mgr.show('careerHub'); });
      opts.appendChild(b);
    });
    dc.appendChild(opts);
    body.appendChild(dc);
  }

  const cols = el('div', 'grid grid-2');
  cols.style.marginTop = '14px';

  // ---- Next fixture ------------------------------------------------------
  const fx = c.userFixture();
  const next = el('div', 'card');
  next.appendChild(el('h3', null, c.finished ? 'Season complete' : 'Next fixture'));
  if (c.finished) {
    const s = c.seasonSummary;
    next.appendChild(el('p', null, `Finished ${ordinal(s.position)}. The board is ${s.met ? 'satisfied' : 'disappointed'}.`));
    const btn = el('button', 'btn', 'Begin next season');
    btn.addEventListener('click', () => { c.startNextSeason(); game.saveCareer(); mgr.show('careerHub'); });
    next.appendChild(btn);
  } else if (fx) {
    const home = TEAMS.find((t) => t.id === fx.home);
    const away = TEAMS.find((t) => t.id === fx.away);
    const line = el('div', 'tc-name', `${home.short}  v  ${away.short}`);
    next.appendChild(line);
    next.appendChild(el('div', 'tc-city', `${fx.home === c.clubId ? 'Home' : 'Away'} · ${home.name} v ${away.name}`));
    const acts = el('div', 'actions');
    const play = el('button', 'btn', 'Play Match');
    play.addEventListener('click', () => game.playCareerMatch(fx));
    const sim = el('button', 'btn ghost', 'Simulate Round');
    sim.addEventListener('click', () => {
      c.completeRound(null);
      game.saveCareer();
      mgr.show('careerHub');
    });
    acts.appendChild(play);
    acts.appendChild(sim);
    next.appendChild(acts);
    const note = el('p', null, 'Simulating uses the statistical model for every fixture in the round, including yours.');
    note.style.marginTop = '10px';
    next.appendChild(note);
  }
  cols.appendChild(next);

  // ---- Training ----------------------------------------------------------
  const tr = el('div', 'card');
  tr.appendChild(el('h3', null, 'Training focus'));
  tr.appendChild(chipRow(
    Object.entries(TRAINING_FOCUS).map(([k, v]) => ({ value: k, label: v.name })),
    c.trainingFocus, (v) => { c.trainingFocus = v; game.saveCareer(); mgr.show('careerHub'); }));
  const trn = el('p', null,
    'Focus develops the listed attributes for athletes with potential still to reach, and sets how much condition the week costs.');
  trn.style.marginTop = '12px';
  tr.appendChild(trn);
  cols.appendChild(tr);
  body.appendChild(cols);

  // ---- Menu --------------------------------------------------------------
  const list = el('div', 'menu-list');
  list.style.marginTop = '16px';
  list.appendChild(menuItem('Squad', 'Condition, form, injuries, development and the starting seven.', null,
    () => mgr.show('careerSquad')));
  list.appendChild(menuItem('Tactics', 'Offensive and defensive systems, extra-player structure, triggers.', null,
    () => mgr.show('careerTactics')));
  list.appendChild(menuItem('League Table', 'Standings, fixtures and results.', null,
    () => mgr.show('careerTable')));
  list.appendChild(menuItem('Player Market', 'Scout and sign players for a transfer fee, plus free agents.', null,
    () => mgr.show('careerMarket')));
  list.appendChild(menuItem('Academy Intake', `Sign youth prospects${c.academyIntake?.length ? ' (' + c.academyIntake.length + ' available)' : ''}.`, null,
    () => mgr.show('careerAcademy')));
  body.appendChild(list);

  // ---- News --------------------------------------------------------------
  if (c.news.length) {
    const news = el('div', 'card');
    news.style.marginTop = '16px';
    news.appendChild(el('h3', null, 'Club news'));
    for (const n of c.news.slice(0, 8)) {
      const p = el('p', null, n.text);
      p.style.margin = '0 0 6px';
      news.appendChild(p);
    }
    body.appendChild(news);
  }

  const a = el('div', 'actions');
  const save = el('button', 'btn ghost', 'Save Career');
  save.addEventListener('click', () => { game.saveCareer(); mgr.toast('Career saved.'); });
  const back = el('button', 'btn ghost', 'Main Menu');
  back.addEventListener('click', () => mgr.show('main'));
  a.appendChild(save);
  a.appendChild(back);
  body.appendChild(a);
}));

registerScreen('careerSquad', (game, params, mgr) => shell('Squad', (body) => {
  const c = game.career;
  const table = el('table', 'data');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Cap', 'Name', 'Pos', 'Age', 'OVR', 'Stars', 'POT', 'Cond', 'Form', 'Apps', 'Status']) {
    hr.appendChild(el('th', ['OVR', 'Age', 'Apps'].includes(h) ? 'num' : null, h));
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tb = el('tbody');
  const seven = new Set(defaultLineup(c.squad).map((p) => p.id));
  for (const p of [...c.squad].sort((a, b) => a.capNumber - b.capNumber)) {
    const s = c.state[p.id];
    const tr = el('tr');
    if (seven.has(p.id)) tr.className = 'row-hi';
    tr.appendChild(el('td', 'num', String(p.capNumber)));
    tr.appendChild(el('td', null, p.name));
    tr.appendChild(el('td', null, p.position));
    tr.appendChild(el('td', 'num', String(p.age)));
    tr.appendChild(el('td', 'num', String(p.overall)));
    const st = el('td', null, starString(p.overall)); st.style.color = '#f4c430'; tr.appendChild(st);
    const pot = el('td', null, `${p.pot10 ?? '-'}/10`); pot.style.color = (p.pot10 ?? 0) >= 8 ? '#5ef08a' : (p.pot10 ?? 0) >= 6 ? '#8be9fd' : 'var(--muted)'; tr.appendChild(pot);
    const cond = el('td', 'num', `${Math.round(s.condition * 100)}%`);
    cond.style.color = s.condition > 0.8 ? '#4ade80' : s.condition > 0.55 ? '#fbbf24' : '#f87171';
    tr.appendChild(cond);
    tr.appendChild(el('td', 'num', `${Math.round(s.form * 100)}%`));
    tr.appendChild(el('td', 'num', String(s.apps)));
    tr.appendChild(el('td', null, s.injuryWeeks > 0 ? `Injured ${s.injuryWeeks}w` : seven.has(p.id) ? 'Starting seven' : 'Available'));
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  const card = el('div', 'card');
  card.appendChild(el('h3', null, 'Squad'));
  card.appendChild(table);
  body.appendChild(card);

  const a = el('div', 'actions');
  const back = el('button', 'btn ghost', 'Back');
  back.addEventListener('click', () => mgr.show('careerHub'));
  a.appendChild(back);
  body.appendChild(a);
}));

registerScreen('careerTactics', (game, params, mgr) => shell('Tactics', (body) => {
  const c = game.career;
  const t = game.careerTactics;
  const refresh = () => mgr.show('careerTactics');

  const card = el('div', 'card');
  card.appendChild(el('h3', null, 'Systems'));
  card.appendChild(field('Offensive system', chipRow(
    Object.entries(OFFENSIVE_SYSTEMS).map(([k, v]) => ({ value: k, label: v.name })),
    t.offense, (v) => { t.offense = v; game.saveCareer(); refresh(); })));
  card.appendChild(field('Defensive system', chipRow(
    Object.entries(DEFENSIVE_SYSTEMS).map(([k, v]) => ({ value: k, label: v.name })),
    t.defense, (v) => { t.defense = v; game.saveCareer(); refresh(); })));
  card.appendChild(field('Extra-player attack', chipRow(
    Object.entries(EXTRA_PLAYER_SYSTEMS).map(([k, v]) => ({ value: k, label: v.name })),
    t.extraPlayer, (v) => { t.extraPlayer = v; game.saveCareer(); refresh(); })));
  card.appendChild(field('Man-down defence', chipRow(
    Object.entries(MAN_DOWN_SYSTEMS).map(([k, v]) => ({ value: k, label: v.name })),
    t.manDown, (v) => { t.manDown = v; game.saveCareer(); refresh(); })));
  body.appendChild(card);

  const desc = el('div', 'card');
  desc.style.marginTop = '14px';
  desc.appendChild(el('h3', null, 'Current shape'));
  desc.appendChild(el('p', null, OFFENSIVE_SYSTEMS[t.offense].desc));
  const d = DEFENSIVE_SYSTEMS[t.defense];
  desc.appendChild(el('p', null,
    `${d.name}: pressure ${Math.round(d.pressure * 100)}%, drop ${Math.round(d.drop * 100)}%, ` +
    `centre fronting ${Math.round(d.frontCentre * 100)}%, foul risk ${Math.round(d.foulRisk * 100)}%.`));
  body.appendChild(desc);

  const trig = el('div', 'card');
  trig.style.marginTop = '14px';
  trig.appendChild(el('h3', null, 'Tactical triggers'));
  for (const tg of t.triggers) {
    const row = el('div', 'field-row');
    row.appendChild(el('div', 'field-label', tg.label));
    row.appendChild(chipRow([{ value: true, label: 'On' }, { value: false, label: 'Off' }], tg.on,
      (v) => { tg.on = v; game.saveCareer(); refresh(); }));
    trig.appendChild(row);
  }
  body.appendChild(trig);

  const a = el('div', 'actions');
  const back = el('button', 'btn ghost', 'Back');
  back.addEventListener('click', () => mgr.show('careerHub'));
  a.appendChild(back);
  body.appendChild(a);
}));

registerScreen('careerTable', (game, params, mgr) => shell('League', (body) => {
  const c = game.career;
  const table = el('table', 'data');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['#', 'Club', 'P', 'W', 'D', 'L', 'GF', 'GA', 'GD', 'Pts']) {
    hr.appendChild(el('th', h.length <= 3 && h !== 'Club' ? 'num' : null, h));
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tb = el('tbody');
  c.standings().forEach((row, i) => {
    const team = TEAMS.find((t) => t.id === row.id);
    const tr = el('tr');
    if (row.id === c.clubId) tr.className = 'row-hi';
    tr.appendChild(el('td', 'num', String(i + 1)));
    tr.appendChild(el('td', null, team.name));
    for (const v of [row.played, row.won, row.drawn, row.lost, row.gf, row.ga, row.gf - row.ga, row.pts]) {
      tr.appendChild(el('td', 'num', String(v)));
    }
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  const card = el('div', 'card');
  card.appendChild(el('h3', null, `Season ${c.season} standings`));
  card.appendChild(table);
  body.appendChild(card);

  const rd = c.currentRound();
  if (rd) {
    const fixCard = el('div', 'card');
    fixCard.style.marginTop = '14px';
    fixCard.appendChild(el('h3', null, `Round ${c.round + 1} fixtures`));
    for (const f of rd) {
      const p = el('p', null,
        `${TEAMS.find((t) => t.id === f.home).name}  v  ${TEAMS.find((t) => t.id === f.away).name}`);
      p.style.margin = '0 0 5px';
      fixCard.appendChild(p);
    }
    body.appendChild(fixCard);
  }

  if (c.results.length) {
    const res = el('div', 'card');
    res.style.marginTop = '14px';
    res.appendChild(el('h3', null, 'Recent results'));
    for (const r of c.results.slice(-8).reverse()) {
      const p = el('p', null,
        `R${r.round + 1}  ${TEAMS.find((t) => t.id === r.home).short} ${r.home_score ?? r.home} - ${r.away_score ?? r.away} ${TEAMS.find((t) => t.id === r.away).short}${r.simulated ? '  (model)' : '  (played)'}`);
      p.style.margin = '0 0 4px';
      p.style.fontFamily = 'var(--mono)';
      res.appendChild(p);
    }
    body.appendChild(res);
  }

  const a = el('div', 'actions');
  const back = el('button', 'btn ghost', 'Back');
  back.addEventListener('click', () => mgr.show('careerHub'));
  a.appendChild(back);
  body.appendChild(a);
}));

registerScreen('careerTransfers', (game, params, mgr) => shell('Transfers', (body) => {
  const c = game.career;
  const card = el('div', 'card');
  card.appendChild(el('h3', null, `Free agents · budget ${c.board.budget}`));
  const table = el('table', 'data');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Name', 'Pos', 'Age', 'OVR', 'POT', 'Fee', '']) hr.appendChild(el('th', null, h));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tb = el('tbody');
  for (const p of c.freeAgents) {
    const tr = el('tr');
    tr.appendChild(el('td', null, p.name));
    tr.appendChild(el('td', null, p.position));
    tr.appendChild(el('td', 'num', String(p.age)));
    tr.appendChild(el('td', 'num', String(p.overall)));
    tr.appendChild(el('td', 'num', String(p.potential)));
    tr.appendChild(el('td', 'num', String(p.askingPrice)));
    const td = el('td');
    const b = el('button', 'chip', 'Sign');
    b.disabled = p.askingPrice > c.board.budget;
    b.addEventListener('click', () => {
      const r = c.signFreeAgent(p.id);
      if (!r.ok) mgr.toast(humanise(r.reason));
      else { game.saveCareer(); mgr.show('careerTransfers'); }
    });
    td.appendChild(b);
    tr.appendChild(td);
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  card.appendChild(table);
  body.appendChild(card);

  const a = el('div', 'actions');
  const back = el('button', 'btn ghost', 'Back');
  back.addEventListener('click', () => mgr.show('careerHub'));
  a.appendChild(back);
  body.appendChild(a);
}));


// --- Player Market -----------------------------------------------------------
registerScreen('careerMarket', (game, params, mgr) => shell('Player Market', (body) => {
  const c = game.career;
  body.appendChild(el('p', null, `Transfer budget: $${c.board.budget}. Sign players for a fee (potential shown 1-10). Free agents cost only wages.`));

  const section = (title, list, from) => {
    const card = el('div', 'card'); card.style.marginTop = '14px';
    card.appendChild(el('h3', null, title));
    const table = el('table', 'data'); const thead = el('thead'); const hr = el('tr');
    for (const h of ['Name', 'Pos', 'Age', 'OVR', 'Stars', 'POT', 'Fee', '']) hr.appendChild(el('th', h === 'OVR' ? 'num' : null, h));
    thead.appendChild(hr); table.appendChild(thead);
    const tb = el('tbody');
    for (const p of list) {
      const tr = el('tr');
      tr.appendChild(el('td', null, p.name));
      tr.appendChild(el('td', null, p.position));
      tr.appendChild(el('td', 'num', String(p.age)));
      tr.appendChild(el('td', 'num', String(p.overall)));
      const st = el('td', null, starString(p.overall)); st.style.color = '#f4c430'; tr.appendChild(st);
      const pot = el('td', null, `${p.pot10}/10`); pot.style.color = p.pot10 >= 8 ? '#5ef08a' : p.pot10 >= 6 ? '#8be9fd' : 'var(--muted)'; tr.appendChild(pot);
      tr.appendChild(el('td', 'num', from === 'free' ? 'Free' : `$${p.askingPrice}`));
      const td = el('td'); const b = el('button', 'chip', 'Sign');
      b.disabled = (from !== 'free' && p.askingPrice > c.board.budget) || c.squad.length >= 18;
      b.addEventListener('click', () => { const r = c.signProspect(p.id, from); if (!r.ok) mgr.toast(humanise(r.reason)); else { game.saveCareer(); mgr.show('careerMarket'); } });
      td.appendChild(b); tr.appendChild(td);
      tb.appendChild(tr);
    }
    table.appendChild(tb); card.appendChild(table); body.appendChild(card);
  };
  section('Transfer targets', c.market ?? [], 'market');
  if (c.freeAgents?.length) section('Free agents', c.freeAgents, 'free');

  const a = el('div', 'actions'); const back = el('button', 'btn ghost', 'Back'); back.addEventListener('click', () => mgr.show('careerHub'));
  a.appendChild(back); body.appendChild(a);
}));

// --- Academy Intake ----------------------------------------------------------
registerScreen('careerAcademy', (game, params, mgr) => shell('Academy Intake', (body) => {
  const c = game.career;
  body.appendChild(el('p', null,
    'Every season the academy produces prospects. They start raw (1-2 stars) but a high potential (up to 10) means a gem can grow into a 5-star player over a few seasons of game time and development. Sign the ones you believe in.'));
  if (!c.academyIntake || !c.academyIntake.length) {
    body.appendChild(el('div', 'card', ''));
    body.lastChild.appendChild(el('h3', null, 'No prospects right now'));
    body.lastChild.appendChild(el('p', null, 'The next intake arrives at the start of next season.'));
  } else {
    const grid = el('div', 'grid grid-3');
    for (const p of c.academyIntake) {
      const card = el('div', 'card');
      card.appendChild(el('div', 'tc-name', p.name));
      card.appendChild(el('div', 'tc-city', `${POSITION_NAMES[p.position]} · age ${p.age}`));
      const stars = el('div', null, starString(p.overall)); stars.style.color = '#f4c430'; stars.style.fontSize = '15px'; card.appendChild(stars);
      const potRow = el('div', 'mi-desc');
      potRow.innerHTML = `OVR <b>${p.overall}</b> · Potential <b style="color:${p.pot10 >= 8 ? '#5ef08a' : '#8be9fd'}">${p.pot10}/10</b>`;
      card.appendChild(potRow);
      const b = el('button', 'chip', `Sign · $${p.askingPrice}`);
      b.style.marginTop = '10px';
      b.disabled = p.askingPrice > c.board.budget || c.squad.length >= 18;
      b.addEventListener('click', () => { const r = c.signProspect(p.id, 'academy'); if (!r.ok) mgr.toast(humanise(r.reason)); else { game.saveCareer(); mgr.show('careerAcademy'); } });
      card.appendChild(b);
      grid.appendChild(card);
    }
    body.appendChild(grid);
  }
  const a = el('div', 'actions'); const back = el('button', 'btn ghost', 'Back'); back.addEventListener('click', () => mgr.show('careerHub'));
  a.appendChild(back); body.appendChild(a);
}));
