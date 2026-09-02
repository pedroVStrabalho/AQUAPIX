/**
 * In-match HUD and broadcast presentation (Design Bible sections 15.6, 28 and 29).
 *
 * Displays score, period, game clock, possession clock, team in possession,
 * active exclusions with countdowns, the controlled athlete, stamina, personal
 * fouls, timeout availability, tactical state and substitution status - and,
 * after a call, exactly which athlete fouled, what category it was, where it
 * happened and why, so the user always understands the decision.
 *
 * The visual language is original to AQUASTRIKE: a waterline motif, deep marine
 * blues, and a monospaced clock treatment.
 */

import { clamp01, lerp } from '../core/Math2.js';
import { MATCH_STATE } from '../rules/RulesEngine.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

export class HUD {
  constructor(root, sim) {
    this.sim = sim;
    this.root = root;
    this.node = el('div', 'hud');
    root.appendChild(this.node);
    this._build();
    this._hookEvents();
    this.callTimer = 0;
    this.bannerTimer = 0;
    this.lastScore = { home: -1, away: -1 };
  }

  _build() {
    const sim = this.sim;

    // ---- Score bug ---------------------------------------------------------
    const bug = el('div', 'hud-scorebug');
    this.node.appendChild(bug);

    const home = el('div', 'sb-team sb-home');
    home.style.setProperty('--team', sim.homeTeam.colors.primary);
    home.appendChild(el('span', 'sb-abbr', sim.homeTeam.short));
    this.homeScore = el('span', 'sb-score', '0');
    home.appendChild(this.homeScore);
    this.homeAdv = el('span', 'sb-adv', '');
    home.appendChild(this.homeAdv);
    bug.appendChild(home);

    const centre = el('div', 'sb-centre');
    this.periodLabel = el('div', 'sb-period', 'P1');
    this.gameClock = el('div', 'sb-clock', '8:00');
    centre.appendChild(this.periodLabel);
    centre.appendChild(this.gameClock);
    bug.appendChild(centre);

    const away = el('div', 'sb-team sb-away');
    away.style.setProperty('--team', sim.awayTeam.colors.primary);
    this.awayAdv = el('span', 'sb-adv', '');
    away.appendChild(this.awayAdv);
    this.awayScore = el('span', 'sb-score', '0');
    away.appendChild(this.awayScore);
    away.appendChild(el('span', 'sb-abbr', sim.awayTeam.short));
    bug.appendChild(away);

    // ---- Possession clock --------------------------------------------------
    this.shotClockWrap = el('div', 'hud-shotclock');
    this.shotClockValue = el('div', 'sc-value', '28');
    this.shotClockLabel = el('div', 'sc-label', 'POSSESSION');
    this.shotClockWrap.appendChild(this.shotClockValue);
    this.shotClockWrap.appendChild(this.shotClockLabel);
    this.node.appendChild(this.shotClockWrap);

    // ---- Possession arrow + timeouts --------------------------------------
    this.possessionBar = el('div', 'hud-possession');
    this.node.appendChild(this.possessionBar);

    // ---- Exclusions --------------------------------------------------------
    this.exclusionPanel = el('div', 'hud-exclusions');
    this.node.appendChild(this.exclusionPanel);

    // ---- Controlled athlete ------------------------------------------------
    this.playerCard = el('div', 'hud-player');
    this.node.appendChild(this.playerCard);

    // ---- Referee call explanation -----------------------------------------
    this.callCard = el('div', 'hud-call');
    this.node.appendChild(this.callCard);

    // ---- Event banner ------------------------------------------------------
    this.banner = el('div', 'hud-banner');
    this.node.appendChild(this.banner);

    // ---- Commentary / timeline ticker -------------------------------------
    this.ticker = el('div', 'hud-ticker');
    this.node.appendChild(this.ticker);

    // ---- Tactical state ----------------------------------------------------
    this.tacticalChip = el('div', 'hud-tactical');
    this.node.appendChild(this.tacticalChip);

    // ---- Rules profile badge (section 7.1: the active profile must show) ---
    this.profileBadge = el('div', 'hud-profile', `${sim.profile.name} · ${sim.profile.governingBody}`);
    this.node.appendChild(this.profileBadge);

    // ---- Shot quality readout ---------------------------------------------
    this.shotQuality = el('div', 'hud-shotq');
    this.node.appendChild(this.shotQuality);
  }

  _hookEvents() {
    const sim = this.sim;
    sim.bus.on('goal', ({ side, scorer }) => {
      this.showBanner('GOAL', scorer ? `#${scorer.player.capNumber} ${scorer.player.name}` : sim.teamOf(side).name, side);
    });
    sim.bus.on('foul', ({ explanation }) => {
      this.showCall(explanation);
    });
    sim.bus.on('save', ({ gk }) => {
      this.showBanner('SAVE', `#${gk.player.capNumber} ${gk.player.name}`, gk.side, 1.4);
    });
    sim.bus.on('timeline', ({ text }) => this.pushTicker(text));
    sim.bus.on('substitutionRejected', ({ reason }) => {
      this.showBanner('SUBSTITUTION REFUSED', humanise(reason), null, 2.2);
    });
  }

  showBanner(title, sub, side, seconds = 2.8) {
    this.banner.innerHTML = '';
    const t = el('div', 'banner-title', title);
    if (side) t.style.color = this.sim.teamOf(side).colors.primary;
    this.banner.appendChild(t);
    if (sub) this.banner.appendChild(el('div', 'banner-sub', sub));
    this.banner.classList.add('show');
    this.bannerTimer = seconds;
  }

  showCall(explanation) {
    if (!explanation) return;
    this.callCard.innerHTML = '';
    this.callCard.appendChild(el('div', 'call-head', explanation.headline));
    const grid = el('div', 'call-grid');
    grid.appendChild(el('div', 'call-k', 'Offender'));
    grid.appendChild(el('div', 'call-v', explanation.offender));
    grid.appendChild(el('div', 'call-k', 'Reason'));
    grid.appendChild(el('div', 'call-v', explanation.reason));
    grid.appendChild(el('div', 'call-k', 'Location'));
    grid.appendChild(el('div', 'call-v', explanation.location));
    grid.appendChild(el('div', 'call-k', 'Personal fouls'));
    grid.appendChild(el('div', `call-v ${explanation.personalFouls >= explanation.limit - 1 ? 'warn' : ''}`,
      `${explanation.personalFouls} of ${explanation.limit}`));
    this.callCard.appendChild(grid);
    this.callCard.classList.add('show');
    this.callTimer = 4.2;
  }

  pushTicker(text) {
    const line = el('div', 'ticker-line', text);
    this.ticker.prepend(line);
    while (this.ticker.children.length > 4) this.ticker.lastChild.remove();
    setTimeout(() => line.classList.add('fade'), 4200);
    setTimeout(() => line.remove(), 5400);
  }

  update(dt) {
    const sim = this.sim;

    // ---- Clocks ------------------------------------------------------------
    const m = Math.floor(sim.gameClock / 60);
    const s = Math.floor(sim.gameClock % 60);
    const tenths = Math.floor((sim.gameClock % 1) * 10);
    this.gameClock.textContent = sim.gameClock < 60
      ? `${s}.${tenths}`
      : `${m}:${String(s).padStart(2, '0')}`;
    this.gameClock.classList.toggle('urgent', sim.gameClock < 30);
    this.periodLabel.textContent = sim.state === MATCH_STATE.SHOOTOUT ? 'SO' : `P${sim.period}`;

    this.homeScore.textContent = sim.score.home;
    this.awayScore.textContent = sim.score.away;

    const sc = Math.ceil(sim.shotClock);
    this.shotClockValue.textContent = String(Math.max(0, sc)).padStart(2, '0');
    this.shotClockValue.classList.toggle('urgent', sim.shotClock < 5);
    this.shotClockLabel.textContent = sim.shotClockSecondary ? 'SECONDARY' : 'POSSESSION';
    this.shotClockWrap.classList.toggle('hidden', !sim.possession || !sim.isLive());

    // ---- Player advantage --------------------------------------------------
    const adv = sim.playerAdvantage('home');
    this.homeAdv.textContent = adv > 0 ? `+${adv}` : '';
    this.awayAdv.textContent = adv < 0 ? `+${-adv}` : '';

    // ---- Possession + timeouts --------------------------------------------
    this.possessionBar.innerHTML = '';
    for (const side of ['home', 'away']) {
      const team = sim.teamOf(side);
      const chip = el('div', `poss-chip ${sim.possession === side ? 'active' : ''}`);
      chip.style.setProperty('--team', team.colors.primary);
      chip.appendChild(el('span', 'poss-name', team.short));
      const dots = el('span', 'poss-dots');
      const left = sim.profile.timing.timeoutsPerTeam - sim.timeoutsUsed[side];
      for (let i = 0; i < sim.profile.timing.timeoutsPerTeam; i++) {
        dots.appendChild(el('i', i < left ? 'dot on' : 'dot'));
      }
      chip.appendChild(dots);
      this.possessionBar.appendChild(chip);
    }

    // ---- Exclusions --------------------------------------------------------
    this.exclusionPanel.innerHTML = '';
    if (sim.exclusions.length) {
      this.exclusionPanel.appendChild(el('div', 'exc-head', 'EXCLUSIONS'));
      for (const ex of sim.exclusions) {
        const row = el('div', 'exc-row');
        row.style.setProperty('--team', sim.teamOf(ex.side).colors.primary);
        row.appendChild(el('span', 'exc-cap', `#${ex.athlete.player.capNumber}`));
        row.appendChild(el('span', 'exc-name', ex.athlete.player.lastName));
        row.appendChild(el('span', 'exc-time', ex.forMatch ? 'OUT' : `${Math.max(0, ex.remaining).toFixed(1)}s`));
        const bar = el('div', 'exc-bar');
        const fill = el('i');
        fill.style.width = `${clamp01(ex.remaining / sim.profile.timing.exclusionSeconds) * 100}%`;
        bar.appendChild(fill);
        row.appendChild(bar);
        this.exclusionPanel.appendChild(row);
      }
    }

    // ---- Controlled athlete card ------------------------------------------
    const a = sim.userAthlete;
    if (a) {
      const p = a.player;
      const limit = sim.profile.discipline.personalFoulLimit;
      this.playerCard.innerHTML = '';
      const head = el('div', 'pc-head');
      head.style.setProperty('--team', sim.teamOf(a.side).colors.primary);
      head.appendChild(el('span', 'pc-cap', `${p.capNumber}`));
      const names = el('div', 'pc-names');
      names.appendChild(el('div', 'pc-name', p.name));
      names.appendChild(el('div', 'pc-pos', `${p.position}${p.leftHanded ? ' · L' : ''} · OVR ${p.overall}`));
      head.appendChild(names);
      this.playerCard.appendChild(head);

      const bars = el('div', 'pc-bars');
      bars.appendChild(this._bar('Burst', a.burst, '#38bdf8'));
      bars.appendChild(this._bar('Reserve', a.pool, '#22d3ee'));
      bars.appendChild(this._bar('Condition', 1 - a.matchFatigue, '#a3e635'));
      this.playerCard.appendChild(bars);

      const fouls = el('div', 'pc-fouls');
      for (let i = 0; i < limit; i++) {
        fouls.appendChild(el('i', i < a.personalFouls ? 'pf on' : 'pf'));
      }
      fouls.appendChild(el('span', 'pf-label', `${a.personalFouls}/${limit} personal`));
      this.playerCard.appendChild(fouls);
    }

    // ---- Tactical chip -----------------------------------------------------
    const t = sim.tactics[sim.userControlsSide];
    if (t) {
      const attacking = sim.possession === sim.userControlsSide;
      const advant = sim.playerAdvantage(sim.userControlsSide);
      const system = advant > 0 && attacking ? `EXTRA · ${t.extraPlayer}`
        : advant < 0 && !attacking ? `MAN DOWN · ${t.manDown}`
          : attacking ? t.offense : t.defense;
      this.tacticalChip.textContent = `${attacking ? 'ATTACK' : 'DEFENCE'} · ${humanise(system)}`;
      this.tacticalChip.classList.toggle('extra', advant > 0);
      this.tacticalChip.classList.toggle('down', advant < 0);
    }

    // ---- Estimated shot quality (labelled as an estimate, section 29.1) ----
    if (sim.lastShot && sim.clockNow - (sim.lastShot._at ?? 0) < 0.1) sim.lastShot._at = sim.clockNow;
    const carrier = sim.ball.holder;
    if (carrier && carrier === a && a.charging === 'shot') {
      const q = sim.lastShotEstimate ?? 0;
      this.shotQuality.classList.add('show');
      this.shotQuality.innerHTML = '';
      this.shotQuality.appendChild(el('div', 'sq-label', 'ESTIMATED SHOT QUALITY'));
      const bar = el('div', 'sq-bar');
      const fill = el('i');
      fill.style.width = `${q * 100}%`;
      fill.style.background = q > 0.6 ? '#4ade80' : q > 0.35 ? '#fbbf24' : '#f87171';
      bar.appendChild(fill);
      this.shotQuality.appendChild(bar);
    } else {
      this.shotQuality.classList.remove('show');
    }

    // ---- Timers ------------------------------------------------------------
    this.bannerTimer -= dt;
    if (this.bannerTimer <= 0) this.banner.classList.remove('show');
    this.callTimer -= dt;
    if (this.callTimer <= 0) this.callCard.classList.remove('show');

    // Goal flash.
    if (sim.presentation.goalFlash > 0.6) this.node.classList.add('flash');
    else this.node.classList.remove('flash');
  }

  _bar(label, value, color) {
    const wrap = el('div', 'pcb');
    wrap.appendChild(el('span', 'pcb-l', label));
    const bar = el('div', 'pcb-bar');
    const fill = el('i');
    fill.style.width = `${clamp01(value) * 100}%`;
    fill.style.background = color;
    bar.appendChild(fill);
    wrap.appendChild(bar);
    return wrap;
  }

  setVisible(v) { this.node.style.display = v ? '' : 'none'; }
  dispose() { this.node.remove(); }
}

export function humanise(s) {
  if (!s) return '';
  return String(s)
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}
