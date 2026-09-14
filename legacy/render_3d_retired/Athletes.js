/**
 * Athlete rendering and procedural animation (Design Bible sections 23 and 25.1).
 *
 * Each athlete is a small procedural rig - hips, torso, shoulders, neck, head,
 * cap with a readable number and ear guards, two three-segment arms - driven
 * directly from the simulation state. There is no animation state machine that
 * can disagree with the physics: the body pitch comes from `verticality`, the
 * height from `elevation`, the stroke rate from actual speed, the arm target from
 * the real ball position.
 *
 * Section 23.3 forbids animation suction. Nothing here ever moves an athlete;
 * this file only ever *reads* simulation state and poses a skeleton.
 * Section 23.4 requires genuine left-handed treatment, so the throwing side is
 * driven by the athlete's dominant hand throughout, not mirrored at the end.
 */

import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, smoothstep, angleDelta } from '../core/Math2.js';
import { LOCOMOTION } from '../gameplay/Athlete.js';

const capTextureCache = new Map();

function capTexture(number, capColor, textColor) {
  const key = `${number}-${capColor}-${textColor}`;
  if (capTextureCache.has(key)) return capTextureCache.get(key);
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = capColor;
  g.fillRect(0, 0, 256, 128);
  // Number on both sides of the cap.
  g.fillStyle = textColor;
  g.font = 'bold 84px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(number), 64, 66);
  g.fillText(String(number), 192, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  capTextureCache.set(key, t);
  return t;
}

const SKIN_TONES = [0xf1c9a5, 0xe0ab84, 0xc68d63, 0xa06a45, 0x7a4d31, 0x5a3823, 0xf5d6bb];

export class AthleteView {
  /**
   * @param {import('../gameplay/Athlete.js').Athlete} athlete
   * @param {object} team team identity (colours)
   * @param {boolean} isGoalkeeper
   */
  constructor(athlete, team, quality = 2) {
    this.athlete = athlete;
    this.team = team;
    this.quality = quality;
    this.root = new THREE.Group();
    this.root.name = `athlete-${athlete.id}`;

    const p = athlete.player;
    const seed = hashString(p.id);
    const rnd = mulberry(seed);

    const skin = SKIN_TONES[Math.floor(rnd() * SKIN_TONES.length)];
    const heightScale = p.height / 190;

    // --- Materials ---------------------------------------------------------
    // Wet skin: a clearcoat layer over the diffuse gives the soaked sheen the
    // brief calls for without a bespoke shader.
    this.skinMat = new THREE.MeshPhysicalMaterial({
      color: skin, roughness: 0.34, metalness: 0.0,
      clearcoat: 0.85, clearcoatRoughness: 0.16, sheen: 0.35,
      sheenColor: new THREE.Color(0xbfe6ff),
    });
    const suitColor = new THREE.Color(team.colors.primary).multiplyScalar(0.55);
    this.suitMat = new THREE.MeshPhysicalMaterial({
      color: suitColor, roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.3,
    });

    const isGk = athlete.isGoalkeeper;
    const capColor = isGk ? '#e02020' : team.colors.cap;
    const capText = isGk ? '#ffffff' : team.colors.capAlt;
    this.capMat = new THREE.MeshPhysicalMaterial({
      map: capTexture(p.capNumber, capColor, capText),
      roughness: 0.28, clearcoat: 0.9, clearcoatRoughness: 0.1,
    });

    // --- Rig ---------------------------------------------------------------
    const seg = quality >= 2 ? 12 : 7;

    this.hips = new THREE.Group();
    this.root.add(this.hips);

    this.torso = new THREE.Group();
    this.hips.add(this.torso);

    const chest = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.19 * heightScale, 0.42 * heightScale, 4, seg),
      this.suitMat
    );
    chest.rotation.x = Math.PI / 2;
    chest.position.z = 0.24 * heightScale;
    chest.castShadow = true;
    this.torso.add(chest);

    const shoulders = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.155 * heightScale, 0.30 * heightScale, 4, seg),
      this.skinMat
    );
    shoulders.rotation.z = Math.PI / 2;
    shoulders.position.set(0, 0.05 * heightScale, -0.02);
    shoulders.castShadow = true;
    this.torso.add(shoulders);

    // Legs, only ever glimpsed beneath the surface but they sell the eggbeater.
    this.legs = new THREE.Group();
    this.hips.add(this.legs);
    this.thigh = [];
    for (const side of [-1, 1]) {
      const leg = new THREE.Group();
      const upper = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.085 * heightScale, 0.36 * heightScale, 3, 6),
        this.skinMat
      );
      upper.position.y = -0.20 * heightScale;
      leg.add(upper);
      const lower = new THREE.Group();
      lower.position.y = -0.40 * heightScale;
      const shin = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.065 * heightScale, 0.34 * heightScale, 3, 6),
        this.skinMat
      );
      shin.position.y = -0.19 * heightScale;
      lower.add(shin);
      leg.add(lower);
      leg.position.set(side * 0.09 * heightScale, -0.12 * heightScale, 0.42 * heightScale);
      leg.userData.knee = lower;
      this.legs.add(leg);
      this.thigh.push(leg);
    }

    // --- Head and cap ------------------------------------------------------
    this.neck = new THREE.Group();
    this.neck.position.set(0, 0.10 * heightScale, -0.24 * heightScale);
    this.torso.add(this.neck);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.105 * heightScale, seg + 4, seg), this.skinMat);
    head.castShadow = true;
    this.neck.add(head);

    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.113 * heightScale, seg + 6, seg, 0, Math.PI * 2, 0, Math.PI * 0.62),
      this.capMat
    );
    cap.rotation.x = -0.22;
    this.neck.add(cap);

    // Ear protection: the little cups that make a water polo cap unmistakable.
    const guardMat = new THREE.MeshPhysicalMaterial({ color: 0xf4f7fa, roughness: 0.4, clearcoat: 0.5 });
    for (const side of [-1, 1]) {
      const guard = new THREE.Mesh(new THREE.SphereGeometry(0.045 * heightScale, 8, 6), guardMat);
      guard.scale.set(0.55, 1, 1);
      guard.position.set(side * 0.105 * heightScale, -0.005, 0.005);
      this.neck.add(guard);
    }

    // --- Arms --------------------------------------------------------------
    this.arms = {};
    for (const side of ['left', 'right']) {
      const s = side === 'left' ? -1 : 1;
      const shoulder = new THREE.Group();
      shoulder.position.set(s * 0.175 * heightScale, 0.05 * heightScale, -0.03 * heightScale);
      this.torso.add(shoulder);

      const upperArm = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.055 * heightScale, 0.28 * heightScale, 3, 6),
        this.skinMat
      );
      upperArm.position.y = -0.16 * heightScale;
      upperArm.castShadow = true;
      shoulder.add(upperArm);

      const elbow = new THREE.Group();
      elbow.position.y = -0.32 * heightScale;
      shoulder.add(elbow);

      const foreArm = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.046 * heightScale, 0.26 * heightScale, 3, 6),
        this.skinMat
      );
      foreArm.position.y = -0.15 * heightScale;
      foreArm.castShadow = true;
      elbow.add(foreArm);

      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.052 * heightScale, 7, 6), this.skinMat);
      hand.scale.set(1, 1.25, 0.55);
      hand.position.y = -0.31 * heightScale;
      elbow.add(hand);

      this.arms[side] = { shoulder, elbow, hand, sign: s };
    }

    this.throwSide = athlete.player.leftHanded ? 'left' : 'right';
    this.offSide = athlete.player.leftHanded ? 'right' : 'left';
    this.heightScale = heightScale;

    // --- Indicator (section 28.2) -----------------------------------------
    this.indicator = buildIndicator(team.colors.primary);
    this.indicator.visible = false;
    this.root.add(this.indicator);

    this.strokePhase = rnd() * Math.PI * 2;
    this.legPhase = rnd() * Math.PI * 2;
    this._bodyPitch = 0;
    this._armBlend = { throw: 0, block: 0 };
    this.tmp = new THREE.Vector3();
  }

  setIndicator(mode) {
    // mode: 'none' | 'controlled' | 'teammate' | 'switchTarget'
    this.indicator.visible = mode !== 'none';
    if (mode === 'none') return;
    const c = this.indicator.userData;
    if (mode === 'controlled') { c.ring.material.color.set(0x7dd3fc); c.arrow.material.color.set(0xffffff); c.arrow.visible = true; }
    else if (mode === 'switchTarget') { c.ring.material.color.set(0xfbbf24); c.arrow.visible = false; }
    else { c.ring.material.color.set(this.team.colors.primary); c.arrow.visible = false; }
  }

  /**
   * Pose the rig from simulation state.
   * @param {number} dt
   * @param {number} time
   * @param {object} ctx { ball, surfaceHeight(x,z) }
   */
  update(dt, time, ctx) {
    const a = this.athlete;
    const h = this.heightScale;

    if (!a.inPool) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    // --- Placement ---------------------------------------------------------
    const surf = ctx.surfaceHeight ? ctx.surfaceHeight(a.pos.x, a.pos.z) : 0;
    // Buoyancy: the waterline sits at chest height when vertical, at the back
    // when horizontal. `elevation` lifts the whole body out of the water.
    const vert = a.verticality;
    const baseY = surf - 0.30 * h + a.elevation * 1.0;
    this.root.position.set(a.pos.x, baseY, a.pos.z);
    this.root.rotation.y = a.heading;

    // --- Body pitch: horizontal swimming vs vertical eggbeater -------------
    const targetPitch = lerp(-Math.PI * 0.42, 0, vert);
    this._bodyPitch = damp(this._bodyPitch, targetPitch, 9, dt);
    this.hips.rotation.x = this._bodyPitch;

    // Shoulder line lags the head, exactly as the simulation models it.
    this.torso.rotation.y = angleDelta(a.heading, a.shoulder);

    // Roll with the stroke when swimming; brace against contact when vertical.
    const speedFrac = clamp01(a.speed / Math.max(0.6, a.maxSpeed));
    const roll = Math.sin(this.strokePhase) * 0.42 * (1 - vert) * speedFrac;
    this.torso.rotation.z = roll + (a.contactLoad * 0.25 * (a.pos.x > 0 ? -1 : 1));

    // --- Stroke and leg cycles --------------------------------------------
    const strokeRate = lerp(1.6, 7.2, speedFrac) * lerp(0.7, 1.0, a.freshness);
    this.strokePhase += dt * strokeRate * (1 - vert * 0.85);
    // Eggbeater: alternating circular leg drive, faster when elevating hard.
    const eggRate = lerp(4.5, 12.0, clamp01(a.elevation / Math.max(0.15, a.maxElevation))) * lerp(0.6, 1, a.freshness);
    this.legPhase += dt * eggRate * (0.35 + vert * 0.8);

    this._poseLegs(vert, h);
    this._poseArms(dt, vert, speedFrac, ctx, h);

    // Head tracking: look at the ball when it matters (section 23.2).
    if (ctx.ball) {
      const dx = ctx.ball.pos.x - a.pos.x;
      const dz = ctx.ball.pos.z - a.pos.z;
      const want = Math.atan2(dx, dz);
      const rel = clamp(angleDelta(a.shoulder, want), -1.0, 1.0);
      this.neck.rotation.y = damp(this.neck.rotation.y, rel, 8, dt);
      const dy = ctx.ball.pos.y - (baseY + 0.35 * h);
      this.neck.rotation.x = damp(this.neck.rotation.x, clamp(-dy * 0.35, -0.5, 0.6) - this._bodyPitch * 0.75, 8, dt);
    }

    // Fatigue reads on the body: a tired athlete sits lower and rolls more.
    const tired = 1 - a.freshness;
    this.root.position.y -= tired * 0.035;

    if (this.indicator.visible) {
      this.indicator.position.y = 0.55 * h - a.elevation * 0.6;
      this.indicator.rotation.y = -a.heading + time * 0.6;
    }
  }

  _poseLegs(vert, h) {
    // Eggbeater is an alternating circular kick; freestyle is a flutter.
    for (let i = 0; i < 2; i++) {
      const leg = this.thigh[i];
      const ph = this.legPhase + i * Math.PI;
      const egg = vert;
      const circleX = Math.sin(ph) * 0.85;
      const circleZ = Math.cos(ph) * 0.5;
      const flutter = Math.sin(ph * 1.6) * 0.32;
      leg.rotation.x = lerp(flutter, circleX * 0.55 - 0.55, egg);
      leg.rotation.z = lerp(0, circleZ * 0.5 * (i === 0 ? -1 : 1), egg);
      leg.userData.knee.rotation.x = lerp(Math.max(0, flutter) * 0.6, 0.9 + Math.sin(ph) * 0.7, egg);
    }
  }

  _poseArms(dt, vert, speedFrac, ctx, h) {
    const a = this.athlete;
    const throwArm = this.arms[this.throwSide];
    const offArm = this.arms[this.offSide];

    // Blend weights for the three arm behaviours we need to mix.
    const wantThrow = (a.charging === 'shot' || a.charging === 'pass' || a.hasBall) ? 1 : 0;
    const wantBlock = a.armRaised;
    this._armBlend.throw = damp(this._armBlend.throw, wantThrow, 11, dt);
    this._armBlend.block = damp(this._armBlend.block, wantBlock, 13, dt);

    const swimW = clamp01(1 - Math.max(this._armBlend.throw, this._armBlend.block)) * (1 - vert * 0.7);

    // --- Freestyle windmill -------------------------------------------------
    const stroke = (arm, phase) => {
      const s = Math.sin(phase);
      const c = Math.cos(phase);
      return {
        x: -1.5 + c * 1.55,
        z: arm.sign * (0.25 + Math.max(0, s) * 0.35),
        elbow: 0.35 + Math.max(0, -s) * 1.15,
      };
    };
    const sThrow = stroke(throwArm, this.strokePhase);
    const sOff = stroke(offArm, this.strokePhase + Math.PI);

    // --- Vertical / treading pose ------------------------------------------
    const tread = (arm, phase) => ({
      x: -0.15 + Math.sin(phase * 0.6) * 0.2,
      z: arm.sign * (0.85 + Math.sin(phase * 0.8) * 0.18),
      elbow: 0.75,
    });
    const tThrow = tread(throwArm, this.legPhase);
    const tOff = tread(offArm, this.legPhase + 1.6);

    // --- Throwing / carrying pose ------------------------------------------
    // The hand goes where the simulation says the hand is, so the ball is never
    // detached from the athlete holding it.
    const hp = a.handPoint();
    const local = this.tmp.set(hp.x, hp.y, hp.z);
    this.root.worldToLocal(local);
    const armReach = Math.hypot(local.x, local.y, local.z);
    const throwPose = {
      x: clamp(-Math.PI * 0.55 - local.y * 0.5, -2.6, 0.4),
      z: throwArm.sign * clamp(0.35 + Math.abs(local.x) * 0.7, 0, 1.5),
      elbow: clamp(1.35 - armReach * 0.9, 0.1, 1.9),
    };
    const carryPose = { x: -0.5, z: throwArm.sign * 0.55, elbow: 1.1 };
    const throwing = a.charging === 'shot' ? 1 : a.charging === 'pass' ? 0.75 : 0.25;
    const tp = {
      x: lerp(carryPose.x, throwPose.x, throwing),
      z: lerp(carryPose.z, throwPose.z, throwing),
      elbow: lerp(carryPose.elbow, throwPose.elbow, throwing),
    };

    // --- Block pose (arm straight up, the sport's signature silhouette) -----
    const blockPose = { x: -2.85, z: throwArm.sign * 0.12, elbow: 0.06 };
    const gkBlock = a.isGoalkeeper
      ? { x: -2.4, z: throwArm.sign * 0.85, elbow: 0.12 }
      : blockPose;

    const mix = (base, add, w) => ({
      x: lerp(base.x, add.x, w), z: lerp(base.z, add.z, w), elbow: lerp(base.elbow, add.elbow, w),
    });

    let poseThrow = mix(tThrow, sThrow, swimW);
    poseThrow = mix(poseThrow, tp, this._armBlend.throw);
    poseThrow = mix(poseThrow, gkBlock, this._armBlend.block);

    let poseOff = mix(tOff, sOff, swimW);
    if (a.isGoalkeeper) {
      poseOff = mix(poseOff, { x: -2.4, z: offArm.sign * 0.85, elbow: 0.12 }, this._armBlend.block);
    } else if (a.hasBall) {
      // Off arm sculls for balance while the throwing arm carries.
      poseOff = mix(poseOff, { x: -0.1, z: offArm.sign * 1.05, elbow: 0.6 }, this._armBlend.throw * 0.8);
    }

    applyArm(throwArm, poseThrow, dt);
    applyArm(offArm, poseOff, dt);
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
  }
}

function applyArm(arm, pose, dt) {
  arm.shoulder.rotation.x = damp(arm.shoulder.rotation.x, pose.x, 16, dt);
  arm.shoulder.rotation.z = damp(arm.shoulder.rotation.z, pose.z, 16, dt);
  arm.elbow.rotation.x = damp(arm.elbow.rotation.x, pose.elbow, 16, dt);
}

/**
 * Player indicator. Must stay legible against light water, dark water,
 * reflections, foam and glare (section 28.2), so it is a bright unlit ring with a
 * dark outline rather than a tint that the water can wash out.
 */
function buildIndicator(color) {
  const g = new THREE.Group();
  const outline = new THREE.Mesh(
    new THREE.RingGeometry(0.30, 0.42, 32),
    new THREE.MeshBasicMaterial({ color: 0x05080c, transparent: true, opacity: 0.75, depthTest: false, toneMapped: false })
  );
  outline.rotation.x = -Math.PI / 2;
  outline.renderOrder = 900;
  g.add(outline);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.32, 0.40, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, toneMapped: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 901;
  g.add(ring);

  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(0, 0.16);
  arrowShape.lineTo(-0.13, -0.10);
  arrowShape.lineTo(0.13, -0.10);
  arrowShape.closePath();
  const arrow = new THREE.Mesh(
    new THREE.ShapeGeometry(arrowShape),
    new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, toneMapped: false })
  );
  arrow.rotation.x = -Math.PI / 2;
  arrow.position.set(0, 0.01, 0.62);
  arrow.renderOrder = 902;
  g.add(arrow);

  g.userData = { ring, arrow, outline };
  return g;
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function mulberry(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
