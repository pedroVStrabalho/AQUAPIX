/**
 * AQUAPIX - application shell.
 *
 * A top-down pixel-art water polo game. Owns the fixed-timestep loop, screen
 * routing and the match lifecycle, and bridges the tested simulation to the 2D
 * pixel renderer, the EAFC-style input layer, and the two career modes.
 */

import './ui/style.css';

import { generateLeague, TEAMS, defaultLineup } from './data/Teams.js';
import { getProfile } from './rules/RuleProfiles.js';
import { MatchSim, ASSIST_PROFILE } from './core/MatchSim.js';
import { PixelRenderer } from './render2d/PixelRenderer.js';
import { Input2D } from './ui/Input2D.js';
import { MatchHUD } from './ui/MatchHUD.js';
import { ScreenManager, el } from './ui/Screens.js';
import { ManagerCareer } from './modes/ManagerCareer.js';
import './modes/PlayerCareerScreens.js';
import { PlayerCareer } from './modes/PlayerCareer.js';
import { makeTeamTactics } from './ai/Tactics.js';
import { humanise } from './ui/HUD.js';
import { clamp } from './core/Math2.js';

const SAVE_CAREER = 'aquapix.career.v1';
const SAVE_PLAYER = 'aquapix.player.v1';
const SAVE_SETTINGS = 'aquapix.settings.v1';

class Game {
  constructor() {
    this.canvas = document.getElementById('gl');
    this.uiNode = document.getElementById('ui');
    this.league = generateLeague();
    this.playerLeague = null;    // separate league instance for player career

    this.settings = {
      splashDensity: 1, cameraShake: true, showHints: true,
      ...loadJson(SAVE_SETTINGS, {}),
    };

    this.matchConfig = {
      homeId: 'tidal', awayId: 'kraken', profileId: 'quick-4',
      difficulty: 'national', assist: ASSIST_PROFILE.STANDARD,
      refereeProfile: 'standard', userSide: 'home',
    };

    this.screens = new ScreenManager(this.uiNode, this);
    this.sim = null; this.renderer = null; this.input = null; this.hud = null;
    this.career = null; this.careerTactics = null;
    this.player = null;
    this.paused = false; this.overlay = null;
    this._acc = 0; this._last = performance.now(); this._fps = 60;

    window.addEventListener('resize', () => this.renderer?.resize());
    requestAnimationFrame(this._frame);
  }

  bootMenu() { this.canvas.style.opacity = '0'; this.screens.show('main'); }

  applySettings() {
    saveJson(SAVE_SETTINGS, this.settings);
    if (!this.renderer) return;
    this.renderer.setSetting('splash', this.settings.splashDensity);
    this.renderer.setSetting('screenShake', this.settings.cameraShake);
    this.renderer.setSetting('showHints', this.settings.showHints);
  }

  // =======================================================================
  // Match lifecycle
  // =======================================================================
  startQuickMatch() {
    const cfg = this.matchConfig;
    this._launchMatch({
      league: this.league,
      profile: getProfile(cfg.profileId), homeId: cfg.homeId, awayId: cfg.awayId,
      difficulty: cfg.difficulty, assist: cfg.assist, refereeProfile: cfg.refereeProfile,
      userSide: cfg.userSide, onEnd: () => this.showFullTime('main'),
    });
  }

  startTraining(drill) {
    const cfg = this.matchConfig;
    this._launchMatch({
      league: this.league, profile: getProfile('quick-2'),
      homeId: cfg.homeId ?? 'tidal', awayId: cfg.awayId ?? 'kraken',
      difficulty: 'club', assist: ASSIST_PROFILE.BEGINNER, refereeProfile: 'standard',
      userSide: 'home', drill, onEnd: () => this.showFullTime('training'),
    });
  }

  playCareerMatch(fixture) {
    const userIsHome = fixture.home === this.career.clubId;
    this._launchMatch({
      league: this.league, profile: getProfile('quick-6'),
      homeId: fixture.home, awayId: fixture.away,
      difficulty: this.matchConfig.difficulty, assist: this.matchConfig.assist,
      refereeProfile: 'standard', userSide: userIsHome ? 'home' : 'away',
      careerTactics: this.careerTactics, careerSide: userIsHome ? 'home' : 'away',
      onEnd: () => {
        this.career.completeRound({ home: this.sim.score.home, away: this.sim.score.away, simulated: false });
        this.saveCareer();
        this.showFullTime('careerHub');
      },
    });
  }

  _launchMatch(opts) {
    this.screens.clear();
    const loading = this._showLoading();
    requestAnimationFrame(() => setTimeout(() => {
      const league = opts.league ?? this.league;
      this.sim = new MatchSim({
        profile: opts.profile, league,
        homeId: opts.homeId, awayId: opts.awayId,
        seed: Math.floor(Math.random() * 0xffffffff),
        difficulty: opts.difficulty, assist: opts.assist,
        refereeProfile: opts.refereeProfile, userSide: opts.userSide,
      });

      if (opts.careerTactics && opts.careerSide) {
        Object.assign(this.sim.tactics[opts.careerSide], opts.careerTactics);
        this.sim.ai[opts.careerSide].tactics = this.sim.tactics[opts.careerSide];
      }

      // Player career: make sure YOU are on the field, control ONLY you.
      if (opts.userPlayerId) {
        this._ensurePlayerStarts(opts.userSide, opts.userPlayerId);
        this.sim.lockUserAthlete = true;
        this.sim.autoSwitch = false;
      }

      this.onMatchEnd = opts.onEnd;
      this.drill = opts.drill ?? null;

      this.renderer = new PixelRenderer(this.canvas, this.sim, { ...this.settings, splash: this.settings.splashDensity });
      this.canvas.style.opacity = '1';
      this.input = new Input2D(this.sim, { renderer: this.renderer, onUi: (e) => this._onUiAction(e) });
      this.hud = new MatchHUD(this.uiNode, this.sim);

      this.sim.bus.on('matchEnd', () => setTimeout(() => this.onMatchEnd?.(), 1600));

      if (opts.userSide) {
        const start = opts.userPlayerId
          ? this.sim.squads[opts.userSide].find((a) => a.player.id === opts.userPlayerId)
          : this.sim.autoSelectAthlete(opts.userSide);
        this.sim.setUserAthlete(start);
      }
      this.sim.start();
      this._applyDrill();
      loading.remove();
      this.screens.toast(this.sim.lockUserAthlete ? 'You control YOUR player only · WASD move · SPACE shoot/steal · J pass' : 'WASD move · SPACE shoot/steal · J pass · auto-switch on', 4200);
    }, 40));
  }

  /** Force the user's created player into the starting seven and control them. */
  _ensurePlayerStarts(side, playerId) {
    const sim = this.sim;
    const me = sim.squads[side].find((a) => a.player.id === playerId);
    if (!me) return;
    if (sim.active[side].includes(me)) { sim.setUserAthlete(me); return; }
    // Swap the weakest same-position (or any non-GK) starter for you.
    const pool = sim.active[side].filter((a) => !a.isGoalkeeper);
    let out = pool.filter((a) => a.player.position === me.player.position).sort((a, b) => a.player.overall - b.player.overall)[0]
      ?? pool.sort((a, b) => a.player.overall - b.player.overall)[0];
    if (out) {
      const ai = sim.active[side].indexOf(out);
      const bi = sim.bench[side].indexOf(me);
      if (bi < 0) sim.bench[side].push(me);
      sim.active[side][ai] = me;
      sim.bench[side][sim.bench[side].indexOf(me)] = out;
      me.inPool = true; out.inPool = false;
      const f = sim.profile.field;
      me.pos.set(out.pos.x, out.pos.z);
    }
    sim.setUserAthlete(me);
  }

  _applyDrill() {
    if (!this.drill || !this.sim) return;
    const sim = this.sim;
    if (this.drill === 'extraPlayer') {
      const v = sim.activeAthletes('away').find((a) => !a.isGoalkeeper);
      if (v) sim._excludeAthlete(v, 9999, false);
    } else if (this.drill === 'counter') sim.transitionTimer = 3.2;
    else if (this.drill === 'centre') { sim.tactics.home.offense = 'centreFirst'; sim.tactics.away.defense = 'centreFront'; }
    else if (this.drill === 'shooting') { sim.tactics.home.offense = 'perimeter'; sim.tactics.away.defense = 'mDrop'; }
  }

  endMatch() {
    this.input?.dispose(); this.hud?.dispose(); this.renderer = null; this.input = null; this.hud = null; this.sim = null;
    this.canvas.style.opacity = '0';
    this._closeOverlay();
  }

  // =======================================================================
  // Manager Career
  // =======================================================================
  startCareer(clubId) {
    this.career = new ManagerCareer(this.league, clubId);
    this.careerTactics = makeTeamTactics(TEAMS.find((t) => t.id === clubId).style);
    this.saveCareer();
    this.screens.show('careerHub');
  }
  resumeCareer(data) {
    this.career = ManagerCareer.restore(this.league, data);
    this.careerTactics = data.tactics ?? makeTeamTactics(TEAMS.find((t) => t.id === this.career.clubId).style);
    this.screens.show('careerHub');
  }
  saveCareer() { if (this.career) saveJson(SAVE_CAREER, { ...this.career.serialise(), tactics: this.careerTactics }); }
  loadCareerSave() { return loadJson(SAVE_CAREER, null); }

  // =======================================================================
  // Player Career
  // =======================================================================
  startPlayerCareer(draft) {
    this.playerLeague = generateLeague(Math.floor(Math.random() * 1e9));
    this.player = new PlayerCareer(this.playerLeague, draft);
    this.savePlayerCareer();
    this.screens.show('playerHub');
  }
  resumePlayerCareer(data) {
    this.playerLeague = generateLeague(data.leagueSeed ?? 20260727);
    this.player = PlayerCareer.restore(this.playerLeague, data);
    this.screens.show('playerHub');
  }
  savePlayerCareer() {
    if (this.player) saveJson(SAVE_PLAYER, { ...this.player.serialise(), leagueSeed: 20260727 });
  }
  loadPlayerSave() { return loadJson(SAVE_PLAYER, null); }

  playPlayerMatch() {
    const c = this.player;
    if (!c.pendingActivity) { this.screens.toast('Pick an activity first.'); return; }
    c._applyActivity();
    const fx = c.currentFixture();
    if (!fx) { this._afterPlayerWeek(null); return; }
    const userIsHome = fx.home === c.clubId;
    this._launchMatch({
      league: this.playerLeague, profile: getProfile('quick-4'),
      homeId: fx.home, awayId: fx.away,
      difficulty: this.matchConfig.difficulty, assist: this.matchConfig.assist,
      refereeProfile: 'standard', userSide: userIsHome ? 'home' : 'away',
      userPlayerId: 'ME',
      onEnd: () => {
        const meAthlete = this.sim.squads[userIsHome ? 'home' : 'away'].find((a) => a.player.id === 'ME');
        const st = meAthlete ? { ...meAthlete.stats } : freshMe();
        const myScore = userIsHome ? this.sim.score.home : this.sim.score.away;
        const oppScore = userIsHome ? this.sim.score.away : this.sim.score.home;
        const result = myScore > oppScore ? 'win' : myScore < oppScore ? 'loss' : 'draw';
        const rating = c.applyMyMatch(st, result);
        c.resolveOtherFixtures({ home: this.sim.score.home, away: this.sim.score.away });
        c.advanceWeek();
        this.savePlayerCareer();
        this._showPlayerMatchSummary(rating, st, myScore, oppScore);
      },
    });
  }

  simPlayerWeek() {
    const c = this.player;
    if (c.currentFixture() && !c.pendingActivity) { this.screens.toast('Pick an activity first.'); return; }
    if (c.pendingActivity) c._applyActivity();
    const fx = c.currentFixture();
    if (fx) {
      const myRes = c._quickResolve(fx);
      // Give yourself a modest simulated line so the season still progresses.
      const userIsHome = fx.home === c.clubId;
      const myScore = userIsHome ? myRes.home : myRes.away;
      const oppScore = userIsHome ? myRes.away : myRes.home;
      const st = freshMe();
      st.goals = Math.min(myScore, Math.round(Math.random() * (c.me.overall / 40)));
      const result = myScore > oppScore ? 'win' : myScore < oppScore ? 'loss' : 'draw';
      c.applyMyMatch(st, result);
      c.resolveOtherFixtures(myRes);
    }
    c.advanceWeek();
    this.savePlayerCareer();
    this.screens.show('playerHub');
  }

  _afterPlayerWeek() { this.player.advanceWeek(); this.savePlayerCareer(); this.screens.show('playerHub'); }

  _showPlayerMatchSummary(rating, st, myScore, oppScore) {
    this.endMatch();
    this._openOverlay((panel) => {
      panel.appendChild(el('h2', null, 'Full Time'));
      panel.appendChild(el('div', 'sub', `${this.player.club.short} ${myScore} - ${oppScore}`));
      const card = el('div', 'card');
      card.appendChild(el('h3', null, `Your match rating: ${rating.rating.toFixed(1)}${rating.motm ? '  ★ MAN OF THE MATCH' : ''}`));
      const rows = [
        ['Goals', st.goals], ['Assists', st.assists], ['Shots', st.shots], ['Steals', st.steals],
        ['Blocks', st.blocks], ['Saves', st.saves], ['Turnovers', st.turnovers], ['Personal fouls', st.personalFouls],
      ];
      const grid = el('div', 'grid grid-4');
      for (const [k, v] of rows) {
        const d = el('div', 'tc-stat'); d.appendChild(el('b', null, String(v ?? 0))); d.appendChild(document.createTextNode(k));
        grid.appendChild(d);
      }
      card.appendChild(grid);
      panel.appendChild(card);
      const a = el('div', 'actions');
      const cont = el('button', 'btn', 'Continue');
      cont.addEventListener('click', () => { this._closeOverlay(); this.screens.show('playerHub'); });
      a.appendChild(cont); panel.appendChild(a);
    });
  }

  // =======================================================================
  // In-match UI
  // =======================================================================
  _onUiAction(e) {
    const sim = this.sim; if (!sim) return;
    if (e.type === 'pause') this.togglePause();
    else if (e.type === 'timeout') { const r = sim.callTimeout(sim.userControlsSide); this.screens.toast(r.allowed ? 'Timeout.' : `Refused: ${humanise(r.reason)}`); }
  }

  togglePause() {
    if (this.overlay) { this._closeOverlay(); return; }
    this._openPause();
  }

  _openOverlay(builder) {
    this._closeOverlay();
    this.paused = true;
    if (this.sim) this.sim.paused = true;
    if (this.input) this.input.enabled = false;
    const o = el('div', 'overlay'); const panel = el('div', 'panel');
    builder(panel); o.appendChild(panel); this.uiNode.appendChild(o); this.overlay = o;
    return panel;
  }
  _closeOverlay() {
    if (this.overlay) { this.overlay.remove(); this.overlay = null; }
    this.paused = false;
    if (this.sim) this.sim.paused = false;
    if (this.input) { this.input.enabled = true; this.input.down.clear(); }
  }

  _openPause() {
    this._openOverlay((panel) => {
      panel.appendChild(el('h2', null, 'Paused'));
      panel.appendChild(el('div', 'sub',
        `${this.sim.homeTeam.name} ${this.sim.score.home} - ${this.sim.score.away} ${this.sim.awayTeam.name} · Period ${this.sim.period}`));
      const actions = el('div', 'actions');
      const mk = (label, fn, ghost = true) => { const b = el('button', `btn ${ghost ? 'ghost' : ''}`, label); b.addEventListener('click', fn); return b; };
      actions.appendChild(mk('Resume', () => this._closeOverlay(), false));
      actions.appendChild(mk('Statistics', () => this._openStats()));
      actions.appendChild(mk('Abandon', () => {
        this._closeOverlay(); this.endMatch();
        this.screens.show(this.player ? 'playerHub' : this.career ? 'careerHub' : 'main');
      }));
      panel.appendChild(actions);

      const s = el('div', 'card'); s.style.marginTop = '18px'; s.appendChild(el('h3', null, 'Quick settings'));
      const row = (label, options, value, onPick) => {
        const r = el('div', 'field-row'); r.appendChild(el('div', 'field-label', label));
        const wrap = el('div', 'field-control');
        for (const o of options) { const c = el('button', `chip ${o.value === value ? 'on' : ''}`, o.label); c.addEventListener('click', () => { onPick(o.value); this._openPause(); }); wrap.appendChild(c); }
        r.appendChild(wrap); return r;
      };
      s.appendChild(row('Splash', [{ value: 0, label: 'Off' }, { value: 0.5, label: 'Low' }, { value: 1, label: 'Full' }, { value: 1.5, label: 'Max' }],
        this.settings.splashDensity, (v) => { this.settings.splashDensity = v; this.applySettings(); }));
      s.appendChild(row('Screen shake', [{ value: true, label: 'On' }, { value: false, label: 'Off' }],
        this.settings.cameraShake, (v) => { this.settings.cameraShake = v; this.applySettings(); }));
      panel.appendChild(s);
    });
  }

  _openStats() {
    const pkg = this.sim.statsPackage();
    this._openOverlay((panel) => {
      panel.appendChild(el('h2', null, 'Match Statistics'));
      panel.appendChild(el('div', 'sub', `${pkg.home.team.name} ${pkg.score.home} - ${pkg.score.away} ${pkg.away.team.name}`));
      buildStatsBody(panel, pkg);
      const a = el('div', 'actions'); const back = el('button', 'btn', 'Resume'); back.addEventListener('click', () => this._closeOverlay());
      a.appendChild(back); panel.appendChild(a);
    });
  }

  showFullTime(next) {
    if (!this.sim) { this.screens.show(next); return; }
    const pkg = this.sim.statsPackage();
    this._openOverlay((panel) => {
      const winner = pkg.score.home === pkg.score.away ? null : (pkg.score.home > pkg.score.away ? 'home' : 'away');
      panel.appendChild(el('h2', null, 'Full Time'));
      panel.appendChild(el('div', 'sub', `${pkg.home.team.name} ${pkg.score.home} - ${pkg.score.away} ${pkg.away.team.name}${winner ? '' : '  ·  draw'}`));
      buildStatsBody(panel, pkg);
      const a = el('div', 'actions'); const cont = el('button', 'btn', 'Continue');
      cont.addEventListener('click', () => { this._closeOverlay(); this.endMatch(); this.screens.show(next); });
      a.appendChild(cont); panel.appendChild(a);
    });
  }

  _showLoading() {
    const l = el('div', 'loading'); const inner = el('div', 'loading-inner');
    inner.appendChild(el('div', 'brand', 'AQUAPIX'));
    inner.appendChild(el('div', 'brand-sub', 'Feel every splash. Command the water.'));
    const bar = el('div', 'loading-bar'); const fill = el('i'); bar.appendChild(fill); inner.appendChild(bar);
    const msg = el('div', 'loading-msg', 'Filling the pool'); inner.appendChild(msg);
    l.appendChild(inner); this.uiNode.appendChild(l);
    const steps = ['Filling the pool', 'Rigging the lane ropes', 'Warming up the keepers', 'Briefing the referees'];
    let i = 0; const iv = setInterval(() => { i++; fill.style.width = `${Math.min(100, i * 26)}%`; msg.textContent = steps[Math.min(i, steps.length - 1)]; if (i > 4) clearInterval(iv); }, 120);
    return l;
  }

  // =======================================================================
  // Loop
  // =======================================================================
  _frame = (now) => {
    requestAnimationFrame(this._frame);
    const raw = (now - this._last) / 1000; this._last = now;
    const dt = Math.min(raw, 0.1);
    this._fps += ((1 / Math.max(raw, 1e-4)) - this._fps) * 0.06;
    if (!this.sim || !this.renderer) return;

    if (!this.paused) { this.sim.userCommand = this.input.update(dt); }

    if (!this.paused) {
      const step = 1 / 120;
      this._acc = Math.min(this._acc + dt, 0.25);
      let guard = 0;
      while (this._acc >= step && guard < 30) { this.sim.update(step); this._acc -= step; guard++; }
    }
    this.renderer.update(this.paused ? 0 : dt, this.sim);
    this.renderer.render();
    this.hud?.update(dt);
  };
}

function freshMe() {
  return { goals: 0, assists: 0, shots: 0, steals: 0, blocks: 0, saves: 0, turnovers: 0, personalFouls: 0 };
}

function buildStatsBody(panel, pkg) {
  const bars = el('div', 'card'); bars.appendChild(el('h3', null, 'Team comparison'));
  const rows = [
    ['Goals', pkg.home.goals, pkg.away.goals], ['Shots', pkg.home.shots, pkg.away.shots],
    ['Shooting %', pkg.home.shootingPct, pkg.away.shootingPct], ['Saves', pkg.home.saves, pkg.away.saves],
    ['Steals', pkg.home.steals, pkg.away.steals], ['Turnovers', pkg.home.turnovers, pkg.away.turnovers],
    ['Ordinary fouls', pkg.home.ordinaryFouls, pkg.away.ordinaryFouls],
    ['Exclusions drawn', pkg.home.exclusionsDrawn, pkg.away.exclusionsDrawn],
    ['Extra-player %', pkg.home.extraPlayerConversion, pkg.away.extraPlayerConversion],
    ['Counter goals', pkg.home.counterGoals, pkg.away.counterGoals],
    ['Pass %', pkg.home.passCompletion, pkg.away.passCompletion],
    ['Possession (s)', pkg.home.possessionTime, pkg.away.possessionTime],
  ];
  for (const [name, h, a] of rows) {
    const line = el('div', 'stat-line');
    line.appendChild(el('div', 'v', String(h)));
    line.appendChild(el('div', 'n', name));
    line.appendChild(el('div', 'v r', String(a)));
    const bar = el('div', 'stat-bar'); const total = (h + a) || 1;
    const hi = el('i'); hi.style.width = `${(h / total) * 100}%`; hi.style.background = pkg.home.team.colors.primary;
    const ai = el('i'); ai.style.width = `${(a / total) * 100}%`; ai.style.background = pkg.away.team.colors.primary;
    bar.appendChild(hi); bar.appendChild(ai); line.appendChild(bar); bars.appendChild(line);
  }
  panel.appendChild(bars);

  const grid = el('div', 'grid grid-2'); grid.style.marginTop = '14px';
  for (const side of ['home', 'away']) {
    const s = pkg[side]; const card = el('div', 'card'); card.appendChild(el('h3', null, s.team.name));
    const table = el('table', 'data'); const thead = el('thead'); const hr = el('tr');
    for (const h of ['#', 'Athlete', 'G', 'A', 'Sh', 'St', 'Sv']) hr.appendChild(el('th', h.length <= 2 && h !== 'Athlete' ? 'num' : null, h));
    thead.appendChild(hr); table.appendChild(thead); const tb = el('tbody');
    for (const p of s.players.slice(0, 9)) {
      const tr = el('tr');
      if (p.cap && s.players && p.name && p.cap) {}
      tr.appendChild(el('td', 'num', String(p.cap)));
      tr.appendChild(el('td', null, p.name));
      for (const v of [p.goals, p.assists, p.shots, p.steals, p.saves]) tr.appendChild(el('td', 'num', String(v)));
      tb.appendChild(tr);
    }
    table.appendChild(tb); card.appendChild(table); grid.appendChild(card);
  }
  panel.appendChild(grid);
}

function saveJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }
function loadJson(k, f) { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : f; } catch { return f; } }

const game = new Game();
game.bootMenu();
window.AQUAPIX = game;
