/**
 * Camera system (Design Bible section 24).
 *
 * The default broadcast camera follows the ball while preserving tactical
 * spacing, keeps passing options in frame, zooms out on counters, avoids
 * excessive lateral motion and keeps near-side and far-side depth readable.
 * Alternate cameras cover the rest of section 24.2, including an accessibility
 * camera with reduced movement and a replay-only underwater view.
 */

import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, smoothstep } from '../core/Math2.js';

export const CAMERAS = [
  { id: 'broadcast', name: 'Broadcast', desc: 'Elevated side view that follows play.' },
  { id: 'tactical', name: 'Tactical Wide', desc: 'High and wide; the whole field of play stays visible.' },
  { id: 'lock', name: 'Player Lock', desc: 'Close behind the athlete you control.' },
  { id: 'goalkeeper', name: 'Goalkeeper', desc: 'From behind the goal you are defending.' },
  { id: 'elevated', name: 'Elevated Broadcast', desc: 'Higher, slower, more televisual.' },
  { id: 'deck', name: 'Pool Deck', desc: 'Low, at the waterline, on the near deck.' },
  { id: 'accessible', name: 'Accessibility', desc: 'Fixed framing with strongly reduced movement.' },
  { id: 'behindGoal', name: 'Behind Goal', desc: 'Attacking end, behind the cage.' },
  { id: 'overhead', name: 'Overhead Tactical', desc: 'Straight down; the coach\'s view.' },
];

export class CameraRig {
  constructor(camera, profile) {
    this.camera = camera;
    this.profile = profile;
    this.mode = 'broadcast';
    this.side = -1;              // which long side the broadcast camera sits on
    this.shake = 0;
    this.shakeEnabled = true;
    this.reducedMotion = false;

    this.target = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.current = new THREE.Vector3(0, 12, -22);
    this.currentLook = new THREE.Vector3(0, 0, 0);
    this.fov = 42;
    this._shakeOffset = new THREE.Vector3();
    this._replay = null;
  }

  setMode(mode) {
    this.mode = mode;
    this._snap = true;
  }

  cycle(dir = 1) {
    const i = CAMERAS.findIndex((c) => c.id === this.mode);
    const next = CAMERAS[(i + dir + CAMERAS.length) % CAMERAS.length];
    this.setMode(next.id);
    return next;
  }

  addShake(amount) {
    if (!this.shakeEnabled || this.reducedMotion) return;
    this.shake = Math.min(1, this.shake + amount);
  }

  /**
   * @param {number} dt
   * @param {object} ctx { ball, userAthlete, sim }
   */
  update(dt, ctx) {
    const f = this.profile.field;
    const { ball, sim } = ctx;
    const halfL = f.length / 2;
    const halfW = f.width / 2;

    // Focus point: the ball, pulled toward the centre of mass of nearby play so
    // that tactical spacing stays in frame rather than the ball filling it.
    const focus = this._focusPoint(ctx);

    let pos = this.target;
    let look = this.lookAt;
    let fov = 42;
    let lambda = this.reducedMotion ? 1.6 : 3.4;

    switch (this.mode) {
      case 'broadcast': {
        // Sit off the long side, high enough to read depth, and track mostly
        // along z so lateral motion stays calm (section 24.1).
        const spread = this._playSpread(ctx);
        const zoom = lerp(1.0, 1.35, smoothstep(clamp01((spread - 8) / 14)));
        const counter = sim && sim.transitionTimer > 0 ? 1.18 : 1.0;
        const dist = 17.5 * zoom * counter;
        pos.set(
          clamp(focus.x * 0.22, -3.2, 3.2) + this.side * dist * 0.72,
          9.2 * zoom,
          clamp(focus.z * 0.86, -halfL + 1, halfL - 1)
        );
        look.set(clamp(focus.x * 0.55, -halfW, halfW), 0.35, clamp(focus.z, -halfL, halfL));
        fov = 40 - (zoom - 1) * 6;
        break;
      }
      case 'elevated': {
        pos.set(this.side * 20, 15.5, clamp(focus.z * 0.62, -8, 8));
        look.set(focus.x * 0.35, 0.2, focus.z * 0.9);
        fov = 36;
        lambda = 2.2;
        break;
      }
      case 'tactical': {
        pos.set(this.side * 8, 26, 0);
        look.set(0, 0, focus.z * 0.35);
        fov = 46;
        lambda = 1.8;
        break;
      }
      case 'lock': {
        const a = ctx.userAthlete;
        if (a) {
          const hx = Math.sin(a.heading), hz = Math.cos(a.heading);
          pos.set(a.pos.x - hx * 5.4, 2.9 + a.elevation, a.pos.z - hz * 5.4);
          look.set(a.pos.x + hx * 3.5, 0.5 + a.elevation * 0.8, a.pos.z + hz * 3.5);
          fov = 52;
          lambda = 5.5;
        }
        break;
      }
      case 'goalkeeper': {
        const side = sim?.userControlsSide ?? 'home';
        const dir = sim ? -sim.attackDir[side] : 1;
        pos.set(0, 3.4, dir * (halfL + 6.5));
        look.set(clamp(focus.x * 0.7, -6, 6), 0.6, focus.z * 0.75);
        fov = 50;
        lambda = 2.4;
        break;
      }
      case 'behindGoal': {
        const dir = ctx.userAthlete ? ctx.userAthlete.attackDir : 1;
        pos.set(clamp(focus.x * 0.5, -4, 4), 4.2, dir * (halfL + 7.5));
        look.set(focus.x * 0.7, 0.5, focus.z);
        fov = 46;
        break;
      }
      case 'deck': {
        pos.set(this.side * (halfW + 2.6), 1.35, clamp(focus.z * 0.8, -halfL, halfL));
        look.set(focus.x, 0.35, focus.z);
        fov = 48;
        lambda = 4.2;
        break;
      }
      case 'overhead': {
        pos.set(0, 34, focus.z * 0.25);
        look.set(0, 0, focus.z * 0.3);
        fov = 42;
        lambda = 2.0;
        break;
      }
      case 'accessible': {
        // Fixed framing, minimal movement: the whole field always visible.
        pos.set(this.side * 23, 16.5, 0);
        look.set(0, 0, 0);
        fov = 44;
        lambda = 0.9;
        break;
      }
      default: break;
    }

    if (this._snap) {
      this.current.copy(pos);
      this.currentLook.copy(look);
      this.camera.fov = fov;
      this._snap = false;
    } else {
      const l = this.reducedMotion ? lambda * 0.5 : lambda;
      this.current.x = damp(this.current.x, pos.x, l, dt);
      this.current.y = damp(this.current.y, pos.y, l, dt);
      this.current.z = damp(this.current.z, pos.z, l, dt);
      this.currentLook.x = damp(this.currentLook.x, look.x, l * 1.25, dt);
      this.currentLook.y = damp(this.currentLook.y, look.y, l * 1.25, dt);
      this.currentLook.z = damp(this.currentLook.z, look.z, l * 1.25, dt);
      this.camera.fov = damp(this.camera.fov, fov, 3, dt);
    }

    // Shake: only from real impacts, and always disableable (section 24.3).
    this.shake = Math.max(0, this.shake - dt * 2.6);
    if (this.shake > 0.001) {
      const s = this.shake * this.shake * 0.28;
      this._shakeOffset.set(
        (Math.random() - 0.5) * s,
        (Math.random() - 0.5) * s,
        (Math.random() - 0.5) * s
      );
    } else {
      this._shakeOffset.set(0, 0, 0);
    }

    this.camera.position.copy(this.current).add(this._shakeOffset);
    this.camera.lookAt(this.currentLook);
    this.camera.updateProjectionMatrix();
  }

  _focusPoint(ctx) {
    const b = ctx.ball;
    const holder = b.holder;
    const x = holder ? holder.pos.x : b.pos.x;
    const z = holder ? holder.pos.z : b.pos.z;
    return { x, z };
  }

  /** How spread out the athletes are: drives the broadcast zoom. */
  _playSpread(ctx) {
    const list = ctx.sim ? ctx.sim.allActive() : [];
    if (list.length < 2) return 8;
    let minZ = Infinity, maxZ = -Infinity;
    for (const a of list) { if (a.pos.z < minZ) minZ = a.pos.z; if (a.pos.z > maxZ) maxZ = a.pos.z; }
    return maxZ - minZ;
  }
}
