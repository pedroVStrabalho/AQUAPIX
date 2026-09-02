/**
 * Input layer (Design Bible section 18).
 *
 * Implements the conceptual controller framework from the brief for both gamepad
 * and keyboard, including contextual actions, input buffering (18.2) and full
 * remapping (18.3). The same button produces a different action only when the
 * context is unambiguous, and a requested pass is never reinterpreted as a shot.
 */

import { Vec2, clamp, clamp01, lerp } from '../core/Math2.js';
import { PASS_TYPES, SHOT_TYPES } from '../gameplay/Actions.js';

/** Logical actions. Physical keys and buttons map onto these. */
export const ACTION = {
  UP: 'up', DOWN: 'down', LEFT: 'left', RIGHT: 'right',
  SPRINT: 'sprint',         // RT  - high-effort swim
  ELEVATE: 'elevate',       // LT  - eggbeater / protect ball / hold position
  PASS: 'pass',             // A   - standard pass / controlled pressure
  SHOOT: 'shoot',           // B   - shoot / timed steal
  DRIVEN: 'driven',         // X   - driven or wet pass / raise arm, block
  LOB: 'lob',               // Y   - lead, lob or entry pass / tactical switch
  MODIFIER: 'modifier',     // RB  - pump fake, quick release, manual arm
  SWITCH: 'switch',         // LB  - player switch / set-play command
  AIM_UP: 'aimUp', AIM_DOWN: 'aimDown', AIM_LEFT: 'aimLeft', AIM_RIGHT: 'aimRight',
  GK_TOGGLE: 'gkToggle',
  CAMERA: 'camera',
  TACTICS: 'tactics',
  TIMEOUT: 'timeout',
  PAUSE: 'pause',
  SUB: 'substitute',
  PULL_GK: 'pullGoalkeeper',
  DEBUG: 'debug',
};

export const DEFAULT_KEYMAP = {
  KeyW: ACTION.UP, KeyS: ACTION.DOWN, KeyA: ACTION.LEFT, KeyD: ACTION.RIGHT,
  ArrowUp: ACTION.AIM_UP, ArrowDown: ACTION.AIM_DOWN, ArrowLeft: ACTION.AIM_LEFT, ArrowRight: ACTION.AIM_RIGHT,
  ShiftLeft: ACTION.SPRINT, ShiftRight: ACTION.SPRINT,
  Space: ACTION.ELEVATE,
  KeyJ: ACTION.PASS,
  KeyK: ACTION.SHOOT,
  KeyH: ACTION.DRIVEN,
  KeyU: ACTION.LOB,
  KeyL: ACTION.MODIFIER,
  KeyQ: ACTION.SWITCH,
  KeyG: ACTION.GK_TOGGLE,
  KeyC: ACTION.CAMERA,
  Tab: ACTION.TACTICS,
  KeyT: ACTION.TIMEOUT,
  KeyR: ACTION.SUB,
  KeyY: ACTION.PULL_GK,
  Escape: ACTION.PAUSE,
  F2: ACTION.DEBUG,
};

/** Second local player (section: local one-versus-one in the MVP list). */
export const PLAYER2_KEYMAP = {
  KeyI: ACTION.UP, KeyK: ACTION.DOWN, KeyJ: ACTION.LEFT, KeyL: ACTION.RIGHT,
  Slash: ACTION.SPRINT, Period: ACTION.ELEVATE,
  Numpad1: ACTION.PASS, Numpad2: ACTION.SHOOT, Numpad3: ACTION.DRIVEN,
};

const GAMEPAD_BUTTONS = {
  0: ACTION.PASS,      // A / Cross
  1: ACTION.SHOOT,     // B / Circle
  2: ACTION.DRIVEN,    // X / Square
  3: ACTION.LOB,       // Y / Triangle
  4: ACTION.SWITCH,    // LB / L1
  5: ACTION.MODIFIER,  // RB / R1
  8: ACTION.TACTICS,
  9: ACTION.PAUSE,
  12: ACTION.SUB,
  13: ACTION.PULL_GK,
  14: ACTION.TIMEOUT,
  15: ACTION.CAMERA,
};

export class InputManager {
  constructor(sim, opts = {}) {
    this.sim = sim;
    this.keymap = { ...DEFAULT_KEYMAP, ...(opts.keymap ?? {}) };
    this.holdToggle = { elevate: false, sprint: false };
    this.down = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.buffer = [];          // { action, at } - section 18.2 input buffering
    this.bufferWindow = 0.28;
    this.aim = { x: 0, y: 0.5 };
    this.aimManual = false;
    this.gamepadIndex = null;
    this.enabled = true;
    this.onUi = opts.onUi ?? (() => {});
    this._prevButtons = [];
    this._time = 0;

    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      const a = this.keymap[e.code];
      if (!a) return;
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (!this.down.has(a)) {
        this.pressed.add(a);
        this.buffer.push({ action: a, at: this._time });
      }
      this.down.add(a);
    };
    this._onKeyUp = (e) => {
      const a = this.keymap[e.code];
      if (!a) return;
      this.down.delete(a);
      this.released.add(a);
    };
    this._onMouse = (e) => {
      if (!this.enabled || document.pointerLockElement !== opts.canvas) return;
      this.aim.x = clamp(this.aim.x + e.movementX * 0.004, -1, 1);
      this.aim.y = clamp(this.aim.y - e.movementY * 0.004, 0, 1);
      this.aimManual = true;
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouse);
    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = e.gamepad.index;
      this.onUi({ type: 'gamepad', connected: true, id: e.gamepad.id });
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.gamepadIndex = null;
      this.onUi({ type: 'gamepad', connected: false });
    });
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouse);
  }

  remap(code, action) { this.keymap[code] = action; }

  _pollGamepad() {
    if (this.gamepadIndex == null) return null;
    const pads = navigator.getGamepads?.() ?? [];
    const gp = pads[this.gamepadIndex];
    if (!gp) return null;

    const dead = (v) => (Math.abs(v) < 0.16 ? 0 : v);
    const state = {
      lx: dead(gp.axes[0] ?? 0), ly: dead(gp.axes[1] ?? 0),
      rx: dead(gp.axes[2] ?? 0), ry: dead(gp.axes[3] ?? 0),
      lt: gp.buttons[6]?.value ?? 0,
      rt: gp.buttons[7]?.value ?? 0,
    };

    for (const [idx, action] of Object.entries(GAMEPAD_BUTTONS)) {
      const b = gp.buttons[+idx];
      const now = !!b?.pressed;
      const was = !!this._prevButtons[+idx];
      if (now && !was) { this.pressed.add(action); this.buffer.push({ action, at: this._time }); }
      if (!now && was) this.released.add(action);
      if (now) this.down.add(action); else this.down.delete(action);
      this._prevButtons[+idx] = now;
    }
    if (state.rt > 0.35) this.down.add(ACTION.SPRINT); else this.down.delete(ACTION.SPRINT);
    if (state.lt > 0.25) this.down.add(ACTION.ELEVATE); else this.down.delete(ACTION.ELEVATE);

    if (Math.abs(state.rx) > 0 || Math.abs(state.ry) > 0) {
      this.aim.x = clamp(this.aim.x + state.rx * 0.045, -1, 1);
      this.aim.y = clamp(this.aim.y - state.ry * 0.045, 0, 1);
      this.aimManual = true;
    }
    return state;
  }

  /** Consume a buffered action if it happened inside the buffering window. */
  consume(action) {
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i].action === action && this._time - this.buffer[i].at <= this.bufferWindow) {
        this.buffer.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  isDown(a) { return this.down.has(a); }
  wasPressed(a) { return this.pressed.has(a); }
  wasReleased(a) { return this.released.has(a); }

  /**
   * Build the athlete command and dispatch actions. Returns the command object
   * that MatchSim will apply to the controlled athlete.
   */
  update(dt, camera) {
    this._time += dt;
    const sim = this.sim;
    const pad = this._pollGamepad();

    // Drop buffered inputs that have aged out.
    this.buffer = this.buffer.filter((b) => this._time - b.at <= this.bufferWindow);

    const cmd = { dir: null, effort: 0, rise: 0, face: null, brace: false, saveAim: null };
    const a = sim.userAthlete;

    // ---- UI-level actions --------------------------------------------------
    if (this.wasPressed(ACTION.CAMERA)) this.onUi({ type: 'camera' });
    if (this.wasPressed(ACTION.TACTICS)) this.onUi({ type: 'tactics' });
    if (this.wasPressed(ACTION.PAUSE)) this.onUi({ type: 'pause' });
    if (this.wasPressed(ACTION.DEBUG)) this.onUi({ type: 'debug' });
    if (this.wasPressed(ACTION.TIMEOUT)) this.onUi({ type: 'timeout' });
    if (this.wasPressed(ACTION.SUB)) this.onUi({ type: 'substitute' });
    if (this.wasPressed(ACTION.PULL_GK)) this.onUi({ type: 'pullGoalkeeper' });
    if (this.wasPressed(ACTION.GK_TOGGLE)) sim.toggleGoalkeeperControl();
    if (this.wasPressed(ACTION.SWITCH) && !sim.ball.holder) sim.switchAthlete(sim.userControlsSide, 1);

    if (!a || !a.inPool || !this.enabled) { this._endFrame(); return cmd; }

    // ---- Movement (left stick) --------------------------------------------
    let mx = 0, mz = 0;
    if (this.isDown(ACTION.LEFT)) mx -= 1;
    if (this.isDown(ACTION.RIGHT)) mx += 1;
    if (this.isDown(ACTION.UP)) mz += 1;
    if (this.isDown(ACTION.DOWN)) mz -= 1;
    if (pad) { mx += pad.lx; mz -= pad.ly; }

    if (mx || mz) {
      // Movement is camera-relative so "up" always means "away from you".
      const v = new Vec2(mx, mz);
      const len = Math.min(1, v.length());
      v.normalize();
      const yaw = cameraYaw(camera);
      const cos = Math.cos(yaw), sin = Math.sin(yaw);
      cmd.dir = new Vec2(v.x * cos + v.z * sin, -v.x * sin + v.z * cos).normalize().scale(len);
      cmd.effort = this.isDown(ACTION.SPRINT) ? 1 : 0.62;
      if (pad) cmd.effort = Math.max(cmd.effort, 0.45 + pad.rt * 0.55);
    }

    // ---- Elevation (left trigger) -----------------------------------------
    const elevating = this.isDown(ACTION.ELEVATE);
    cmd.rise = elevating ? 1 : (a.hasBall ? 0.32 : 0.12);
    cmd.brace = elevating && !a.hasBall;
    if (pad && pad.lt > 0.05) cmd.rise = Math.max(cmd.rise, pad.lt);

    // ---- Aim ---------------------------------------------------------------
    const aimSpeed = 1.6 * dt;
    if (this.isDown(ACTION.AIM_LEFT)) { this.aim.x = clamp(this.aim.x - aimSpeed, -1, 1); this.aimManual = true; }
    if (this.isDown(ACTION.AIM_RIGHT)) { this.aim.x = clamp(this.aim.x + aimSpeed, -1, 1); this.aimManual = true; }
    if (this.isDown(ACTION.AIM_UP)) { this.aim.y = clamp(this.aim.y + aimSpeed, 0, 1); this.aimManual = true; }
    if (this.isDown(ACTION.AIM_DOWN)) { this.aim.y = clamp(this.aim.y - aimSpeed, 0, 1); this.aimManual = true; }
    sim.lastAim = { ...this.aim };

    const hasBall = a.hasBall;
    const attacking = sim.possession === a.side;

    if (hasBall) {
      this._inPossession(a, cmd, dt, camera);
    } else if (attacking) {
      this._offBall(a, cmd, camera);
    } else {
      this._defending(a, cmd, camera);
    }

    if (a.isGoalkeeper) this._goalkeeper(a, cmd, pad);

    this._endFrame();
    return cmd;
  }

  // -------------------------------------------------------------------------
  _inPossession(a, cmd, dt, camera) {
    const sim = this.sim;

    // Shoot: hold to charge, release to fire. Charging is visible on the rig.
    if (this.wasPressed(ACTION.SHOOT) || this.consume(ACTION.SHOOT)) {
      if (a.actionLock <= 0) { a.charging = 'shot'; a.chargeTime = 0; }
    }
    if (a.charging === 'shot' && (this.wasReleased(ACTION.SHOOT) || a.chargeTime > 1.6)) {
      const charge = clamp01(a.chargeTime / 0.85);
      const type = this.isDown(ACTION.MODIFIER) ? SHOT_TYPES.QUICK
        : this.isDown(ACTION.LOB) ? SHOT_TYPES.LOB
          : this.isDown(ACTION.DRIVEN) ? SHOT_TYPES.SKIP
            : null;
      sim.tryShot(a, this._resolveAim(a), type, clamp01(0.35 + charge * 0.75));
      a.charging = null;
    }

    // Pump fake / quick-release modifier.
    if (this.wasPressed(ACTION.MODIFIER) && a.charging !== 'shot') sim.tryPumpFake(a);

    // Passing. Three distinct pass families on three buttons, exactly as the
    // controller table specifies - never overloaded onto the shoot button.
    const passNow = this.wasPressed(ACTION.PASS) || this.consume(ACTION.PASS);
    const drivenNow = this.wasPressed(ACTION.DRIVEN) || this.consume(ACTION.DRIVEN);
    const lobNow = this.wasPressed(ACTION.LOB) || this.consume(ACTION.LOB);

    if (passNow || drivenNow || lobNow) {
      const type = drivenNow ? PASS_TYPES.DRIVEN : lobNow ? PASS_TYPES.LEAD : PASS_TYPES.DRY;
      const target = this._pickReceiver(a, camera, type);
      if (target) sim.tryPass(a, target, type, drivenNow ? 0.9 : 0.62);
    }
  }

  _offBall(a, cmd, camera) {
    const sim = this.sim;
    // A: call for the pass. X: set a screen. Y: request a lead pass / drive.
    if (this.wasPressed(ACTION.PASS)) a.callingForBall = 1.2;
    if (this.wasPressed(ACTION.DRIVEN)) a.settingScreen = 1.5;
    if (this.wasPressed(ACTION.LOB)) a.requestingLead = 1.5;
    if (this.wasPressed(ACTION.SWITCH)) sim.switchAthlete(sim.userControlsSide, 1);
  }

  _defending(a, cmd, camera) {
    const sim = this.sim;
    // B: timed steal. X: raise arm / block. A: controlled pressure. Y: switch call.
    if (this.wasPressed(ACTION.SHOOT) || this.consume(ACTION.SHOOT)) sim.trySteal(a);
    if (this.isDown(ACTION.DRIVEN)) { sim.tryBlock(a); cmd.rise = Math.max(cmd.rise, 0.9); }
    if (this.isDown(ACTION.PASS)) { cmd.brace = true; cmd.effort = Math.min(cmd.effort, 0.5); }
    if (this.wasPressed(ACTION.SWITCH)) sim.switchAthlete(sim.userControlsSide, 1);
    if (this.wasPressed(ACTION.LOB)) this.onUi({ type: 'defensiveCommand' });

    // Face the ball carrier so the defensive stance reads correctly.
    const carrier = sim.ball.holder;
    if (carrier && carrier.side !== a.side) {
      cmd.face = Math.atan2(carrier.pos.x - a.pos.x, carrier.pos.z - a.pos.z);
    }
  }

  _goalkeeper(a, cmd, pad) {
    // Manual save direction from the right stick / aim, per section 16.2.
    cmd.saveAim = { x: this.aim.x, y: this.aim.y };
    if (this.isDown(ACTION.DRIVEN)) cmd.rise = 1;
    if (this.isDown(ACTION.MODIFIER)) cmd.brace = true;
    if (a.hasBall) {
      if (this.wasPressed(ACTION.LOB)) {
        const target = this._pickReceiver(a, null, PASS_TYPES.GK_OUTLET, true);
        if (target) this.sim.tryPass(a, target, PASS_TYPES.GK_OUTLET, 0.95);
      } else if (this.wasPressed(ACTION.PASS)) {
        const target = this._pickReceiver(a, null, PASS_TYPES.OUTLET);
        if (target) this.sim.tryPass(a, target, PASS_TYPES.OUTLET, 0.6);
      }
    }
  }

  /** Where the shot is aimed: manual stick, or assisted toward open goal. */
  _resolveAim(a) {
    if (this.aimManual) return { ...this.aim };
    const sim = this.sim;
    const gk = sim.goalkeeperFor(sim.opponentSide(a.side));
    if (!gk) return { x: 0, y: 0.5 };
    // Assisted aim goes away from the keeper, never straight at a corner it
    // could not physically reach.
    const side = gk.pos.x > a.pos.x * 0.3 ? -1 : 1;
    return { x: side * 0.72, y: 0.28 };
  }

  /**
   * Receiver selection (section 13.3). Assisted profiles weigh input direction,
   * lane openness, tactical value and interception risk. Full simulation places
   * the ball in open water in the direction pushed.
   */
  _pickReceiver(passer, camera, type, longOnly = false) {
    const sim = this.sim;
    const mates = sim.activeAthletes(passer.side).filter((m) => m !== passer);
    if (!mates.length) return null;

    const assist = sim.assist.pass;
    let dirX = 0, dirZ = 0;
    if (this.isDown(ACTION.LEFT)) dirX -= 1;
    if (this.isDown(ACTION.RIGHT)) dirX += 1;
    if (this.isDown(ACTION.UP)) dirZ += 1;
    if (this.isDown(ACTION.DOWN)) dirZ -= 1;

    if (camera && (dirX || dirZ)) {
      const yaw = cameraYaw(camera);
      const cos = Math.cos(yaw), sin = Math.sin(yaw);
      const nx = dirX * cos + dirZ * sin;
      const nz = -dirX * sin + dirZ * cos;
      dirX = nx; dirZ = nz;
    }

    if (assist <= 0.01) {
      // Full manual: throw into open water in the pushed direction.
      const len = Math.hypot(dirX, dirZ) || 1;
      return {
        pos: {
          x: clamp(passer.pos.x + (dirX / len) * 7, -sim.profile.field.width / 2, sim.profile.field.width / 2),
          z: clamp(passer.pos.z + (dirZ / len) * 7, -sim.profile.field.length / 2, sim.profile.field.length / 2),
        },
      };
    }

    let best = null, bestScore = -1e9;
    for (const m of mates) {
      if (longOnly && Math.hypot(m.pos.x - passer.pos.x, m.pos.z - passer.pos.z) < 6) continue;
      const dx = m.pos.x - passer.pos.x;
      const dz = m.pos.z - passer.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      const dirScore = (dirX || dirZ) ? (dx / d) * dirX + (dz / d) * dirZ : 0.3;
      const goalZ = passer.attackDir * (sim.profile.field.length / 2);
      const advance = clamp01((Math.abs(goalZ - passer.pos.z) - Math.abs(goalZ - m.pos.z)) / 8);
      const centre = m.roleSlot?.role === 'CF' && type === PASS_TYPES.DRY ? 0.25 : 0;
      const score = dirScore * 2.4 + advance * 0.8 + centre - d * 0.045;
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  _endFrame() {
    this.pressed.clear();
    this.released.clear();
  }
}

/**
 * Camera yaw straight from the world matrix - a camera looks down its local -Z,
 * so the world forward vector is the negated third basis column.
 */
function cameraYaw(camera) {
  if (!camera?.matrixWorld) return 0;
  const e = camera.matrixWorld.elements;
  return Math.atan2(-e[8], -e[10]);
}
