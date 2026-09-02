/**
 * Water effects and the ball (Design Bible sections 12, 25.2, 25.3).
 *
 * Splash sheets, droplets, spray and surface rings are all spawned from real
 * simulation events - a hand entering the water on a stroke, a ball hitting the
 * surface at a measured speed, a body rising through an explosive eggbeater.
 * Section 5 explicitly forbids using splash to hide poor contact resolution, so
 * nothing here is spawned "for looks": every emitter has a physical cause, and
 * splash density is a user setting (section 24.3).
 */

import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../core/Math2.js';

const MAX_PARTICLES = 4096;

function dropletTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(226,246,255,0.85)');
  grad.addColorStop(0.75, 'rgba(170,220,245,0.25)');
  grad.addColorStop(1, 'rgba(150,210,240,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class SplashSystem {
  constructor(scene, quality = 2) {
    this.quality = quality;
    this.density = [0.35, 0.65, 1.0, 1.4][quality] ?? 1;

    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.velocities = new Float32Array(MAX_PARTICLES * 3);
    this.life = new Float32Array(MAX_PARTICLES);
    this.maxLife = new Float32Array(MAX_PARTICLES);
    this.size = new Float32Array(MAX_PARTICLES);
    this.alpha = new Float32Array(MAX_PARTICLES);
    this.cursor = 0;
    this.activeCount = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setDrawRange(0, MAX_PARTICLES);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: dropletTexture() },
        uPixelRatio: { value: Math.min(window.devicePixelRatio ?? 1, 2) },
        uTint: { value: new THREE.Color(0xdff2ff) },
      },
      vertexShader: /* glsl */`
        attribute float aSize;
        attribute float aAlpha;
        uniform float uPixelRatio;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uPixelRatio * (260.0 / max(-mv.z, 0.6));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        uniform vec3 uTint;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.001) discard;
          vec4 t = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(uTint * t.rgb * 1.35, t.a * vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
    scene.add(this.points);
    this.geometry = geo;

    // --- Surface rings: the flat sheet a body or ball pushes outward --------
    this.ringPool = [];
    this.ringGroup = new THREE.Group();
    scene.add(this.ringGroup);
    const ringGeo = new THREE.RingGeometry(0.2, 0.34, 28);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 28; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: 0xeaf7ff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
      }));
      m.visible = false;
      m.renderOrder = 15;
      this.ringGroup.add(m);
      this.ringPool.push({ mesh: m, life: 0, maxLife: 1, scale0: 1, scale1: 3 });
    }
    this.ringCursor = 0;
  }

  setQuality(q) {
    this.quality = q;
    this.density = [0.35, 0.65, 1.0, 1.4][q] ?? 1;
  }

  /**
   * @param {number} count particles requested (scaled by the density setting)
   * @param {object} at    {x,y,z} spawn centre
   * @param {object} dir   {x,y,z} bias direction
   * @param {number} power 0..1 energy
   */
  burst(count, at, dir, power, spread = 1) {
    const n = Math.round(count * this.density);
    for (let i = 0; i < n; i++) {
      const idx = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      const o = idx * 3;
      this.positions[o] = at.x + (Math.random() - 0.5) * 0.18 * spread;
      this.positions[o + 1] = at.y + Math.random() * 0.08;
      this.positions[o + 2] = at.z + (Math.random() - 0.5) * 0.18 * spread;

      const s = power * (0.55 + Math.random() * 0.9);
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() ** 0.6;
      this.velocities[o] = (dir.x * 0.55 + Math.cos(a) * r * spread) * s * 2.4;
      this.velocities[o + 1] = (Math.abs(dir.y) * 0.6 + 0.55 + Math.random() * 0.8) * s * 3.1;
      this.velocities[o + 2] = (dir.z * 0.55 + Math.sin(a) * r * spread) * s * 2.4;

      this.maxLife[idx] = 0.34 + Math.random() * 0.55 * power;
      this.life[idx] = this.maxLife[idx];
      this.size[idx] = (0.7 + Math.random() * 1.9) * lerp(0.7, 1.5, power);
      this.alpha[idx] = 0.9;
    }
  }

  /** A flat expanding sheet on the surface. */
  ring(x, z, radius, strength) {
    const r = this.ringPool[this.ringCursor];
    this.ringCursor = (this.ringCursor + 1) % this.ringPool.length;
    r.mesh.visible = true;
    r.mesh.position.set(x, 0.015, z);
    r.life = r.maxLife = 0.45 + strength * 0.5;
    r.scale0 = radius * 0.5;
    r.scale1 = radius * (2.2 + strength * 2.4);
    r.mesh.material.opacity = clamp01(0.35 * strength);
    r.mesh.scale.setScalar(r.scale0);
  }

  update(dt) {
    const g = 9.81;
    let alive = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const o = i * 3;
      this.velocities[o + 1] -= g * dt;
      // Air drag on droplets: they slow quickly, which is what makes spray read
      // as water rather than as sparks.
      const drag = Math.exp(-2.2 * dt);
      this.velocities[o] *= drag;
      this.velocities[o + 1] *= drag;
      this.velocities[o + 2] *= drag;

      this.positions[o] += this.velocities[o] * dt;
      this.positions[o + 1] += this.velocities[o + 1] * dt;
      this.positions[o + 2] += this.velocities[o + 2] * dt;

      if (this.positions[o + 1] < 0.005) { this.life[i] = 0; this.alpha[i] = 0; continue; }
      const t = clamp01(this.life[i] / this.maxLife[i]);
      this.alpha[i] = t * t * 0.95;
      alive++;
    }
    this.activeCount = alive;
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;

    for (const r of this.ringPool) {
      if (!r.mesh.visible) continue;
      r.life -= dt;
      if (r.life <= 0) { r.mesh.visible = false; continue; }
      const t = 1 - r.life / r.maxLife;
      r.mesh.scale.setScalar(lerp(r.scale0, r.scale1, t ** 0.6));
      r.mesh.material.opacity = (1 - t) ** 1.5 * 0.4;
    }
  }
}

/** The match ball: yellow, ridged, with a wet sheen and a motion trail. */
export class BallView {
  constructor(scene, ball, quality = 2) {
    this.ball = ball;

    const tex = ballTexture();
    this.material = new THREE.MeshPhysicalMaterial({
      map: tex,
      roughness: 0.42,
      clearcoat: 0.75,
      clearcoatRoughness: 0.22,
      sheen: 0.4,
      sheenColor: new THREE.Color(0xffffff),
    });
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(ball.radius, quality >= 2 ? 32 : 16, quality >= 2 ? 24 : 12),
      this.material
    );
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    // Trail: a short ribbon of past positions, only visible at speed.
    this.trailLen = 22;
    this.trailPositions = new Float32Array(this.trailLen * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    this.trail = new THREE.Line(tg, new THREE.LineBasicMaterial({
      color: 0xfff2a8, transparent: true, opacity: 0.0, depthWrite: false, toneMapped: false,
    }));
    this.trail.frustumCulled = false;
    scene.add(this.trail);
    this.trailGeo = tg;
    this._history = [];

    this.spinQuat = new THREE.Quaternion();
    this.axis = new THREE.Vector3();
  }

  update(dt, splash) {
    const b = this.ball;
    this.mesh.position.set(b.pos.x, b.pos.y, b.pos.z);

    // Roll the ball from its real angular velocity.
    const w = Math.hypot(b.spin.x, b.spin.y, b.spin.z);
    if (w > 0.01) {
      this.axis.set(b.spin.x / w, b.spin.y / w, b.spin.z / w);
      this.spinQuat.setFromAxisAngle(this.axis, w * dt);
      this.mesh.quaternion.premultiply(this.spinQuat);
    }

    // Trail.
    const speed = b.speed;
    this._history.unshift({ x: b.pos.x, y: b.pos.y, z: b.pos.z });
    if (this._history.length > this.trailLen) this._history.pop();
    for (let i = 0; i < this.trailLen; i++) {
      const p = this._history[Math.min(i, this._history.length - 1)];
      this.trailPositions[i * 3] = p.x;
      this.trailPositions[i * 3 + 1] = p.y;
      this.trailPositions[i * 3 + 2] = p.z;
    }
    this.trailGeo.attributes.position.needsUpdate = true;
    this.trail.material.opacity = clamp01((speed - 9) / 14) * 0.55;

    // Splash from the ball's own surface events.
    if (splash) {
      if (b.eventFlags.splash > 0.05) {
        const p = b.eventFlags.splash;
        splash.burst(Math.round(8 + p * 46), { x: b.pos.x, y: 0.05, z: b.pos.z },
          { x: b.vel.x * 0.1, y: 1, z: b.vel.z * 0.1 }, clamp01(0.35 + p), 1.1);
        splash.ring(b.pos.x, b.pos.z, 0.28 + p * 0.5, clamp01(p));
        b.eventFlags.splash = 0;
      }
      if (b.eventFlags.waterExit > 0.05) {
        splash.burst(18, { x: b.pos.x, y: 0.06, z: b.pos.z }, { x: 0, y: 1, z: 0 }, 0.65, 0.7);
        b.eventFlags.waterExit = 0;
      }
    }
  }
}

function ballTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#f2c400';
  g.fillRect(0, 0, 512, 256);

  // Panel seams and the pebbled grip a water polo ball actually has.
  g.strokeStyle = 'rgba(120, 90, 0, 0.55)';
  g.lineWidth = 4;
  for (let i = 0; i < 6; i++) {
    g.beginPath();
    g.moveTo((i * 512) / 6, 0);
    g.bezierCurveTo((i * 512) / 6 + 40, 85, (i * 512) / 6 - 40, 171, (i * 512) / 6, 256);
    g.stroke();
  }
  g.strokeStyle = 'rgba(120, 90, 0, 0.35)';
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(0, 128); g.lineTo(512, 128); g.stroke();

  g.fillStyle = 'rgba(255,255,255,0.10)';
  for (let i = 0; i < 2600; i++) {
    g.beginPath();
    g.arc(Math.random() * 512, Math.random() * 256, 1.6, 0, Math.PI * 2);
    g.fill();
  }

  // A tasteful, entirely fictional maker's mark.
  g.fillStyle = 'rgba(60, 45, 0, 0.8)';
  g.font = 'bold 26px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText('AQUASTRIKE', 256, 74);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
