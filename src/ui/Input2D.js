/**
 * AQUAPIX input - top-down, EAFC-style.
 *
 * You drive one player at a time. On attack it is the ball carrier; off the ball
 * you can switch to the teammate nearest the action; on defence you switch to the
 * nearest defender and press, steal or block. Movement is screen-relative and the
 * renderer keeps your attacking goal at the top, so "up" is always "forward".
 *
 * Supports keyboard, mouse and touch (a virtual stick + action buttons).
 */

import { Vec2, clamp, clamp01 } from '../core/Math2.js';
import { PASS_TYPES, SHOT_TYPES } from '../gameplay/Actions.js';

const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  Space: 'action1',   // shoot (attack) / tackle-steal (defence)
  KeyJ: 'action2',    // pass (attack) / switch (defence)
  KeyK: 'action1',
  KeyL: 'action3',    // lob/skip modifier (attack) / block (defence)
  KeyE: 'switch',     // manual switch player
  KeyQ: 'modifier',   // sprint alt / pump-fake
  KeyG: 'gk',         // toggle goalkeeper control
};

export class Input2D {
  constructor(sim, opts = {}) {
    this.sim = sim;
    this.renderer = opts.renderer;   // to read flip
    this.onUi = opts.onUi ?? (() => {});
    this.enabled = true;
    this.down = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.stick = { x: 0, y: 0, active: false };  // touch joystick, -1..1
    this.touchButtons = {};
    this._time = 0;

    this._kd = (e) => {
      const a = KEYMAP[e.code];
      if (!a) return;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!this.down.has(a)) this.pressed.add(a);
      this.down.add(a);
    };
    this._ku = (e) => {
      const a = KEYMAP[e.code];
      if (!a) return;
      this.down.delete(a);
      this.released.add(a);
    };
    window.addEventListener('keydown', this._kd);
    window.addEventListener('keyup', this._ku);

    this._setupTouch(opts.touchLayer);
  }

  dispose() {
    window.removeEventListener('keydown', this._kd);
    window.removeEventListener('keyup', this._ku);
    if (this._touchEl) this._touchEl.remove();
  }

  isDown(a) { return this.down.has(a) || this.touchButtons[a]; }
  hit(a) { return this.pressed.has(a) || this._touchHit?.[a]; }
  up(a) { return this.released.has(a) || this._touchUp?.[a]; }

  // ---- Touch UI ----------------------------------------------------------
  _setupTouch(layer) {
    if (!('ontouchstart' in window) && navigator.maxTouchPoints === 0) return;
    // Left half of the screen is a floating joystick; right side has buttons.
    const el = document.createElement('div');
    el.className = 'touch-controls';
    el.innerHTML = `
      <div class="tc-stick" id="tc-stick"><div class="tc-knob" id="tc-knob"></div></div>
      <div class="tc-buttons">
        <button class="tc-btn tc-a" data-act="action1">SHOOT</button>
        <button class="tc-btn tc-b" data-act="action2">PASS</button>
        <button class="tc-btn tc-c" data-act="sprint">SWIM</button>
        <button class="tc-btn tc-d" data-act="switch">SWITCH</button>
      </div>`;
    (layer ?? document.getElementById('ui') ?? document.body).appendChild(el);
    this._touchEl = el;
    this._touchHit = {}; this._touchUp = {};

    const stick = el.querySelector('#tc-stick');
    const knob = el.querySelector('#tc-knob');
    let stickId = null, sx0 = 0, sy0 = 0;
    const startStick = (t) => { stickId = t.identifier; sx0 = t.clientX; sy0 = t.clientY; this.stick.active = true; };
    const moveStick = (t) => {
      const dx = clamp((t.clientX - sx0) / 44, -1, 1);
      const dy = clamp((t.clientY - sy0) / 44, -1, 1);
      this.stick.x = dx; this.stick.y = dy;
      knob.style.transform = `translate(${dx * 22}px,${dy * 22}px)`;
    };
    const endStick = () => { stickId = null; this.stick.x = this.stick.y = 0; this.stick.active = false; knob.style.transform = 'translate(0,0)'; };

    el.addEventListener('touchstart', (e) => {
      for (const t of e.changedTouches) {
        if (t.clientX < window.innerWidth * 0.5 && stickId === null) startStick(t);
      }
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) if (t.identifier === stickId) moveStick(t);
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      for (const t of e.changedTouches) if (t.identifier === stickId) endStick();
    }, { passive: true });

    for (const btn of el.querySelectorAll('.tc-btn')) {
      const act = btn.dataset.act;
      btn.addEventListener('touchstart', (e) => { e.preventDefault(); this.touchButtons[act] = true; this._touchHit[act] = true; }, { passive: false });
      btn.addEventListener('touchend', (e) => { e.preventDefault(); this.touchButtons[act] = false; this._touchUp[act] = true; }, { passive: false });
    }
  }

  // ---- Per-frame ---------------------------------------------------------
  update(dt) {
    this._time += dt;
    const sim = this.sim;
    const cmd = { dir: null, effort: 0, rise: 0, face: null, brace: false, saveAim: null };
    if (!this.enabled) { this._clear(); return cmd; }

    // Manual switch / GK toggle - only when you command the whole team.
    if (!sim.lockUserAthlete) {
      if (this.hit('switch')) sim.switchAthlete(sim.userControlsSide, 1);
      if (this.hit('gk')) sim.toggleGoalkeeperControl();
    }

    const a = sim.userAthlete;
    if (!a || !a.inPool) { this._clear(); return cmd; }

    // ---- Movement (screen -> world, flip-aware) --------------------------
    let sxin = 0, syin = 0;
    if (this.isDown('left')) sxin -= 1;
    if (this.isDown('right')) sxin += 1;
    if (this.isDown('up')) syin -= 1;
    if (this.isDown('down')) syin += 1;
    if (this.stick.active) { sxin = this.stick.x; syin = this.stick.y; }

    const flip = this.renderer?.flip ?? (sim.attackDir[sim.userControlsSide] < 0);
    const s = flip ? -1 : 1;
    let wx = s * sxin;
    let wz = s * (-syin);
    const mag = Math.hypot(wx, wz);
    if (mag > 0.15) {
      const v = new Vec2(wx, wz);
      v.normalize().scale(Math.min(1, mag));
      cmd.dir = v;
      cmd.effort = this.isDown('sprint') || this.isDown('modifier') ? 1 : 0.66;
    }

    const attacking = sim.possession === a.side;
    if (a.hasBall) this._attackOnBall(a, cmd, sxin, syin, flip);
    else if (attacking) this._attackOffBall(a, cmd);
    else this._defend(a, cmd);

    if (a.isGoalkeeper) this._goalkeeper(a, cmd, sxin, syin);

    this._clear();
    return cmd;
  }

  _attackOnBall(a, cmd, sxin, syin, flip) {
    const sim = this.sim;

    // Shoot: press to start charging, release to fire.
    if (this.hit('action1') && a.actionLock <= 0) { a.charging = 'shot'; a.chargeTime = 0; }
    if (a.charging === 'shot') {
      // Aim with the stick while charging.
      const s = flip ? -1 : 1;
      sim.lastAim = sim.lastAim ?? { x: 0, y: 0.5 };
      if (Math.abs(sxin) > 0.1) sim.lastAim.x = clamp(sim.lastAim.x + s * sxin * 0.06, -1, 1);
      if (Math.abs(syin) > 0.1) sim.lastAim.y = clamp(sim.lastAim.y - syin * 0.05, 0, 1);
      cmd.rise = 0.9; cmd.effort = Math.min(cmd.effort, 0.2);
      const goalZ = a.attackDir * (sim.profile.field.length / 2);
      cmd.face = Math.atan2(sim.lastAim.x * (sim.profile.field.goalWidth / 2) - a.pos.x, goalZ - a.pos.z);
    }
    if (a.charging === 'shot' && (this.up('action1') || a.chargeTime > 1.5)) {
      const charge = clamp01(a.chargeTime / 0.85);
      const type = this.isDown('action3') ? SHOT_TYPES.SKIP
        : this.isDown('modifier') ? SHOT_TYPES.QUICK : null;
      const aim = sim.lastAim ?? { x: 0.5, y: 0.35 };
      sim.tryShot(a, aim, type, clamp01(0.4 + charge * 0.7));
      a.charging = null;
    }

    // Pass: to the teammate most in the pushed direction (through-ball feel).
    if (this.hit('action2') && a.charging !== 'shot') {
      const target = this._pickReceiver(a, cmd.dir);
      if (target) {
        const type = this.isDown('action3') ? PASS_TYPES.LEAD
          : this.isDown('modifier') ? PASS_TYPES.DRIVEN : PASS_TYPES.DRY;
        sim.tryPass(a, target, type, this.isDown('modifier') ? 0.9 : 0.62);
      }
    }

    // Pump fake.
    if (this.hit('action3') && a.charging !== 'shot' && !this.hit('action1')) sim.tryPumpFake(a);

    // Protect the ball / hold position under pressure.
    if (this.isDown('modifier') && !cmd.dir) { cmd.rise = 0.5; cmd.brace = true; }
  }

  _attackOffBall(a, cmd) {
    const sim = this.sim;
    if (this.hit('action2')) a.callingForBall = 1.2;          // call for the ball
    if (this.hit('action3')) a.settingScreen = 1.4;
    if (this.hit('action1') && !sim.lockUserAthlete) sim.switchAthlete(sim.userControlsSide, 1);
  }

  _defend(a, cmd) {
    const sim = this.sim;
    const carrier = sim.ball.holder;
    // Face the ball carrier.
    if (carrier && carrier.side !== a.side) {
      cmd.face = Math.atan2(carrier.pos.x - a.pos.x, carrier.pos.z - a.pos.z);
    }
    // Tackle / steal.
    if (this.hit('action1')) sim.trySteal(a);
    // Block (raise arm).
    if (this.isDown('action3')) { sim.tryBlock(a); cmd.rise = Math.max(cmd.rise, 0.9); }
    // Contain.
    if (this.isDown('modifier')) cmd.brace = true;
    // Switch to the best defender (team control only).
    if (this.hit('action2') && !sim.lockUserAthlete) sim.switchAthlete(sim.userControlsSide, 1);
  }

  _goalkeeper(a, cmd, sxin, syin) {
    const sim = this.sim;
    cmd.saveAim = { x: clamp(sxin, -1, 1) * 0.6 + 0.5, y: clamp(-syin, -1, 1) * 0.5 + 0.5 };
    if (this.isDown('action1')) cmd.rise = 1;
    if (a.hasBall && this.hit('action2')) {
      const target = this._pickReceiver(a, cmd.dir, true);
      if (target) sim.tryPass(a, target, PASS_TYPES.OUTLET, 0.7);
    }
  }

  /** Choose a teammate to pass to, favouring the pushed direction. */
  _pickReceiver(passer, dir, longOnly = false) {
    const sim = this.sim;
    const mates = sim.activeAthletes(passer.side).filter((m) => m !== passer);
    if (!mates.length) return null;
    let best = null, bestScore = -1e9;
    for (const m of mates) {
      const dx = m.pos.x - passer.pos.x;
      const dz = m.pos.z - passer.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      if (longOnly && d < 6) continue;
      let score = 0;
      if (dir && dir.length() > 0.2) {
        score += ((dx / d) * dir.x + (dz / d) * dir.z) * 2.4;  // in the pushed direction
      }
      // Prefer forward and open teammates.
      const goalZ = passer.attackDir * (sim.profile.field.length / 2);
      score += clamp01((Math.abs(goalZ - passer.pos.z) - Math.abs(goalZ - m.pos.z)) / 6) * 0.8;
      score -= d * 0.04;
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  _clear() {
    this.pressed.clear();
    this.released.clear();
    this._touchHit = {};
    this._touchUp = {};
  }
}
