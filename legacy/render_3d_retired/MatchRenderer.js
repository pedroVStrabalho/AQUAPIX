/**
 * MatchRenderer - assembles the 3D presentation of a match.
 *
 * Render order per frame:
 *   1. splat the simulation into the wake field (visual water reads gameplay)
 *   2. pose every athlete rig from simulation state
 *   3. render the refraction pass (scene without the surface, with depth)
 *   4. render the planar reflection pass (mirrored camera, oblique clip)
 *   5. render the final scene through the post-processing chain
 *
 * Performance priorities follow section 43: input and simulation are never
 * blocked by presentation, and every expensive layer has a quality level.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import { WakeField } from './WakeField.js';
import { WaterSurface } from './Water.js';
import { Venue, VENUES } from './Venue.js';
import { AthleteView } from './Athletes.js';
import { SplashSystem, BallView } from './Effects.js';
import { CameraRig } from './CameraRig.js';
import { clamp, clamp01, lerp } from '../core/Math2.js';

export const QUALITY_LEVELS = ['Low', 'Medium', 'High', 'Ultra'];

export class MatchRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../core/MatchSim.js').MatchSim} sim
   * @param {object} settings
   */
  constructor(canvas, sim, settings = {}) {
    this.canvas = canvas;
    this.sim = sim;
    this.settings = {
      quality: 2,
      splashDensity: 1,
      bloom: 1,
      cameraShake: true,
      reducedMotion: false,
      highContrastBall: false,
      showIndicators: true,
      showPassLanes: false,
      showShotQuality: true,
      aiDebug: false,
      ...settings,
    };

    const q = this.settings.quality;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: q >= 2,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, q >= 2 ? 2 : 1.25));
    this.renderer.setSize(canvas.clientWidth || 1280, canvas.clientHeight || 720, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = q >= 2;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 260);

    // Image-based lighting so the wet athletes and the ball pick up the room.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.05).texture;
    this.scene.environment = this.envMap;
    pmrem.dispose();

    const f = sim.profile.field;

    this.wake = new WakeField(f.width, f.length, q >= 2 ? 176 : 112);

    const venueKey = sim.homeTeam.venue in VENUES ? sim.homeTeam.venue : 'meridian-arena';
    this.venue = new Venue(this.scene, sim.profile, venueKey, sim.homeTeam, sim.awayTeam);
    this.venue.connectWake(this.wake);
    this.venueDef = this.venue.def;

    this.water = new WaterSurface({
      width: f.width, length: f.length, wakeField: this.wake,
      renderWidth: canvas.clientWidth || 1280, renderHeight: canvas.clientHeight || 720,
    });
    this.water.setVenue({
      waterColor: this.venueDef.water.color,
      deepColor: this.venueDef.water.deep,
      glare: this.venueDef.water.glare,
    });
    this.water.setQuality(q);
    this.water.uniforms.uSunDirection.value
      .copy(new THREE.Vector3(0.3, 0.85, 0.42).normalize());
    this.scene.add(this.water.mesh);

    this.splash = new SplashSystem(this.scene, q);
    this.ballView = new BallView(this.scene, sim.ball, q);
    this.rig = new CameraRig(this.camera, sim.profile);
    this.rig.shakeEnabled = this.settings.cameraShake;
    this.rig.reducedMotion = this.settings.reducedMotion;

    // Athlete views for the whole squad, including the bench.
    this.views = new Map();
    for (const side of ['home', 'away']) {
      const team = side === 'home' ? sim.homeTeam : sim.awayTeam;
      for (const a of sim.squads[side]) {
        const view = new AthleteView(a, team, q);
        this.views.set(a.id, view);
        this.scene.add(view.root);
      }
    }

    this._buildOverlays();
    this._buildComposer();
    this._hookEvents();

    this.time = 0;
    this._lastPositions = new Map();
    this._boardTimer = 0;
    this.stats = { drawCalls: 0, triangles: 0, fps: 60 };
    this._fpsAcc = 0;
    this._fpsFrames = 0;
  }

  // -------------------------------------------------------------------------
  _buildComposer() {
    const q = this.settings.quality;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    if (q >= 1 && this.settings.bloom > 0) {
      this.bloom = new UnrealBloomPass(
        new THREE.Vector2(this.canvas.clientWidth || 1280, this.canvas.clientHeight || 720),
        0.42 * this.settings.bloom, 0.7, 0.86
      );
      this.composer.addPass(this.bloom);
    }

    // Grade: gentle contrast, cool shadows, vignette, faint chromatic edge.
    this.gradePass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uVignette: { value: 0.32 },
        uChroma: { value: q >= 2 ? 0.0016 : 0.0 },
        uContrast: { value: 1.045 },
        uSaturation: { value: 1.06 },
        uLift: { value: new THREE.Color(0x0a1017) },
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float uVignette, uChroma, uContrast, uSaturation;
        uniform vec3 uLift;
        varying vec2 vUv;
        void main() {
          vec2 d = vUv - 0.5;
          vec3 c;
          if (uChroma > 0.0) {
            float r2 = dot(d, d);
            c.r = texture2D(tDiffuse, vUv + d * uChroma * r2 * 4.0).r;
            c.g = texture2D(tDiffuse, vUv).g;
            c.b = texture2D(tDiffuse, vUv - d * uChroma * r2 * 4.0).b;
          } else {
            c = texture2D(tDiffuse, vUv).rgb;
          }
          c = (c - 0.5) * uContrast + 0.5;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c = mix(vec3(l), c, uSaturation);
          c += uLift * (1.0 - l) * 0.35;
          float v = smoothstep(0.92, 0.28, length(d));
          c *= mix(1.0 - uVignette, 1.0, v);
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });
    this.composer.addPass(this.gradePass);

    if (q >= 2) {
      this.composer.addPass(new SMAAPass(
        (this.canvas.clientWidth || 1280) * this.renderer.getPixelRatio(),
        (this.canvas.clientHeight || 720) * this.renderer.getPixelRatio()
      ));
    }
    this.composer.addPass(new OutputPass());
  }

  _buildOverlays() {
    this.overlay = new THREE.Group();
    this.scene.add(this.overlay);

    // Passing-lane overlay (section 28.3): optional, competitive-limited.
    this.laneLines = [];
    for (let i = 0; i < 6; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: 0x7dd3fc, transparent: true, opacity: 0, depthTest: false, toneMapped: false,
      }));
      line.frustumCulled = false;
      line.renderOrder = 950;
      this.overlay.add(line);
      this.laneLines.push(line);
    }

    // Shot-target marker on the goal mouth.
    const t = new THREE.Mesh(
      new THREE.RingGeometry(0.07, 0.12, 20),
      new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0, depthTest: false, toneMapped: false })
    );
    t.renderOrder = 951;
    this.overlay.add(t);
    this.shotTarget = t;
  }

  _hookEvents() {
    const sim = this.sim;
    sim.bus.on('goal', () => { this.rig.addShake(0.85); this.venue.crowdExcitement = 1; });
    sim.bus.on('save', () => { this.rig.addShake(0.3); });
    sim.bus.on('foul', () => { this.venue.crowdExcitement = Math.min(1, this.venue.crowdExcitement + 0.25); });
    sim.bus.on('shot', ({ shooter }) => {
      const hp = shooter.handPoint();
      this.splash.burst(14, { x: hp.x, y: Math.max(0.08, hp.y - 0.35), z: hp.z }, { x: 0, y: 1, z: 0 }, 0.55, 0.8);
    });
  }

  // -------------------------------------------------------------------------
  setQuality(level) {
    this.settings.quality = level;
    this.water.setQuality(level);
    this.splash.setQuality(level);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, level >= 2 ? 2 : 1.25));
    this.renderer.shadowMap.enabled = level >= 2;
  }

  setSetting(key, value) {
    this.settings[key] = value;
    if (key === 'cameraShake') this.rig.shakeEnabled = value;
    if (key === 'reducedMotion') this.rig.reducedMotion = value;
    if (key === 'quality') this.setQuality(value);
    if (key === 'splashDensity') this.splash.density = value;
    if (key === 'bloom' && this.bloom) this.bloom.strength = 0.42 * value;
    if (key === 'highContrastBall') {
      this.ballView.material.emissive = new THREE.Color(value ? 0x442200 : 0x000000);
      this.ballView.material.emissiveIntensity = value ? 1.2 : 0;
      this.ballView.material.needsUpdate = true;
    }
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.water.resize(w, h);
  }

  /** Approximate surface height at a world point, so bodies ride the swell. */
  surfaceHeight(x, z) {
    const { i, j } = this.wake.toTexel(x, z);
    const ii = clamp(Math.round(i), 0, this.wake.res - 1);
    const jj = clamp(Math.round(j), 0, this.wake.res - 1);
    const h = this.wake.height[jj * this.wake.res + ii] * 0.115;
    const swell = Math.sin(x * 0.62 + this.time * 0.75) * 0.010 + Math.sin(z * 0.51 - this.time * 0.62) * 0.012;
    return h + swell;
  }

  // -------------------------------------------------------------------------
  update(dt) {
    this.time += dt;
    const sim = this.sim;

    this._splatSimulation(dt);
    this.wake.update(dt);
    this.water.update(dt, this.time);

    // Pose every athlete from simulation state.
    const ctx = { ball: sim.ball, surfaceHeight: (x, z) => this.surfaceHeight(x, z) };
    for (const [id, view] of this.views) {
      view.update(dt, this.time, ctx);
      if (this.settings.showIndicators) {
        view.setIndicator(
          view.athlete === sim.userAthlete ? 'controlled'
            : view.athlete === sim.secondUserAthlete ? 'switchTarget'
              : (sim.userControlsSide && view.athlete.side === sim.userControlsSide && view.athlete.inPool
                ? (this.settings.quality >= 1 ? 'teammate' : 'none') : 'none')
        );
      } else {
        view.setIndicator(view.athlete === sim.userAthlete ? 'controlled' : 'none');
      }
    }

    this.ballView.update(dt, this.splash);
    this.splash.update(dt);

    // Crowd energy from the actual match situation (section 26.4).
    const tight = 1 - clamp01(Math.abs(sim.score.home - sim.score.away) / 5);
    const late = clamp01(1 - sim.timeRemainingInMatch() / 300);
    const clockPressure = clamp01((8 - sim.shotClock) / 8) * 0.4;
    const excitement = clamp01(0.22 + tight * 0.28 + late * 0.3 + clockPressure + sim.presentation.goalFlash * 0.8);
    this.venue.update(dt, this.time, excitement);

    if (sim.presentation.shake > 0.5) this.rig.addShake(sim.presentation.shake * 0.5);

    this._boardTimer -= dt;
    if (this._boardTimer <= 0) { this.venue.drawScoreboard(sim); this._boardTimer = 0.25; }

    this.rig.update(dt, { ball: sim.ball, userAthlete: sim.userAthlete, sim });
    this._updateOverlays();
  }

  /**
   * Push the simulation into the visual water. This is the one place where the
   * gameplay layer touches the presentation layer's water, and it is one-way.
   */
  _splatSimulation(dt) {
    const sim = this.sim;
    const scale = Math.min(dt * 60, 2);

    for (const a of sim.allActive()) {
      const prev = this._lastPositions.get(a.id);
      const speed = a.speed;
      this._lastPositions.set(a.id, { x: a.pos.x, z: a.pos.z });

      // Body displacement: a floating athlete pushes a persistent dent.
      const bodyRadius = 0.55 + a.elevation * 0.35;
      this.wake.splat(a.pos.x, a.pos.z, bodyRadius, -0.055 * scale, 0.05 * scale);

      // Bow wave and trailing wake: strength from real speed.
      if (speed > 0.25) {
        const hx = Math.sin(a.heading), hz = Math.cos(a.heading);
        const s = clamp01(speed / a.maxSpeed);
        this.wake.splat(a.pos.x + hx * 0.42, a.pos.z + hz * 0.42, 0.42, 0.10 * s * scale, 0.30 * s * scale);
        this.wake.splat(a.pos.x - hx * 0.55, a.pos.z - hz * 0.55, 0.62, -0.05 * s * scale, 0.45 * s * scale);

        // Stroke splash: hands entering the water on each cycle.
        if (s > 0.45 && Math.random() < s * dt * 18 * this.splash.density) {
          const side = Math.random() < 0.5 ? 1 : -1;
          const px = a.pos.x + hx * 0.5 - hz * side * 0.28;
          const pz = a.pos.z + hz * 0.5 + hx * side * 0.28;
          this.splash.burst(Math.round(3 + s * 7), { x: px, y: 0.04, z: pz },
            { x: hx * 0.4, y: 1, z: hz * 0.4 }, 0.28 + s * 0.35, 0.6);
          this.wake.splat(px, pz, 0.24, 0.16 * s, 0.55 * s);
        }
      }

      // Eggbeater churn: strong local turbulence, no forward wake.
      if (a.elevation > 0.05) {
        const e = clamp01(a.elevation / Math.max(0.15, a.maxElevation));
        this.wake.splat(a.pos.x, a.pos.z, 0.5, 0.05 * e * scale, 0.7 * e * scale);
        if (e > 0.6 && Math.random() < e * dt * 16 * this.splash.density) {
          this.splash.burst(Math.round(4 + e * 10), { x: a.pos.x, y: 0.05, z: a.pos.z },
            { x: 0, y: 1, z: 0 }, 0.3 + e * 0.4, 1.1);
        }
      }

      // Contact churn: wrestling at the centre boils the water.
      if (a.contactLoad > 0.15) {
        this.wake.splat(a.pos.x, a.pos.z, 0.65, 0.03 * a.contactLoad * scale, 1.1 * a.contactLoad * scale);
        if (Math.random() < a.contactLoad * dt * 9 * this.splash.density) {
          this.splash.burst(4, { x: a.pos.x, y: 0.05, z: a.pos.z }, { x: 0, y: 1, z: 0 }, 0.32, 1.2);
        }
      }
    }

    // The ball itself.
    const b = this.sim.ball;
    if (b.pos.y < 0.25) this.wake.splat(b.pos.x, b.pos.z, 0.22, -0.02 * scale, 0.16 * scale);
    if (b.eventFlags.skip > 0.1) {
      this.wake.splat(b.pos.x, b.pos.z, 0.4, 0.5, 1.6);
      this.splash.burst(28, { x: b.pos.x, y: 0.05, z: b.pos.z },
        { x: b.vel.x * 0.08, y: 1, z: b.vel.z * 0.08 }, 0.85, 1.4);
      this.splash.ring(b.pos.x, b.pos.z, 0.35, 0.9);
      b.eventFlags.skip = 0;
    }
  }

  _updateOverlays() {
    const sim = this.sim;
    const show = this.settings.showPassLanes && sim.assist.indicators !== 'minimal';
    const carrier = sim.ball.holder;

    if (!show || !carrier || carrier.side !== sim.userControlsSide) {
      for (const l of this.laneLines) l.material.opacity = 0;
    } else {
      const mates = sim.activeAthletes(carrier.side).filter((a) => a !== carrier).slice(0, this.laneLines.length);
      this.laneLines.forEach((line, i) => {
        const m = mates[i];
        if (!m) { line.material.opacity = 0; return; }
        const p = line.geometry.attributes.position.array;
        p[0] = carrier.pos.x; p[1] = 0.12; p[2] = carrier.pos.z;
        p[3] = m.pos.x; p[4] = 0.12; p[5] = m.pos.z;
        line.geometry.attributes.position.needsUpdate = true;
        line.material.opacity = 0.35;
      });
    }

    // Shot target marker while charging a shot.
    const s = sim.userAthlete;
    if (this.settings.showShotQuality && s && s.charging === 'shot' && sim.lastAim) {
      const f = sim.profile.field;
      this.shotTarget.position.set(
        sim.lastAim.x * (f.goalWidth / 2 - 0.15),
        sim.lastAim.y * (f.goalHeight - 0.12) + 0.06,
        s.attackDir * (f.length / 2 - 0.02)
      );
      this.shotTarget.material.opacity = 0.85;
    } else {
      this.shotTarget.material.opacity = 0;
    }
  }

  render() {
    // Water needs the scene rendered from two extra viewpoints first.
    this.water.renderTargets(this.renderer, this.scene, this.camera);
    this.composer.render();

    const info = this.renderer.info;
    this.stats.drawCalls = info.render.calls;
    this.stats.triangles = info.render.triangles;
  }

  dispose() {
    this.water.dispose();
    for (const v of this.views.values()) v.dispose();
    this.composer.dispose?.();
    this.renderer.dispose();
  }
}
