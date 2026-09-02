/**
 * The water surface (Design Bible section 25.2).
 *
 * A physically motivated surface shader combining:
 *   - a calm competition-pool base swell (a few centimetres, not an ocean)
 *   - the dynamic wake field splatted from the actual simulation
 *   - screen-space refraction with per-channel dispersion and Beer-Lambert
 *     absorption driven by real water depth from the scene depth buffer
 *   - a true planar reflection pass
 *   - Schlick fresnel blending the two
 *   - specular highlights that feed the bloom pass
 *   - foam generated from wake turbulence, athlete contact and the pool walls
 *
 * Gameplay never reads this file. Visual water and gameplay water are separated
 * exactly as section 10.5 requires.
 */

import * as THREE from 'three';

export class WaterSurface {
  /**
   * @param {object} opts { width, length, wakeField, renderer, venueTint }
   */
  constructor(opts) {
    const { width, length, wakeField } = opts;
    this.wake = wakeField;

    // Reflection and refraction targets. Reflection at half resolution: the
    // surface is rough enough that the difference is invisible and it buys frames.
    const pr = Math.min(window.devicePixelRatio ?? 1, 2);
    const w = Math.floor((opts.renderWidth ?? 1280) * pr);
    const h = Math.floor((opts.renderHeight ?? 720) * pr);

    this.reflectionTarget = new THREE.WebGLRenderTarget(Math.floor(w * 0.5), Math.floor(h * 0.5), {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace,
    });

    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.UnsignedIntType;
    this.refractionTarget = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType, depthTexture,
      colorSpace: THREE.LinearSRGBColorSpace,
    });

    this.reflectionCamera = new THREE.PerspectiveCamera();

    const segments = 220;
    const geometry = new THREE.PlaneGeometry(width + 6, length + 6, segments, segments);
    geometry.rotateX(-Math.PI / 2);

    this.uniforms = {
      uTime: { value: 0 },
      uWake: { value: this.wake.texture },
      uWakeTexel: { value: new THREE.Vector2(1 / this.wake.res, 1 / this.wake.res) },
      uWakeSize: { value: new THREE.Vector2(this.wake.width, this.wake.length) },
      uReflection: { value: this.reflectionTarget.texture },
      uRefraction: { value: this.refractionTarget.texture },
      uDepth: { value: depthTexture },
      uReflectionMatrix: { value: new THREE.Matrix4() },
      uResolution: { value: new THREE.Vector2(w, h) },
      uCameraNear: { value: 0.1 },
      uCameraFar: { value: 200 },
      uSunDirection: { value: new THREE.Vector3(0.35, 0.8, 0.4).normalize() },
      uSunColor: { value: new THREE.Color(0xfff4e2) },
      uWaterColor: { value: new THREE.Color(0x0a4f6e) },
      uDeepColor: { value: new THREE.Color(0x03222f) },
      uFoamColor: { value: new THREE.Color(0xe8f6ff) },
      uPoolHalf: { value: new THREE.Vector2(width / 2, length / 2) },
      uSwell: { value: 1.0 },
      uSplashQuality: { value: 1.0 },
      uWindDir: { value: new THREE.Vector2(0.7, 0.7) },
      uGlare: { value: 1.0 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: false,
      side: THREE.FrontSide,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.position.y = 0;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'waterSurface';
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  setQuality(level) {
    // level: 0 low, 1 medium, 2 high, 3 ultra
    this.uniforms.uSplashQuality.value = [0.4, 0.7, 1.0, 1.25][level] ?? 1;
    this.material.defines = { ...(this.material.defines ?? {}), QUALITY: level };
    this.material.needsUpdate = true;
  }

  setVenue({ waterColor, deepColor, glare = 1 }) {
    if (waterColor) this.uniforms.uWaterColor.value.set(waterColor);
    if (deepColor) this.uniforms.uDeepColor.value.set(deepColor);
    this.uniforms.uGlare.value = glare;
  }

  resize(width, height) {
    const pr = Math.min(window.devicePixelRatio ?? 1, 2);
    const w = Math.floor(width * pr);
    const h = Math.floor(height * pr);
    this.refractionTarget.setSize(w, h);
    this.reflectionTarget.setSize(Math.floor(w * 0.5), Math.floor(h * 0.5));
    this.uniforms.uResolution.value.set(w, h);
  }

  /**
   * Render the reflection and refraction passes. Called by the scene each frame
   * with the water temporarily hidden.
   */
  renderTargets(renderer, scene, camera) {
    const visible = this.mesh.visible;
    this.mesh.visible = false;
    const oldTarget = renderer.getRenderTarget();

    // --- Refraction: what is behind the surface, from the real camera --------
    renderer.setRenderTarget(this.refractionTarget);
    renderer.clear();
    renderer.render(scene, camera);

    // --- Reflection: mirror the camera about the y = 0 plane -----------------
    const rc = this.reflectionCamera;
    rc.copy(camera);
    rc.position.set(camera.position.x, -camera.position.y, camera.position.z);
    rc.up.set(0, -1, 0);
    const target = new THREE.Vector3();
    camera.getWorldDirection(target);
    target.multiplyScalar(10).add(camera.position);
    target.y = -target.y;
    rc.lookAt(target);
    rc.up.set(0, 1, 0);
    rc.updateMatrixWorld();
    rc.updateProjectionMatrix();

    // Oblique near-plane clip so nothing below the surface bleeds into the mirror.
    clipToPlane(rc, new THREE.Vector4(0, 1, 0, 0.02));

    renderer.setRenderTarget(this.reflectionTarget);
    renderer.clear();
    renderer.render(scene, rc);

    renderer.setRenderTarget(oldTarget);
    this.mesh.visible = visible;

    // Texture-space matrix for projecting the reflection.
    const m = this.uniforms.uReflectionMatrix.value;
    m.set(
      0.5, 0, 0, 0.5,
      0, 0.5, 0, 0.5,
      0, 0, 0.5, 0.5,
      0, 0, 0, 1
    );
    m.multiply(rc.projectionMatrix);
    m.multiply(rc.matrixWorldInverse);

    this.uniforms.uCameraNear.value = camera.near;
    this.uniforms.uCameraFar.value = camera.far;
  }

  update(dt, time) {
    this.uniforms.uTime.value = time;
  }

  dispose() {
    this.reflectionTarget.dispose();
    this.refractionTarget.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

/** Modify the projection matrix so the near plane becomes an arbitrary plane. */
function clipToPlane(camera, plane) {
  const p = plane.clone();
  const projection = camera.projectionMatrix;
  const q = new THREE.Vector4(
    (Math.sign(p.x) + projection.elements[8]) / projection.elements[0],
    (Math.sign(p.y) + projection.elements[9]) / projection.elements[5],
    -1.0,
    (1.0 + projection.elements[10]) / projection.elements[14]
  );
  const clipPlane = p.multiplyScalar(2.0 / p.dot(q));
  projection.elements[2] = clipPlane.x;
  projection.elements[6] = clipPlane.y;
  projection.elements[10] = clipPlane.z + 1.0;
  projection.elements[14] = clipPlane.w;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const NOISE = /* glsl */`
  vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
  }
  float noise(vec2 p) {
    const float K1 = 0.366025404;
    const float K2 = 0.211324865;
    vec2 i = floor(p + (p.x + p.y) * K1);
    vec2 a = p - i + (i.x + i.y) * K2;
    float m = step(a.y, a.x);
    vec2 o = vec2(m, 1.0 - m);
    vec2 b = a - o + K2;
    vec2 c = a - 1.0 + 2.0 * K2;
    vec3 h = max(0.5 - vec3(dot(a, a), dot(b, b), dot(c, c)), 0.0);
    vec3 n = h * h * h * h * vec3(dot(a, hash2(i)), dot(b, hash2(i + o)), dot(c, hash2(i + 1.0)));
    return dot(n, vec3(70.0));
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 5; i++) { v += a * noise(p); p = rot * p * 2.02; a *= 0.5; }
    return v;
  }
`;

const VERT = /* glsl */`
  precision highp float;

  uniform float uTime;
  uniform sampler2D uWake;
  uniform vec2 uWakeSize;
  uniform float uSwell;

  varying vec3 vWorldPos;
  varying vec2 vWakeUv;
  varying float vWakeH;
  varying float vEnergy;
  varying vec4 vScreenPos;

  ${NOISE}

  // Base pool swell: small, layered, slow. A competition pool is not the sea.
  float baseWave(vec2 p, float t) {
    float h = 0.0;
    h += sin(p.x * 0.62 + t * 0.75) * 0.010;
    h += sin(p.y * 0.51 - t * 0.62) * 0.012;
    h += sin((p.x * 0.31 + p.y * 0.44) + t * 1.05) * 0.007;
    h += fbm(p * 0.75 + vec2(t * 0.09, -t * 0.07)) * 0.012;
    return h;
  }

  void main() {
    vec3 pos = position;
    vec3 world = (modelMatrix * vec4(pos, 1.0)).xyz;

    vec2 wuv = vec2(world.x / uWakeSize.x + 0.5, world.z / uWakeSize.y + 0.5);
    vWakeUv = wuv;
    vec4 wake = texture2D(uWake, wuv);
    vWakeH = wake.r;
    vEnergy = wake.g;

    float h = baseWave(world.xz, uTime) * uSwell + wake.r * 0.115;
    pos.y += h;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    vScreenPos = projectionMatrix * mv;
    vWorldPos = (modelMatrix * vec4(pos, 1.0)).xyz;
    gl_Position = vScreenPos;
  }
`;

const FRAG = /* glsl */`
  precision highp float;

  uniform float uTime;
  uniform sampler2D uWake;
  uniform vec2 uWakeTexel;
  uniform sampler2D uReflection;
  uniform sampler2D uRefraction;
  uniform sampler2D uDepth;
  uniform vec2 uWakeSize;
  uniform vec2 uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uWaterColor;
  uniform vec3 uDeepColor;
  uniform vec3 uFoamColor;
  uniform vec2 uPoolHalf;
  uniform float uSplashQuality;
  uniform float uGlare;
  uniform mat4 uReflectionMatrix;

  varying vec3 vWorldPos;
  varying vec2 vWakeUv;
  varying float vWakeH;
  varying float vEnergy;
  varying vec4 vScreenPos;

  ${NOISE}

  float linearDepth(float d) {
    float z = d * 2.0 - 1.0;
    return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear));
  }

  // Analytic-ish normal: base ripple detail plus the gradient of the wake field.
  vec3 surfaceNormal(vec2 p, float t) {
    float e = 0.055;
    vec2 d1 = vec2(t * 0.11, t * 0.07);
    vec2 d2 = vec2(-t * 0.08, t * 0.13);

    float s = 0.0;
    s += fbm(p * 1.9 + d1) * 0.010;
    s += fbm(p * 4.3 - d2) * 0.0045;
    s += fbm(p * 9.1 + d1 * 1.7) * 0.0022 * uSplashQuality;

    float sx = 0.0, sz = 0.0;
    {
      vec2 px = p + vec2(e, 0.0);
      float a = fbm(px * 1.9 + d1) * 0.010 + fbm(px * 4.3 - d2) * 0.0045 + fbm(px * 9.1 + d1 * 1.7) * 0.0022 * uSplashQuality;
      sx = (a - s) / e;
      vec2 pz = p + vec2(0.0, e);
      float b = fbm(pz * 1.9 + d1) * 0.010 + fbm(pz * 4.3 - d2) * 0.0045 + fbm(pz * 9.1 + d1 * 1.7) * 0.0022 * uSplashQuality;
      sz = (b - s) / e;
    }

    // Wake field gradient by central difference in texture space.
    vec2 texel = uWakeTexel;
    float wl = texture2D(uWake, vWakeUv - vec2(texel.x, 0.0)).r;
    float wr = texture2D(uWake, vWakeUv + vec2(texel.x, 0.0)).r;
    float wd = texture2D(uWake, vWakeUv - vec2(0.0, texel.y)).r;
    float wu = texture2D(uWake, vWakeUv + vec2(0.0, texel.y)).r;
    float scale = 0.115 / (uWakeSize.x * texel.x * 2.0);
    vec2 wakeGrad = vec2(wr - wl, wu - wd) * scale;

    return normalize(vec3(-(sx + wakeGrad.x), 1.0, -(sz + wakeGrad.y)));
  }

  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    vec3 N = surfaceNormal(vWorldPos.xz, uTime);

    vec2 screenUv = (vScreenPos.xy / vScreenPos.w) * 0.5 + 0.5;

    // --- Depth of water behind this fragment -------------------------------
    float sceneZ = linearDepth(texture2D(uDepth, screenUv).x);
    float fragZ = linearDepth(gl_FragCoord.z);
    float thickness = max(sceneZ - fragZ, 0.0);

    // --- Refraction with per-channel dispersion ----------------------------
    float distortStrength = clamp(thickness * 0.22, 0.0, 1.0) * 0.055;
    vec2 distort = N.xz * distortStrength;
    vec2 uvR = clamp(screenUv + distort * 1.06, 0.001, 0.999);
    vec2 uvG = clamp(screenUv + distort * 1.00, 0.001, 0.999);
    vec2 uvB = clamp(screenUv + distort * 0.94, 0.001, 0.999);
    vec3 refr = vec3(
      texture2D(uRefraction, uvR).r,
      texture2D(uRefraction, uvG).g,
      texture2D(uRefraction, uvB).b
    );

    // Re-read depth at the distorted position so foreground objects that stick
    // out of the water are not smeared by the refraction offset.
    float distortedZ = linearDepth(texture2D(uDepth, uvG).x);
    if (distortedZ < fragZ) { refr = texture2D(uRefraction, screenUv).rgb; thickness = max(sceneZ - fragZ, 0.0); }

    // --- Beer-Lambert absorption -------------------------------------------
    vec3 absorb = exp(-thickness * vec3(0.62, 0.24, 0.15) * 1.15);
    vec3 underwater = mix(uDeepColor, refr * mix(uWaterColor * 2.4, vec3(1.0), absorb), absorb * 0.85 + 0.15);
    underwater = mix(uDeepColor, underwater, clamp(absorb.g * 1.6, 0.0, 1.0));

    // --- Reflection ---------------------------------------------------------
    vec4 rp = uReflectionMatrix * vec4(vWorldPos, 1.0);
    vec2 reflUv = rp.xy / max(rp.w, 0.0001);
    reflUv += N.xz * 0.045;
    vec3 refl = texture2D(uReflection, clamp(reflUv, 0.002, 0.998)).rgb;

    // --- Fresnel ------------------------------------------------------------
    float cosTheta = clamp(dot(viewDir, N), 0.0, 1.0);
    float F0 = 0.02;
    float fresnel = F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
    fresnel = clamp(fresnel * 1.25, 0.0, 1.0);

    vec3 color = mix(underwater, refl, fresnel);

    // --- Specular highlight (feeds the bloom pass) --------------------------
    vec3 H = normalize(uSunDirection + viewDir);
    float spec = pow(max(dot(N, H), 0.0), 340.0) * 3.4 * uGlare;
    float wideSpec = pow(max(dot(N, H), 0.0), 26.0) * 0.16 * uGlare;
    color += uSunColor * (spec + wideSpec);

    // Sparkle: high frequency glints on the moving surface.
    float glint = pow(max(0.0, fbm(vWorldPos.xz * 11.0 + uTime * 0.9)), 6.0) * 2.2;
    color += uSunColor * glint * fresnel * 0.55 * uGlare;

    // --- Foam ---------------------------------------------------------------
    float turb = clamp(vEnergy * 1.05, 0.0, 1.6);
    float crest = clamp(abs(vWakeH) * 3.1, 0.0, 1.0);
    float foamNoise = fbm(vWorldPos.xz * 5.5 - uTime * 0.55) * 0.5 + 0.5;
    float foamNoise2 = fbm(vWorldPos.xz * 13.0 + uTime * 0.9) * 0.5 + 0.5;
    float foam = smoothstep(0.30, 0.95, turb * (0.55 + 0.75 * foamNoise)) * 0.85
               + smoothstep(0.55, 1.0, crest * foamNoise2) * 0.35;

    // Wall foam: water always breaks white against the pool edge.
    vec2 edge = uPoolHalf - abs(vWorldPos.xz);
    float wall = 1.0 - smoothstep(0.0, 0.55, min(edge.x, edge.y));
    foam += wall * (0.30 + 0.35 * foamNoise2);

    foam = clamp(foam, 0.0, 1.0);
    color = mix(color, uFoamColor * (0.82 + 0.35 * foamNoise), foam * 0.88);

    // Slight darkening in troughs gives the surface readable relief.
    color *= 1.0 + clamp(vWakeH, -0.4, 0.4) * 0.22;

    gl_FragColor = vec4(color, 1.0);
  }
`;
