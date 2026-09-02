/**
 * AQUAPIX - top-down pixel-art match renderer.
 *
 * Draws the water polo match on a low-resolution backbuffer that is scaled up
 * with nearest-neighbour sampling, giving crisp chunky pixels (Retro Bowl / EAFC
 * top-down feel). The camera follows the ball vertically and the pool is always
 * oriented so the team you control attacks toward the TOP of the screen, so the
 * controls never invert.
 *
 * It reads only from the simulation - it never moves anything - so the tested
 * engine and this presentation stay cleanly separated.
 */

import { PAL, snap } from './palette.js';
import { clamp, clamp01, lerp } from '../core/Math2.js';
import { starString } from '../data/DisplayStats.js';

const PIXEL = 2;              // display pixels per art pixel (crisper but still pixel)
const MARGIN_M = 3.2;         // metres of deck shown around the pool sides

export class PixelRenderer {
  constructor(canvas, sim, settings = {}) {
    this.canvas = canvas;
    this.sim = sim;
    this.settings = { splash: 1, screenShake: true, showHints: true, ...settings };
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.time = 0;
    this.camZ = 0;
    this.shake = 0;
    this.flash = 0;
    this.flashColor = '#ffffff';
    this.splashes = [];       // {x,z,vx,vz,vy,y,life,max,r}
    this.rings = [];          // {x,z,life,max,r0,r1}
    this.floaters = [];       // {x,z,text,life,color,vy}
    this._trail = [];
    this._hook();
    this.resize();
  }

  _hook() {
    const b = this.sim.bus;
    b.on('goal', () => { this.shake = 1; this.flash = 1; this.flashColor = '#eaf7ff'; });
    b.on('save', ({ gk }) => { this.shake = 0.4; this._ping(gk, 'SAVE!', PAL.select); });
    b.on('block', ({ athlete }) => { this._ping(athlete, 'BLOCK', PAL.warn); });
    b.on('steal', ({ defender }) => { this._ping(defender, 'STEAL', PAL.go); });
    b.on('foul', ({ foul }) => { this.shake = 0.25; });
    b.on('pumpFake', () => {});
  }

  _ping(a, text, color) {
    if (!a) return;
    this.floaters.push({ x: a.pos.x, z: a.pos.z, text, life: 1.1, max: 1.1, color, vy: 1 });
  }

  setSetting(k, v) { this.settings[k] = v; }

  resize() {
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;
    this.cssW = cssW; this.cssH = cssH;
    this.aw = Math.max(160, Math.floor(cssW / PIXEL));
    this.ah = Math.max(160, Math.floor(cssH / PIXEL));
    this.canvas.width = this.aw;
    this.canvas.height = this.ah;
    this.ctx.imageSmoothingEnabled = false;

    const f = this.sim.profile.field;
    // Scale so the full pool width (plus a little deck) fits across the screen.
    this.scale = this.aw / (f.width + MARGIN_M * 2);
    // Vertical span of the pool in art pixels; if it fits, no scrolling.
    this.poolPxH = f.length * this.scale;
    this.fitsVertically = this.poolPxH + MARGIN_M * 2 * this.scale <= this.ah;
  }

  /** Which way does the controlled team attack? Used to keep "up = forward". */
  get flip() {
    const side = this.sim.userControlsSide ?? 'home';
    return this.sim.attackDir[side] < 0;
  }

  worldToScreen(x, z) {
    const flip = this.flip;
    const wx = flip ? -x : x;
    const wz = flip ? -z : z;
    const sx = this.aw / 2 + wx * this.scale;
    // Camera: attacking goal (top) is +wz. Screen y increases downward.
    const sy = this.camY - wz * this.scale;
    return { sx, sy };
  }

  update(dt) {
    this.time += dt;
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.flash = Math.max(0, this.flash - dt * 2.6);

    const sim = this.sim;
    const f = sim.profile.field;
    const flip = this.flip;

    // Camera follows the ball (in flipped world space), clamped to the pool.
    const ballWz = flip ? -sim.ball.pos.z : sim.ball.pos.z;
    const halfL = f.length / 2;
    const targetCamZ = clamp(ballWz, -halfL + 0.5, halfL - 0.5);
    this.camZ = lerp(this.camZ, targetCamZ, 1 - Math.exp(-6 * dt));
    if (this.fitsVertically) {
      this.camY = this.ah / 2 + this.camZ * this.scale * 0; // centre, no scroll
      this.camY = this.ah / 2;
    } else {
      // Keep the ball near the middle, but never scroll past the pool ends.
      const minCamY = this.ah - (halfL * this.scale) - MARGIN_M * this.scale;
      const maxCamY = (halfL * this.scale) + MARGIN_M * this.scale;
      this.camY = clamp(this.ah / 2 + this.camZ * this.scale, minCamY, maxCamY);
    }

    // Effects.
    this._updateSplashFromSim(dt);
    this._advanceParticles(dt);
  }

  _updateSplashFromSim(dt) {
    const sim = this.sim;
    const density = this.settings.splash;
    if (density <= 0) return;
    // Stroke splashes behind fast swimmers.
    for (const a of sim.allActive()) {
      const sp = a.speed;
      if (sp > 0.9 && Math.random() < sp * dt * 2.2 * density) {
        this.splashes.push({
          x: a.pos.x - Math.sin(a.heading) * 0.3,
          z: a.pos.z - Math.cos(a.heading) * 0.3,
          vx: (Math.random() - 0.5) * 0.6, vz: (Math.random() - 0.5) * 0.6,
          vy: 0.6 + Math.random() * 0.8, y: 0.1,
          life: 0.35 + Math.random() * 0.25, max: 0.6, r: 1 + Math.random() * 1.5,
        });
      }
      if (a.elevation > 0.2 && Math.random() < a.elevation * dt * 5 * density) {
        this.splashes.push({
          x: a.pos.x + (Math.random() - 0.5) * 0.5, z: a.pos.z + (Math.random() - 0.5) * 0.5,
          vx: (Math.random() - 0.5) * 1.4, vz: (Math.random() - 0.5) * 1.4,
          vy: 1 + Math.random(), y: 0.1, life: 0.4, max: 0.4, r: 1 + Math.random() * 2,
        });
      }
    }
    // Ball splash / skip.
    const ball = sim.ball;
    if (ball.eventFlags.splash > 0.1) {
      const n = Math.round(4 + ball.eventFlags.splash * 14 * density);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        this.splashes.push({
          x: ball.pos.x, z: ball.pos.z,
          vx: Math.cos(a) * (0.5 + Math.random() * 2), vz: Math.sin(a) * (0.5 + Math.random() * 2),
          vy: 1 + Math.random() * 2, y: 0.1, life: 0.5, max: 0.5, r: 1 + Math.random() * 2,
        });
      }
      this.rings.push({ x: ball.pos.x, z: ball.pos.z, life: 0.5, max: 0.5, r0: 0.2, r1: 1.4 });
      ball.eventFlags.splash = 0;
    }
    if (ball.eventFlags.skip > 0.1) {
      this.rings.push({ x: ball.pos.x, z: ball.pos.z, life: 0.45, max: 0.45, r0: 0.3, r1: 2.0 });
      ball.eventFlags.skip = 0;
    }
  }

  _advanceParticles(dt) {
    for (const s of this.splashes) {
      s.life -= dt; s.vy -= 6 * dt;
      s.x += s.vx * dt; s.z += s.vz * dt; s.y += s.vy * dt;
      if (s.y < 0) s.life = 0;
    }
    this.splashes = this.splashes.filter((s) => s.life > 0);
    if (this.splashes.length > 400) this.splashes.splice(0, this.splashes.length - 400);

    for (const r of this.rings) r.life -= dt;
    this.rings = this.rings.filter((r) => r.life > 0);

    for (const fl of this.floaters) { fl.life -= dt; fl.z += fl.vy * dt * 0.4; }
    this.floaters = this.floaters.filter((f) => f.life > 0);
  }

  // =======================================================================
  render() {
    const ctx = this.ctx;
    const sim = this.sim;

    ctx.save();
    if (this.shake > 0.01 && this.settings.screenShake) {
      ctx.translate((Math.random() - 0.5) * this.shake * 6, (Math.random() - 0.5) * this.shake * 6);
    }

    this._drawDeck();
    this._drawPool();
    this._drawMarkings();
    this._drawGoals();
    this._drawRings();
    this._drawShadows();
    this._drawAthletes();
    this._drawBall();
    this._drawSplashes();
    this._drawFloaters();
    this._drawAimIndicator();

    ctx.restore();

    if (this.flash > 0.02) {
      ctx.globalAlpha = this.flash * 0.5;
      ctx.fillStyle = this.flashColor;
      ctx.fillRect(0, 0, this.aw, this.ah);
      ctx.globalAlpha = 1;
    }
  }

  _drawDeck() {
    const ctx = this.ctx;
    ctx.fillStyle = PAL.deck;
    ctx.fillRect(0, 0, this.aw, this.ah);
    // Deck tiling texture.
    ctx.fillStyle = PAL.deckDark;
    for (let y = 0; y < this.ah; y += 8) {
      for (let x = ((y / 8) % 2) * 8; x < this.aw; x += 16) {
        ctx.fillRect(x, y, 8, 8);
      }
    }
  }

  _poolRect() {
    const f = this.sim.profile.field;
    const tl = this.worldToScreen(-f.width / 2, this.flip ? -f.length / 2 : f.length / 2);
    const br = this.worldToScreen(f.width / 2, this.flip ? f.length / 2 : -f.length / 2);
    const x = Math.min(tl.sx, br.sx), y = Math.min(tl.sy, br.sy);
    const w = Math.abs(br.sx - tl.sx), h = Math.abs(br.sy - tl.sy);
    return { x: snap(x), y: snap(y), w: snap(w), h: snap(h) };
  }

  _drawPool() {
    const ctx = this.ctx;
    const r = this._poolRect();

    // Gutter lip around the pool.
    ctx.fillStyle = PAL.gutter;
    ctx.fillRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6);

    // Base water gradient (banded, not smooth, for the retro feel).
    const bands = 5;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      ctx.fillStyle = lerpColor(PAL.poolLight, PAL.poolDeep, t * 0.8);
      ctx.fillRect(r.x, r.y + Math.floor((h => h)(r.h) * i / bands), r.w, Math.ceil(r.h / bands) + 1);
    }

    // Animated ripple dither: sparse moving specks, deterministic per cell.
    ctx.fillStyle = PAL.ripple;
    const step = 6;
    const t = this.time;
    for (let y = r.y; y < r.y + r.h; y += step) {
      for (let x = r.x; x < r.x + r.w; x += step) {
        const n = Math.sin((x * 0.21 + t * 1.3)) + Math.cos((y * 0.19 - t * 1.1));
        if (n > 1.3) ctx.fillRect(x, y, 2, 1);
      }
    }
    // Caustic shimmer lines.
    ctx.fillStyle = 'rgba(120,200,240,0.10)';
    for (let y = r.y; y < r.y + r.h; y += 10) {
      const off = Math.sin(y * 0.3 + t * 0.8) * 4;
      ctx.fillRect(r.x, y + off, r.w, 1);
    }

    this._pool = r;
  }

  _drawMarkings() {
    const ctx = this.ctx;
    const f = this.sim.profile.field;
    // Lines across the pool at each end: goal line, 2m, 5m, 6m, half.
    const lineAt = (metresFromCentre, color, dashed = false) => {
      const a = this.worldToScreen(-f.width / 2, metresFromCentre);
      const b = this.worldToScreen(f.width / 2, metresFromCentre);
      ctx.fillStyle = color;
      const y = snap(a.sy);
      const x0 = snap(Math.min(a.sx, b.sx)), x1 = snap(Math.max(a.sx, b.sx));
      if (dashed) { for (let x = x0; x < x1; x += 6) ctx.fillRect(x, y, 3, 1); }
      else ctx.fillRect(x0, y, x1 - x0, 1);
    };
    const halfL = f.length / 2;
    for (const sgn of [1, -1]) {
      lineAt(sgn * halfL, PAL.foam);                              // goal line
      lineAt(sgn * (halfL - f.restrictedLine), PAL.lineRed);      // 2m
      lineAt(sgn * (halfL - f.penaltyLine), PAL.lineYellow, true);// 5m
      lineAt(sgn * (halfL - f.frontCourtLine), PAL.lineGreen);    // 6m
    }
    lineAt(0, PAL.foam, true);                                    // half distance

    // Lane ropes down the two long sides (coloured bands like real ropes).
    this._drawLaneRope(-f.width / 2 - 0.15);
    this._drawLaneRope(f.width / 2 + 0.15);
  }

  _drawLaneRope(worldX) {
    const ctx = this.ctx;
    const f = this.sim.profile.field;
    const halfL = f.length / 2;
    const steps = Math.round(f.length * 2);
    for (let i = 0; i < steps; i++) {
      const z = -halfL + (i / steps) * f.length;
      const d = Math.min(halfL - Math.abs(z), 6);
      const color = (halfL - Math.abs(z)) < f.restrictedLine ? PAL.lineRed
        : (halfL - Math.abs(z)) < f.penaltyLine ? PAL.lineYellow : PAL.lineGreen;
      const p = this.worldToScreen(worldX, z);
      ctx.fillStyle = i % 2 === 0 ? color : PAL.foam;
      ctx.fillRect(snap(p.sx) - 1, snap(p.sy), 2, 2);
    }
  }

  _drawGoals() {
    const ctx = this.ctx;
    const f = this.sim.profile.field;
    const halfL = f.length / 2;
    for (const sgn of [1, -1]) {
      const left = this.worldToScreen(-f.goalWidth / 2, sgn * halfL);
      const right = this.worldToScreen(f.goalWidth / 2, sgn * halfL);
      const y = snap(left.sy);
      const x0 = snap(Math.min(left.sx, right.sx)), x1 = snap(Math.max(left.sx, right.sx));
      // Net (behind the line, i.e. further from centre).
      const netDir = y < this.ah / 2 ? -1 : 1;
      ctx.fillStyle = PAL.goalNet;
      ctx.fillRect(x0, y + (netDir < 0 ? -6 : 1), x1 - x0, 6);
      ctx.strokeStyle = 'rgba(220,235,245,0.25)';
      ctx.lineWidth = 1;
      for (let x = x0; x <= x1; x += 3) { ctx.beginPath(); ctx.moveTo(x + 0.5, y + (netDir < 0 ? -6 : 0)); ctx.lineTo(x + 0.5, y + (netDir < 0 ? 0 : 6)); ctx.stroke(); }
      // Posts and crossbar (bright).
      ctx.fillStyle = PAL.goalPost;
      ctx.fillRect(x0 - 1, y - 1, 3, 3);
      ctx.fillRect(x1 - 1, y - 1, 3, 3);
      ctx.fillRect(x0, y, x1 - x0, 2);
    }
  }

  _drawShadows() {
    const ctx = this.ctx;
    ctx.fillStyle = PAL.shadow;
    for (const a of this.sim.allActive()) {
      const p = this.worldToScreen(a.pos.x, a.pos.z);
      const rr = 4 + a.elevation * 2;
      ctx.beginPath();
      ctx.ellipse(snap(p.sx), snap(p.sy + 3), rr, rr * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawAthletes() {
    const sim = this.sim;
    // Draw far players first (higher on screen) so nearer ones overlap correctly.
    const list = sim.allActive().slice().sort((a, b) => {
      const az = this.flip ? -a.pos.z : a.pos.z;
      const bz = this.flip ? -b.pos.z : b.pos.z;
      return bz - az;
    });
    for (const a of list) this._drawAthlete(a);
  }

  _drawAthlete(a) {
    const ctx = this.ctx;
    const sim = this.sim;
    const p = this.worldToScreen(a.pos.x, a.pos.z);
    const x = snap(p.sx), y = snap(p.sy - a.elevation * 6);
    const team = sim.teamOf(a.side);
    const isUser = a === sim.userAthlete;
    const isSecond = a === sim.secondUserAthlete;

    // Selection ring under the controlled athlete.
    if (isUser || isSecond) {
      ctx.strokeStyle = isUser ? PAL.select : PAL.warn;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, snap(p.sy), 7, 0, Math.PI * 2);
      ctx.stroke();
      // A little forward chevron.
      const fdir = this.flip ? -1 : 1;
      const hx = Math.sin(a.heading) * (this.flip ? -1 : 1);
      const hz = Math.cos(a.heading) * fdir;
      ctx.fillStyle = isUser ? PAL.select : PAL.warn;
      ctx.fillRect(x + Math.round(hx * 8) - 1, snap(p.sy) - Math.round(hz * 8) - 1, 2, 2);
    }

    // Wake behind a moving swimmer.
    if (a.speed > 0.6) {
      const fdir = this.flip ? -1 : 1;
      const bx = x - Math.round(Math.sin(a.heading) * (this.flip ? -1 : 1) * 5);
      const by = y + Math.round(Math.cos(a.heading) * fdir * 5);
      ctx.fillStyle = 'rgba(220,240,255,0.25)';
      ctx.fillRect(bx - 1, by - 1, 3, 2);
    }

    // Body: a chunky rounded torso in the team's darker tone.
    const bodyCol = a.isGoalkeeper ? '#c62828' : shade(team.colors.primary, -0.15);
    ctx.fillStyle = bodyCol;
    ctx.fillRect(x - 3, y - 2, 6, 6);
    ctx.fillRect(x - 4, y - 1, 8, 4);

    // Arms hint when shooting/blocking (raised = a light stub above the head).
    if (a.charging === 'shot' || a.armRaised > 0.4 || a.elevation > 0.28) {
      ctx.fillStyle = a.player.leftHanded ? '#ffd' : '#ffd';
      const ax = a.player.leftHanded ? x - 4 : x + 3;
      ctx.fillStyle = PAL.skin[2];
      ctx.fillRect(ax, y - 6, 2, 4);
    }

    // Cap: bright, with the number, in the team cap colour (or red/white for GK).
    const capCol = a.isGoalkeeper ? '#ffffff' : team.colors.cap;
    ctx.fillStyle = capCol;
    ctx.fillRect(x - 3, y - 5, 6, 4);
    // Ear guards.
    ctx.fillStyle = PAL.foam;
    ctx.fillRect(x - 4, y - 4, 1, 2);
    ctx.fillRect(x + 3, y - 4, 1, 2);
    // Cap number (tiny).
    ctx.fillStyle = a.isGoalkeeper ? '#c62828' : (team.colors.capAlt ?? '#fff');
    this._tinyNumber(x, y - 4, a.player.capNumber);

    // Ball-carrier highlight.
    if (a.hasBall) {
      ctx.strokeStyle = PAL.ballMain;
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 5, y - 7, 10, 12);
    }

    // Fatigue tint: a tired athlete gets a faint dark overlay.
    if (a.freshness < 0.5) {
      ctx.fillStyle = `rgba(10,20,30,${(0.5 - a.freshness) * 0.5})`;
      ctx.fillRect(x - 4, y - 5, 8, 10);
    }
  }

  _tinyNumber(cx, cy, num) {
    // 3x3 pixel digits, good enough to distinguish caps.
    const ctx = this.ctx;
    const s = String(num);
    const w = s.length * 2;
    let px = cx - Math.floor(w / 2);
    for (const ch of s) {
      const bits = DIGITS[ch];
      if (bits) {
        for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) {
          if (bits[r] & (1 << (1 - c))) ctx.fillRect(px + c, cy + r, 1, 1);
        }
      }
      px += 3;
    }
  }

  _drawBall() {
    const ctx = this.ctx;
    const ball = this.sim.ball;
    if (ball.state === 'dead' && !this.sim.isLive()) { /* still draw for restarts */ }
    const p = this.worldToScreen(ball.pos.x, ball.pos.z);
    const lift = clamp(ball.pos.y, 0, 3) * 4;
    const x = snap(p.sx), y = snap(p.sy - lift);

    // Trail.
    this._trail.unshift({ x, y });
    if (this._trail.length > 8) this._trail.pop();
    if (ball.speed > 8) {
      for (let i = this._trail.length - 1; i > 0; i--) {
        const t = this._trail[i];
        ctx.globalAlpha = (1 - i / this._trail.length) * 0.4;
        ctx.fillStyle = PAL.ballHi;
        ctx.fillRect(t.x - 1, t.y - 1, 2, 2);
      }
      ctx.globalAlpha = 1;
    }

    // Airborne shadow already drawn per-athlete; add a small ball shadow.
    if (ball.pos.y > 0.2) {
      ctx.fillStyle = PAL.shadow;
      ctx.fillRect(snap(p.sx) - 2, snap(p.sy) + 1, 4, 2);
    }

    // The ball: yellow with a dark seam and a highlight.
    ctx.fillStyle = PAL.ballDark;
    ctx.fillRect(x - 2, y - 2, 5, 5);
    ctx.fillStyle = PAL.ballMain;
    ctx.fillRect(x - 2, y - 2, 4, 4);
    ctx.fillStyle = PAL.ballHi;
    ctx.fillRect(x - 1, y - 1, 1, 1);
  }

  _drawSplashes() {
    const ctx = this.ctx;
    for (const s of this.splashes) {
      const p = this.worldToScreen(s.x, s.z);
      const a = clamp01(s.life / s.max);
      ctx.globalAlpha = a;
      ctx.fillStyle = PAL.splash;
      const rr = Math.max(1, Math.round(s.r * a));
      ctx.fillRect(snap(p.sx) - Math.floor(rr / 2), snap(p.sy - s.y * 5) - Math.floor(rr / 2), rr, rr);
    }
    ctx.globalAlpha = 1;
  }

  _drawRings() {
    const ctx = this.ctx;
    for (const r of this.rings) {
      const t = 1 - r.life / r.max;
      const rad = lerp(r.r0, r.r1, t) * this.scale;
      const p = this.worldToScreen(r.x, r.z);
      ctx.globalAlpha = (1 - t) * 0.5;
      ctx.strokeStyle = PAL.foam;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(snap(p.sx), snap(p.sy), rad, rad * 0.6, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  _drawFloaters() {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.font = '6px monospace';
    for (const fl of this.floaters) {
      const p = this.worldToScreen(fl.x, fl.z);
      const a = clamp01(fl.life / fl.max);
      ctx.globalAlpha = a;
      ctx.fillStyle = '#000';
      ctx.fillText(fl.text, snap(p.sx) + 1, snap(p.sy - 10) + 1);
      ctx.fillStyle = fl.color;
      ctx.fillText(fl.text, snap(p.sx), snap(p.sy - 10));
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  /** Aim line + power arc while the human is charging a shot or lining a pass. */
  _drawAimIndicator() {
    const sim = this.sim;
    const a = sim.userAthlete;
    if (!a || !a.hasBall || !this.settings.showHints) return;
    const ctx = this.ctx;
    if (a.charging === 'shot' && sim.lastAim) {
      const f = sim.profile.field;
      const goalZ = a.attackDir * (f.length / 2);
      const tx = sim.lastAim.x * (f.goalWidth / 2 - 0.1);
      const from = this.worldToScreen(a.pos.x, a.pos.z);
      const to = this.worldToScreen(tx, goalZ);
      ctx.strokeStyle = PAL.select;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(snap(from.sx), snap(from.sy));
      ctx.lineTo(snap(to.sx), snap(to.sy));
      ctx.stroke();
      ctx.setLineDash([]);
      // Power ring.
      const power = clamp01(a.chargeTime / 0.85);
      ctx.strokeStyle = power > 0.85 ? PAL.go : PAL.warn;
      ctx.beginPath();
      ctx.arc(snap(from.sx), snap(from.sy), 9, -Math.PI / 2, -Math.PI / 2 + power * Math.PI * 2);
      ctx.stroke();
    }
  }

  // =======================================================================
  // HUD (drawn in art pixels, pixel-font styled)
  // =======================================================================
  _text(str, x, y, color, align = 'left', size = 6) {
    const ctx = this.ctx;
    ctx.font = `${size}px "Courier New", monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#04121c';
    ctx.fillText(str, x + 1, y + 1);
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
    ctx.textAlign = 'left';
  }

  _drawHUD() {
    const ctx = this.ctx;
    const sim = this.sim;
    const W = this.aw;

    // --- Top scoreboard bar ------------------------------------------------
    const barH = 16;
    ctx.fillStyle = PAL.hudBg;
    ctx.fillRect(0, 0, W, barH);
    ctx.fillStyle = PAL.hudEdge;
    ctx.fillRect(0, barH, W, 1);

    const home = sim.homeTeam, away = sim.awayTeam;
    // Team colour flags.
    ctx.fillStyle = home.colors.primary; ctx.fillRect(4, 3, 3, 10);
    ctx.fillStyle = away.colors.primary; ctx.fillRect(W - 7, 3, 3, 10);

    this._text(home.short, 10, 5, PAL.ink, 'left', 7);
    this._text(away.short, W - 10, 5, PAL.ink, 'right', 7);
    this._text(`${sim.score.home}-${sim.score.away}`, W / 2, 2, '#fff', 'center', 9);

    const m = Math.floor(sim.gameClock / 60), sec = Math.floor(sim.gameClock % 60);
    const clock = sim.gameClock < 60 ? `${sec}.${Math.floor((sim.gameClock % 1) * 10)}` : `${m}:${String(sec).padStart(2, '0')}`;
    this._text(`P${sim.period} ${clock}`, W / 2, 10, sim.gameClock < 30 ? PAL.warn : PAL.inkDim, 'center', 6);

    // Possession dot.
    if (sim.possession) {
      ctx.fillStyle = sim.teamOf(sim.possession).colors.primary;
      const px = sim.possession === 'home' ? 34 : W - 34;
      ctx.fillRect(px, 6, 3, 3);
    }

    // --- Shot clock (only in live play) -----------------------------------
    if (sim.possession && sim.isLive()) {
      const sc = Math.max(0, Math.ceil(sim.shotClock));
      const urgent = sim.shotClock < 5;
      ctx.fillStyle = PAL.hudBg;
      ctx.fillRect(W / 2 - 10, barH + 2, 20, 11);
      ctx.strokeStyle = urgent ? PAL.danger : PAL.hudEdge;
      ctx.strokeRect(W / 2 - 10 + 0.5, barH + 2 + 0.5, 20, 11);
      this._text(String(sc).padStart(2, '0'), W / 2, barH + 3, urgent ? PAL.danger : PAL.select, 'center', 8);
    }

    // --- Exclusions (little red markers under the bar) --------------------
    let ey = barH + 16;
    for (const ex of sim.exclusions.slice(0, 6)) {
      const left = ex.side === 'home';
      const x = left ? 4 : W - 40;
      ctx.fillStyle = 'rgba(80,10,14,0.8)';
      ctx.fillRect(x, ey, 36, 8);
      ctx.fillStyle = sim.teamOf(ex.side).colors.primary; ctx.fillRect(x, ey, 2, 8);
      this._text(`#${ex.athlete.player.capNumber} ${ex.forMatch ? 'OUT' : Math.ceil(ex.remaining) + 's'}`, x + 4, ey + 1, PAL.ink, 'left', 6);
      ey += 9;
    }

    // --- Controlled player card (bottom-left) -----------------------------
    const a = sim.userAthlete;
    if (a) {
      const cardW = 104, cardH = 34, cardY = this.ah - cardH;
      ctx.fillStyle = 'rgba(4,18,28,0.85)';
      ctx.fillRect(0, cardY, cardW, cardH);
      ctx.fillStyle = sim.teamOf(a.side).colors.primary;
      ctx.fillRect(0, cardY, 2, cardH);
      this._text(`#${a.player.capNumber} ${a.player.lastName}`, 5, cardY + 2, PAL.ink, 'left', 6);
      this._text(`${a.player.position} OVR ${a.player.overall}`, 5, cardY + 9, PAL.inkDim, 'left', 6);
      // Stars.
      this._text(starString(a.player.overall), cardW - 4, cardY + 2, PAL.warn, 'right', 6);

      // Stamina (burst) bar.
      this._text('STA', 5, cardY + 17, PAL.inkDim, 'left', 5);
      ctx.fillStyle = '#0a2634'; ctx.fillRect(22, cardY + 17, 54, 3);
      ctx.fillStyle = a.burst > 0.5 ? PAL.go : a.burst > 0.25 ? PAL.warn : PAL.danger;
      ctx.fillRect(22, cardY + 17, Math.round(54 * clamp01(a.burst)), 3);

      // Cansaco (accumulated match fatigue) bar - fills as the athlete tires.
      this._text('CANSAÇO', 5, cardY + 23, PAL.inkDim, 'left', 5);
      ctx.fillStyle = '#0a2634'; ctx.fillRect(34, cardY + 23, 42, 3);
      const fat = clamp01(a.matchFatigue / 0.9);
      ctx.fillStyle = fat > 0.66 ? PAL.danger : fat > 0.33 ? PAL.warn : PAL.select;
      ctx.fillRect(34, cardY + 23, Math.round(42 * fat), 3);

      // Personal fouls.
      const lim = sim.profile.discipline.personalFoulLimit;
      for (let i = 0; i < lim; i++) {
        ctx.fillStyle = i < a.personalFouls ? PAL.danger : '#0a2634';
        ctx.fillRect(5 + i * 5, cardY + 29, 3, 3);
      }
      this._text('FOULS', 5 + lim * 5 + 3, cardY + 28, PAL.inkDim, 'left', 5);
    }

    // --- Control hints (bottom-right) -------------------------------------
    if (this.settings.showHints && !('ontouchstart' in window)) {
      const hy = this.ah - 10;
      const hasBall = a && a.hasBall;
      const atk = a && sim.possession === a.side;
      const hint = hasBall ? 'SPACE shoot  J pass  L skip  Q protect'
        : atk ? 'SPACE switch nearer  J call'
          : 'SPACE steal  L block  E switch';
      this._text(hint, this.aw - 4, hy, 'rgba(200,225,240,0.55)', 'right', 6);
    }

    // --- Goal banner ------------------------------------------------------
    if (this.flash > 0.5 && sim.lastGoal && sim.clockNow - sim.lastGoal.at < 2) {
      this._text('GOAL!', this.aw / 2, this.ah / 2 - 20, PAL.ballMain, 'center', 22);
      if (sim.lastGoal.scorer) {
        this._text(`#${sim.lastGoal.scorer.player.capNumber} ${sim.lastGoal.scorer.player.name}`, this.aw / 2, this.ah / 2 + 6, PAL.ink, 'center', 7);
      }
    }
  }

}
// 3x2 pixel digit font (rows top->bottom, 2 bits each).
const DIGITS = {
  '0': [0b11, 0b11, 0b11], '1': [0b01, 0b01, 0b01], '2': [0b11, 0b11, 0b11],
  '3': [0b11, 0b01, 0b11], '4': [0b10, 0b11, 0b01], '5': [0b11, 0b10, 0b11],
  '6': [0b10, 0b11, 0b11], '7': [0b11, 0b01, 0b01], '8': [0b11, 0b11, 0b11],
  '9': [0b11, 0b11, 0b01],
};

// --- tiny colour helpers ---------------------------------------------------
function hexToRgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function lerpColor(a, b, t) {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  return rgbToHex(ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t);
}
function shade(hex, amt) {
  const c = hexToRgb(hex);
  const t = amt < 0 ? 0 : 255;
  const p = Math.abs(amt);
  return rgbToHex(c[0] + (t - c[0]) * p, c[1] + (t - c[1]) * p, c[2] + (t - c[2]) * p);
}
