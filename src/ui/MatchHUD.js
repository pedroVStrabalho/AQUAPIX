/**
 * AQUAPIX match HUD - a crisp DOM overlay over the pixel canvas.
 *
 * The world is drawn pixelated; the HUD is DOM so the text is always sharp and
 * readable. Includes an always-on, context-aware control bar at the bottom so
 * the player never has to guess how to shoot, pass or defend.
 */

import { clamp01 } from '../core/Math2.js';
import { starString } from '../data/DisplayStats.js';

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

export class MatchHUD {
  constructor(root, sim) {
    this.sim = sim;
    this.node = el('div', 'mhud');
    root.appendChild(this.node);
    this._build();
    this.bannerTimer = 0;
    sim.bus.on('goal', ({ side, scorer }) => this._banner('GOAL!', scorer ? `#${scorer.player.capNumber} ${scorer.player.name}` : sim.teamOf(side).name, side));
    sim.bus.on('save', ({ gk }) => this._banner('SAVE!', `#${gk.player.capNumber} ${gk.player.name}`, gk.side, 1.2));
    sim.bus.on('foul', ({ explanation }) => { if (explanation) this._toast(`${explanation.headline}  ${explanation.offender}`); });
    sim.bus.on('timeline', ({ text }) => this._toast(text));
    this._toastTimer = 0;
  }

  _build() {
    const sim = this.sim;

    // Top scoreboard.
    const bug = el('div', 'mh-bug');
    const home = el('div', 'mh-team mh-home');
    home.style.setProperty('--tc', sim.homeTeam.colors.primary);
    home.appendChild(el('span', 'mh-abbr', sim.homeTeam.short));
    this.hScore = el('span', 'mh-score', '0'); home.appendChild(this.hScore);
    bug.appendChild(home);

    const mid = el('div', 'mh-mid');
    this.period = el('div', 'mh-period', 'P1');
    this.clock = el('div', 'mh-clock', '4:00');
    mid.appendChild(this.period); mid.appendChild(this.clock);
    bug.appendChild(mid);

    const away = el('div', 'mh-team mh-away');
    away.style.setProperty('--tc', sim.awayTeam.colors.primary);
    this.aScore = el('span', 'mh-score', '0'); away.appendChild(this.aScore);
    away.appendChild(el('span', 'mh-abbr', sim.awayTeam.short));
    bug.appendChild(away);
    this.node.appendChild(bug);

    // Shot clock.
    this.shotClock = el('div', 'mh-shotclock', '28');
    this.node.appendChild(this.shotClock);

    // Exclusions.
    this.excl = el('div', 'mh-excl');
    this.node.appendChild(this.excl);

    // Player card.
    this.card = el('div', 'mh-card');
    this.node.appendChild(this.card);

    // Banner (GOAL/SAVE).
    this.banner = el('div', 'mh-banner');
    this.node.appendChild(this.banner);

    // Toast (events).
    this.toast = el('div', 'mh-toast');
    this.node.appendChild(this.toast);

    // Always-on control bar.
    this.controls = el('div', 'mh-controls');
    this.node.appendChild(this.controls);
  }

  _banner(title, sub, side, secs = 2.4) {
    this.banner.innerHTML = '';
    const t = el('div', 'mh-banner-t', title);
    if (side) t.style.color = this.sim.teamOf(side).colors.primary;
    this.banner.appendChild(t);
    if (sub) this.banner.appendChild(el('div', 'mh-banner-s', sub));
    this.banner.classList.add('show');
    this.bannerTimer = secs;
  }

  _toast(text) {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    this._toastTimer = 2.6;
  }

  update(dt) {
    const sim = this.sim;
    this.hScore.textContent = sim.score.home;
    this.aScore.textContent = sim.score.away;
    const m = Math.floor(sim.gameClock / 60), s = Math.floor(sim.gameClock % 60);
    this.clock.textContent = sim.gameClock < 60 ? `0:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
    this.clock.classList.toggle('urgent', sim.gameClock < 30);
    this.period.textContent = sim.state === 'shootout' ? 'SHOOTOUT' : `PERIOD ${sim.period}`;

    // Shot clock.
    if (sim.possession && sim.isLive()) {
      this.shotClock.style.display = '';
      const sc = Math.max(0, Math.ceil(sim.shotClock));
      this.shotClock.textContent = String(sc);
      this.shotClock.classList.toggle('urgent', sim.shotClock < 5);
      this.shotClock.style.borderColor = `var(--tc-${sim.possession})`;
      this.shotClock.style.setProperty('--tc-home', sim.homeTeam.colors.primary);
      this.shotClock.style.setProperty('--tc-away', sim.awayTeam.colors.primary);
    } else {
      this.shotClock.style.display = 'none';
    }

    // Exclusions.
    this.excl.innerHTML = '';
    for (const ex of sim.exclusions.slice(0, 6)) {
      const row = el('div', 'mh-exrow');
      row.style.borderColor = sim.teamOf(ex.side).colors.primary;
      row.appendChild(el('span', null, `#${ex.athlete.player.capNumber}`));
      row.appendChild(el('span', 'mh-extime', ex.forMatch ? 'OUT' : `${Math.max(0, Math.ceil(ex.remaining))}s`));
      this.excl.appendChild(row);
    }

    // Player card.
    const a = sim.userAthlete;
    if (a) {
      this.card.style.display = '';
      this.card.style.setProperty('--tc', sim.teamOf(a.side).colors.primary);
      const lim = sim.profile.discipline.personalFoulLimit;
      this.card.innerHTML = `
        <div class="mh-cardhead">
          <span class="mh-cap">${a.player.capNumber}</span>
          <div>
            <div class="mh-cname">${a.player.name}</div>
            <div class="mh-cmeta">${a.player.position} · OVR ${a.player.overall} <span class="mh-stars">${starString(a.player.overall)}</span></div>
          </div>
        </div>

        <div class="mh-barrow"><span>READINESS</span><div class="mh-bar"><i style="width:${Math.round(clamp01(a.readiness) * 100)}%;background:${a.readiness >= 0.7 ? '#5ef08a' : a.readiness > 0.4 ? '#ffcf4d' : '#ff5a5a'}"></i></div></div>
        <div class="mh-fouls">${Array.from({ length: lim }, (_, i) => `<b class="${i < a.personalFouls ? 'on' : ''}"></b>`).join('')}<span>fouls</span></div>`;
    } else {
      this.card.style.display = 'none';
    }

    // Control bar - context aware.
    this._updateControls(a);

    // Timers.
    this.bannerTimer -= dt; if (this.bannerTimer <= 0) this.banner.classList.remove('show');
    this._toastTimer -= dt; if (this._toastTimer <= 0) this.toast.classList.remove('show');
  }

  _updateControls(a) {
    const sim = this.sim;
    const touch = 'ontouchstart' in window;
    let items;
    if (!a) {
      items = [['—', 'Waiting']];
    } else if (a.hasBall) {
      items = touch
        ? [['SHOOT', 'hold + release'], ['PASS', 'to a teammate'], ['SWIM', 'sprint']]
        : [['X', 'Shoot'], ['Z', 'Pass'], ['C', 'Lob pass'], ['⇧', 'Sprint'], ['Q', 'Protect']];
    } else if (sim.possession === a.side) {
      items = touch
        ? [['SWIM', 'get open'], ['PASS', 'call']]
        : [['WASD', 'Move / get open'], ['Z', 'Call for ball'], ['⇧', 'Sprint']];
    } else {
      items = touch
        ? [['STEAL', 'tackle'], ['SWITCH', 'nearest']]
        : [['X', 'Steal'], ['Z', 'Raise arm / block'], ['⇧', 'Press'], ...(sim.lockUserAthlete ? [] : [['E', 'Switch player']])];
    }
    this.controls.innerHTML = items.map(([k, d]) => `<span class="mh-ctl"><b>${k}</b>${d}</span>`).join('');
  }

  setVisible(v) { this.node.style.display = v ? '' : 'none'; }
  dispose() { this.node.remove(); }
}
