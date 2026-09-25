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

import { MATCH_STATE } from '../rules/RulesEngine.js';
import { Vec2, clamp, clamp01 } from '../core/Math2.js';
import { PASS_TYPES, SHOT_TYPES, laneOpenness } from '../gameplay/Actions.js';

const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',

  // Z / X / C sit together under the left hand while WASD steers.
  KeyZ: 'action2',    // PASS   (attack) / raise arm (defence)
  KeyX: 'action1',    // SHOOT  (attack) / steal  (defence)
  // SPACE does two jobs that can never overlap: you cannot shoot without the
  // ball, and you cannot foul while you have it. Attacking it shoots; defending
  // it deliberately fouls the man you are marking.
  Space: ['action1', 'foul'],
  KeyC: 'lob',        // LOB PASS - its own action, not a modifier

  KeyJ: 'action2',    // legacy pass binding, kept working
  KeyK: 'action1',    // legacy shoot binding, kept working
  KeyL: 'action3',    // block / pump fake / skip-shot modifier
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
    this._shootLatch = false;
    this.touchButtons = {};
    this._time = 0;

    // A key may carry more than one action (SPACE shoots and fouls, in contexts
    // that cannot overlap), so every binding is normalised to a list.
    const actionsFor = (code) => {
      const a = KEYMAP[code];
      return a == null ? null : (Array.isArray(a) ? a : [a]);
    };
    this._kd = (e) => {
      // Match commands. Caught here, at the raw key, rather than in update():
      // input is switched off while paused, so a pause key handled there could
      // pause the game but never resume it. These were listed on the Controls
      // screen and in the match hint, but nothing ever called them - there was
      // no way to pause a match at all.
      if (!e.repeat && (e.code === 'Escape' || e.code === 'KeyP')) {
        e.preventDefault?.();
        this.onUi({ type: 'pause' });
        return;
      }
      if (!e.repeat && e.code === 'KeyT' && this.enabled) {
        this.onUi({ type: 'timeout' });
        return;
      }
      const list = actionsFor(e.code);
      if (!list) return;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      for (const a of list) {
        if (!this.down.has(a)) this.pressed.add(a);
        this.down.add(a);
      }
    };
    this._ku = (e) => {
      const list = actionsFor(e.code);
      if (!list) return;
      for (const a of list) {
        this.down.delete(a);
        this.released.add(a);
      }
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

    // Penalty shootout: UP / DOWN picks a side of the goal - the goal mouth runs
    // up and down the screen in the landscape pool - and SHOOT takes the kick.
    // On their kicks the same keys pick the keeper's dive.
    if (sim.state === MATCH_STATE.SHOOTOUT) {
      let syin = 0;
      if (this.isDown('up')) syin -= 1;
      if (this.isDown('down')) syin += 1;
      if (this.stick.active && Math.abs(this.stick.y) > 0.4) syin = Math.sign(this.stick.y);
      const flip = this.renderer?.flip ?? (sim.attackDir[sim.userControlsSide] < 0);
      const s = flip ? -1 : 1;
      sim.shootoutControl({
        side: syin === 0 ? 0 : Math.sign(s * syin),   // world x, as worldToScreen maps it
        screen: syin,
        shoot: this.hit('action1') || this.hit('action2'),
      });
      this._clear();
      return cmd;
    }

    const a = sim.userAthlete;
    // One press = one shot: the latch clears the moment SHOOT is released, no
    // matter who has the ball, so you can always shoot your next possession.
    if (!this.isDown('action1')) this._shootLatch = false;
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
    // Inverse of PixelRenderer.worldToScreen, which draws the pool LANDSCAPE:
    // screen X runs along the pool's length (world z) and screen Y across its
    // width (world x). These must be kept in step with the renderer or the
    // controls come out rotated.
    let wz = s * sxin;
    let wx = s * syin;
    const mag = Math.hypot(wx, wz);
    if (mag > 0.15) {
      const v = new Vec2(wx, wz);
      v.normalize().scale(Math.min(1, mag));
      cmd.dir = v;
      // Arcade: pushing a direction always swims at full effort. Sprint adds a
      // real burst on top (handled in Athlete via cmd.sprint).
      cmd.effort = 1;
      cmd.sprint = this.isDown('sprint') || this.isDown('modifier');
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

    // SHOOT - simple and reliable (arcade). Holding SHOOT fires exactly one shot
    // the instant the athlete is free to shoot; you keep holding to "aim" (the
    // longer you hold before it can fire, the more you can steer the aim). It
    // latches so one press = one shot, and it can never be swallowed by a brief
    // action lock the frame you press, which is what made shooting feel broken.
    const holdingShoot = this.isDown('action1');
    if (holdingShoot) {
      a.charging = 'shot';                                 // drives the aim line + rise pose
      const s = flip ? -1 : 1;
      sim.lastAim = sim.lastAim ?? { x: 0, y: 0.4 };
      if (Math.abs(sxin) > 0.1) sim.lastAim.x = clamp(sim.lastAim.x + s * sxin * 0.05, -1, 1);
      if (Math.abs(syin) > 0.1) sim.lastAim.y = clamp(sim.lastAim.y - syin * 0.04, 0, 1);
      cmd.rise = 0.9; cmd.effort = Math.min(cmd.effort, 0.25);
      const goalZ = a.attackDir * (sim.profile.field.length / 2);
      cmd.face = Math.atan2((sim.lastAim.x * (sim.profile.field.goalWidth / 2)) - a.pos.x, goalZ - a.pos.z);
      a.chargeTime = (a.chargeTime || 0) + 0;              // (kept in sim._driveAthletes)

      if (!this._shootLatch && a.actionLock <= 0) {
        // Auto-aim toward the corner away from the keeper unless you steered it.
        const gk = sim.goalkeeperFor(sim.opponentSide(a.side));
        if (gk && Math.abs(sxin) < 0.1 && Math.abs(sim.lastAim.x) < 0.15) {
          sim.lastAim.x = clamp(-Math.sign((gk.pos.x - a.pos.x * 0.3) || 1) * 0.7, -0.85, 0.85);
        }
        const type = this.isDown('action3') ? SHOT_TYPES.SKIP
          : this.isDown('modifier') ? SHOT_TYPES.QUICK : null;
        // Power scales a little with how far out you are, but is always a real shot.
        const dist = Math.hypot(a.pos.x, goalZ - a.pos.z);
        const power = clamp01(0.7 + dist / 30);
        sim.tryShot(a, { ...sim.lastAim }, type, power);
        this._shootLatch = true;
        a.charging = null;
      }
    } else if (a.charging === 'shot') {
      a.charging = null;
    }

    // Pass (Z) and lob pass (C): both go to the teammate most in the pushed
    // direction. The lob is its own key rather than a held modifier - it is a
    // distinct pass you choose, not a variant you have to discover.
    const wantsPass = this.hit('action2');
    const wantsLob = this.hit('lob');
    if ((wantsPass || wantsLob) && a.charging !== 'shot') {
      const target = this._pickReceiver(a, cmd.dir);
      if (target) {
        const type = wantsLob ? PASS_TYPES.LOB
          : this.isDown('modifier') ? PASS_TYPES.DRIVEN : PASS_TYPES.DRY;
        const power = wantsLob ? 0.7 : (this.isDown('modifier') ? 0.9 : 0.62);
        sim.tryPass(a, target, type, power);
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
    // SPACE - deliberately foul the man you are marking. In front of him that is
    // an ordinary foul that just stops the attack; from behind him it is an
    // exclusion and you sit out. Checked before the steal so SPACE fouls rather
    // than tackling, while X still tackles.
    if (this.hit('foul')) {
      sim.tryDeliberateFoul(a);
      cmd.rise = Math.max(cmd.rise, 0.6);
    } else if (this.hit('action1')) sim.trySteal(a);
    // Block (raise arm) on Z - the same key that passes when you have the ball.
    // L still works. Switching defenders lives on E, so Z is free here.
    if (this.isDown('action2') || this.isDown('action3')) {
      sim.tryBlock(a);
      cmd.rise = Math.max(cmd.rise, 0.9);
    }
    // Contain.
    if (this.isDown('modifier')) cmd.brace = true;
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
    const aiming = dir && dir.length() > 0.2;
    // When you push a direction you are naming a team-mate, not offering a hint.
    // The direction term used to be worth 2.4 against a 0.8 "prefer forward"
    // bonus, so a team-mate square to your left could lose to one you were not
    // pointing at. Anyone outside a 90 degree cone around the push is simply not
    // a candidate - unless nobody is in the cone at all, in which case we fall
    // back to the old open scoring rather than refusing to pass.
    for (const pass of aiming ? ['cone', 'any'] : ['any']) {
      let best = null, bestScore = -1e9;
      for (const m of mates) {
        const dx = m.pos.x - passer.pos.x;
        const dz = m.pos.z - passer.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        if (longOnly && d < 6) continue;
        let score = 0;
        if (aiming) {
          const align = (dx / d) * dir.x + (dz / d) * dir.z;
          if (pass === 'cone' && align < 0.35) continue;
          score += align * 6.0;
        }
        // Among the team-mates you are pointing at, the open one. The pick used
        // to ignore defenders entirely, so Z threw into a marked man as happily
        // as a free one: measured, one pass in six was picked off.
        const opp = sim.activeAthletes(sim.opponentSide(passer.side));
        score += laneOpenness(passer.pos, m.pos, opp).open * 2.2;
        // Prefer forward and open team-mates.
        const goalZ = passer.attackDir * (sim.profile.field.length / 2);
        score += clamp01((Math.abs(goalZ - passer.pos.z) - Math.abs(goalZ - m.pos.z)) / 6) * 0.8;
        score -= d * 0.04;
        if (score > bestScore) { bestScore = score; best = m; }
      }
      if (best) return best;
    }
    return null;
  }

  _clear() {
    this.pressed.clear();
    this.released.clear();
    this._touchHit = {};
    this._touchUp = {};
  }
}
