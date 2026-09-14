/**
 * Venue construction (Design Bible sections 25.3 and 26).
 *
 * Builds the pool basin, the regulation field markings, the lane ropes with their
 * correct colour bands, the goals with simulated nets, the deck, the stands and
 * crowd, the lighting rig and the venue-specific atmosphere. Every venue is an
 * invented location - no real arena, sponsor or federation branding appears.
 *
 * The pool floor carries an animated caustics shader driven by the same wake
 * field the surface uses, so the light patterns move when athletes move.
 */

import * as THREE from 'three';

export const VENUES = {
  'meridian-arena': {
    name: 'Meridian Aquatic Arena',
    city: 'Meridian Bay',
    type: 'indoor',
    capacity: 5200,
    water: { color: 0x0d5b7d, deep: 0x03202d, glare: 1.0 },
    ambient: { sky: 0x1a2733, ground: 0x0a1016, intensity: 0.55 },
    key: { color: 0xfff2dd, intensity: 3.1 },
    fog: { color: 0x050b12, density: 0.010 },
    deck: 0x1b2a35, tile: 0x9fd8e8, accent: 0x0ea5e9,
    crowdDensity: 0.92, standRows: 15, shafts: true,
  },
  'north-basin': {
    name: 'North Basin Hall',
    city: 'Vallhaven',
    type: 'indoor',
    capacity: 3400,
    water: { color: 0x0a4f6e, deep: 0x021a26, glare: 0.85 },
    ambient: { sky: 0x16202b, ground: 0x080d12, intensity: 0.48 },
    key: { color: 0xe8f2ff, intensity: 2.8 },
    fog: { color: 0x040910, density: 0.013 },
    deck: 0x243342, tile: 0x8fc9dc, accent: 0x14532d,
    crowdDensity: 0.86, standRows: 12, shafts: true,
  },
  'solaris-lido': {
    name: 'Solaris Lido',
    city: 'Porto Solaris',
    type: 'outdoor',
    capacity: 2600,
    water: { color: 0x0fa3c4, deep: 0x05485c, glare: 1.6 },
    ambient: { sky: 0x87ceeb, ground: 0x5d6b52, intensity: 1.15 },
    key: { color: 0xfff0d0, intensity: 3.8 },
    fog: { color: 0xa9c9dd, density: 0.0035 },
    deck: 0xd8cbb2, tile: 0xbfe9f2, accent: 0xf97316,
    crowdDensity: 0.7, standRows: 9, shafts: false,
  },
  'harbourgate-baths': {
    name: 'Harbourgate Baths',
    city: 'Harbourgate',
    type: 'indoor',
    capacity: 1400,
    water: { color: 0x0b4a63, deep: 0x02171f, glare: 0.7 },
    ambient: { sky: 0x2a2620, ground: 0x0d0b09, intensity: 0.42 },
    key: { color: 0xffe4b5, intensity: 2.4 },
    fog: { color: 0x0a0906, density: 0.018 },
    deck: 0x3b3228, tile: 0x86b7c4, accent: 0xdc2626,
    crowdDensity: 0.98, standRows: 8, shafts: true,
  },
};

export class Venue {
  constructor(scene, profile, venueKey, homeTeam, awayTeam) {
    this.scene = scene;
    this.profile = profile;
    this.def = VENUES[venueKey] ?? VENUES['meridian-arena'];
    this.root = new THREE.Group();
    this.root.name = 'venue';
    scene.add(this.root);

    this.homeTeam = homeTeam;
    this.awayTeam = awayTeam;
    this.crowdTime = 0;
    this.crowdExcitement = 0.3;

    this._buildBasin();
    this._buildMarkings();
    this._buildLaneRopes();
    this._buildGoals();
    this._buildDeck();
    this._buildStands();
    this._buildLighting();
    this._buildScoreboard();
  }

  get field() { return this.profile.field; }

  // -------------------------------------------------------------------------
  _buildBasin() {
    const f = this.field;
    const W = f.width + 2.4;
    const L = f.length + 2.4;
    const D = 2.6;
    const d = this.def;

    // Pool floor with caustics.
    const floorGeo = new THREE.PlaneGeometry(W, L, 1, 1);
    floorGeo.rotateX(-Math.PI / 2);
    this.floorMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uTile: { value: new THREE.Color(d.tile) },
        uLine: { value: new THREE.Color(0x0d3550) },
        uAccent: { value: new THREE.Color(d.accent) },
        uWake: { value: null },
        uWakeSize: { value: new THREE.Vector2(1, 1) },
        uHalf: { value: new THREE.Vector2(W / 2, L / 2) },
        uCausticStrength: { value: 1.0 },
        uFieldHalf: { value: new THREE.Vector2(f.width / 2, f.length / 2) },
      },
      vertexShader: FLOOR_VERT,
      fragmentShader: FLOOR_FRAG,
    });
    const floor = new THREE.Mesh(floorGeo, this.floorMaterial);
    floor.position.y = -D;
    floor.receiveShadow = false;
    this.root.add(floor);
    this.floor = floor;

    // Basin walls: tiled, lit from above, visible through the refraction pass.
    const wallMat = new THREE.MeshStandardMaterial({
      color: d.tile, roughness: 0.35, metalness: 0.0,
      side: THREE.BackSide,
    });
    const wallGeo = new THREE.BoxGeometry(W, D * 2, L);
    const walls = new THREE.Mesh(wallGeo, wallMat);
    walls.position.y = -D + D; // box centred so its lower half forms the basin
    walls.position.y = 0;
    this.root.add(walls);
    this.basinWalls = walls;

    // Gutter lip around the waterline.
    const lipMat = new THREE.MeshStandardMaterial({ color: 0xf2f5f7, roughness: 0.55 });
    const lip = new THREE.Mesh(new THREE.BoxGeometry(W + 0.5, 0.12, L + 0.5), lipMat);
    lip.position.y = 0.06;
    this.root.add(lip);
    const inner = new THREE.Mesh(new THREE.BoxGeometry(W, 0.3, L), new THREE.MeshBasicMaterial({ colorWrite: false }));
    inner.position.y = 0.06;
    inner.renderOrder = -1;
    this.root.add(inner);
  }

  _buildMarkings() {
    // Field markings live on the pool floor shader; nothing extra needed here,
    // but the half-distance and goal lines get a subtle floating marker so they
    // stay readable from the broadcast camera (section 24.1).
    const f = this.field;
    const g = new THREE.Group();
    this.root.add(g);
    this.markings = g;
  }

  _buildLaneRopes() {
    // Regulation field-of-play markers: red from the goal line to two metres,
    // yellow to five metres, green to the half-distance line.
    const f = this.field;
    const half = f.length / 2;
    const bands = [
      { from: 0, to: f.restrictedLine, color: 0xd21b2c },
      { from: f.restrictedLine, to: f.penaltyLine, color: 0xf1c40f },
      { from: f.penaltyLine, to: half, color: 0x27ae60 },
    ];

    const group = new THREE.Group();
    for (const sideX of [-1, 1]) {
      for (const endSign of [-1, 1]) {
        for (const band of bands) {
          const len = band.to - band.from;
          const geo = new THREE.CylinderGeometry(0.055, 0.055, len, 8, 1);
          geo.rotateX(Math.PI / 2);
          const mat = new THREE.MeshStandardMaterial({
            color: band.color, roughness: 0.6, emissive: band.color, emissiveIntensity: 0.12,
          });
          const m = new THREE.Mesh(geo, mat);
          m.position.set(sideX * (f.width / 2 + 0.16), 0.02, endSign * (half - band.from - len / 2));
          group.add(m);
        }
      }
      // Half-distance marker.
      const geo = new THREE.SphereGeometry(0.09, 10, 8);
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }));
      m.position.set(sideX * (f.width / 2 + 0.16), 0.03, 0);
      group.add(m);
    }
    this.root.add(group);
    this.laneRopes = group;
  }

  _buildGoals() {
    const f = this.field;
    this.goals = [];
    for (const sign of [-1, 1]) {
      const goal = new THREE.Group();
      const halfW = f.goalWidth / 2;
      const barMat = new THREE.MeshStandardMaterial({ color: 0xf5f7fa, roughness: 0.32, metalness: 0.15 });

      const postGeo = new THREE.CylinderGeometry(0.05, 0.05, f.goalHeight + 0.55, 14);
      for (const px of [-halfW, halfW]) {
        const post = new THREE.Mesh(postGeo, barMat);
        post.position.set(px, f.goalHeight / 2 - 0.27, sign * f.length / 2);
        post.castShadow = true;
        goal.add(post);
      }
      const barGeo = new THREE.CylinderGeometry(0.05, 0.05, f.goalWidth, 14);
      barGeo.rotateZ(Math.PI / 2);
      const bar = new THREE.Mesh(barGeo, barMat);
      bar.position.set(0, f.goalHeight, sign * f.length / 2);
      bar.castShadow = true;
      goal.add(bar);

      // Frame going back, plus the net.
      const depth = 1.0;
      for (const px of [-halfW, halfW]) {
        const stay = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, depth, 8), barMat);
        stay.rotation.x = Math.PI / 2;
        stay.position.set(px, f.goalHeight, sign * (f.length / 2 + depth / 2));
        goal.add(stay);
      }

      const net = buildNet(f.goalWidth, f.goalHeight + 0.5, depth, sign);
      net.position.set(0, 0, sign * f.length / 2);
      goal.add(net);
      goal.userData.net = net;

      // Floating goal frame base, as used on deep pools.
      const floatMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ec, roughness: 0.6 });
      for (const px of [-halfW - 0.14, halfW + 0.14]) {
        const f1 = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 1.2), floatMat);
        f1.position.set(px, -0.02, sign * (f.length / 2 + 0.4));
        goal.add(f1);
      }

      this.root.add(goal);
      this.goals.push(goal);
    }
  }

  _buildDeck() {
    const f = this.field;
    const d = this.def;
    const W = f.width + 2.4, L = f.length + 2.4;
    const deckMat = new THREE.MeshStandardMaterial({ color: d.deck, roughness: 0.9, metalness: 0.0 });

    const outerW = W + 16, outerL = L + 18;
    const shape = new THREE.Shape();
    shape.moveTo(-outerW / 2, -outerL / 2);
    shape.lineTo(outerW / 2, -outerL / 2);
    shape.lineTo(outerW / 2, outerL / 2);
    shape.lineTo(-outerW / 2, outerL / 2);
    shape.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-W / 2 - 0.25, -L / 2 - 0.25);
    hole.lineTo(-W / 2 - 0.25, L / 2 + 0.25);
    hole.lineTo(W / 2 + 0.25, L / 2 + 0.25);
    hole.lineTo(W / 2 + 0.25, -L / 2 - 0.25);
    hole.closePath();
    shape.holes.push(hole);

    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    const deck = new THREE.Mesh(geo, deckMat);
    deck.position.y = 0.12;
    deck.receiveShadow = true;
    this.root.add(deck);

    // Benches, officials' table and equipment on the near deck.
    const benchMat = new THREE.MeshStandardMaterial({ color: 0x2c3a47, roughness: 0.7 });
    for (const sgn of [-1, 1]) {
      const bench = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.45, 0.6), benchMat);
      bench.position.set(sgn * 5.5, 0.34, -(L / 2 + 1.6));
      bench.castShadow = true;
      this.root.add(bench);
      // Seated substitutes, abstract but present.
      for (let i = 0; i < 7; i++) {
        const team = sgn > 0 ? this.homeTeam : this.awayTeam;
        const p = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.16, 0.42, 4, 8),
          new THREE.MeshStandardMaterial({ color: new THREE.Color(team.colors.primary).multiplyScalar(0.7), roughness: 0.8 })
        );
        p.position.set(sgn * 5.5 - 2.2 + i * 0.72, 0.75, -(L / 2 + 1.75));
        p.castShadow = true;
        this.root.add(p);
      }
    }

    const table = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.5, 0.9), new THREE.MeshStandardMaterial({ color: 0x111a22, roughness: 0.5 }));
    table.position.set(0, 0.37, -(L / 2 + 2.4));
    this.root.add(table);
  }

  _buildStands() {
    const f = this.field;
    const d = this.def;
    const W = f.width + 2.4, L = f.length + 2.4;
    const rows = d.standRows;
    const group = new THREE.Group();

    const stepMat = new THREE.MeshStandardMaterial({ color: 0x121a22, roughness: 0.95 });

    // Two long-side stands plus one behind each goal.
    const configs = [
      { axis: 'x', sign: 1, length: L + 14, offset: W / 2 + 8.4 },
      { axis: 'x', sign: -1, length: L + 14, offset: W / 2 + 8.4 },
      { axis: 'z', sign: 1, length: W + 12, offset: L / 2 + 9.2 },
      { axis: 'z', sign: -1, length: W + 12, offset: L / 2 + 9.2 },
    ];

    const crowdColors = [
      new THREE.Color(this.homeTeam.colors.primary),
      new THREE.Color(this.homeTeam.colors.secondary),
      new THREE.Color(this.awayTeam.colors.primary),
      new THREE.Color(0x2b3440), new THREE.Color(0x4a5461), new THREE.Color(0x8b939c),
      new THREE.Color(0xd9c9a3), new THREE.Color(0x6b4f3a),
    ];

    const crowdGeo = new THREE.CapsuleGeometry(0.17, 0.34, 3, 6);
    const crowdMat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
    const perStand = Math.floor(rows * 26 * d.crowdDensity);
    const total = perStand * configs.length;
    const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, total);
    crowd.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3);
    crowd.castShadow = false;
    crowd.frustumCulled = false;

    const dummy = new THREE.Object3D();
    let n = 0;
    this.crowdBase = new Float32Array(total * 3);
    this.crowdPhase = new Float32Array(total);

    for (const cfg of configs) {
      for (let r = 0; r < rows; r++) {
        const rise = 0.55 + r * 0.42;
        const back = r * 0.78;
        // Concrete step.
        const step = new THREE.Mesh(
          cfg.axis === 'x'
            ? new THREE.BoxGeometry(0.78, 0.42, cfg.length)
            : new THREE.BoxGeometry(cfg.length, 0.42, 0.78),
          stepMat
        );
        if (cfg.axis === 'x') step.position.set(cfg.sign * (cfg.offset + back), rise - 0.21, 0);
        else step.position.set(0, rise - 0.21, cfg.sign * (cfg.offset + back));
        group.add(step);

        // Spectators on this row.
        const count = Math.floor(cfg.length / 0.62 * d.crowdDensity);
        for (let i = 0; i < count && n < total; i++) {
          const t = (i / Math.max(1, count - 1) - 0.5) * cfg.length * 0.94;
          let x, z;
          if (cfg.axis === 'x') { x = cfg.sign * (cfg.offset + back); z = t; }
          else { x = t; z = cfg.sign * (cfg.offset + back); }
          const y = rise + 0.34;
          dummy.position.set(x, y, z);
          dummy.rotation.set(0, cfg.axis === 'x' ? (cfg.sign > 0 ? -Math.PI / 2 : Math.PI / 2) : (cfg.sign > 0 ? Math.PI : 0), 0);
          dummy.scale.setScalar(0.9 + Math.random() * 0.25);
          dummy.updateMatrix();
          crowd.setMatrixAt(n, dummy.matrix);
          // Home end wears home colours.
          const nearHome = cfg.axis === 'z' ? cfg.sign < 0 : z < 0;
          const pool = nearHome ? crowdColors.slice(0, 2).concat(crowdColors.slice(3))
                                : crowdColors.slice(2);
          const c = pool[Math.floor(Math.random() * pool.length)];
          crowd.setColorAt(n, c);
          this.crowdBase[n * 3] = x;
          this.crowdBase[n * 3 + 1] = y;
          this.crowdBase[n * 3 + 2] = z;
          this.crowdPhase[n] = Math.random() * Math.PI * 2;
          n++;
        }
      }
    }
    crowd.count = n;
    crowd.instanceMatrix.needsUpdate = true;
    if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
    group.add(crowd);
    this.crowd = crowd;
    this.crowdCount = n;
    this._crowdDummy = dummy;

    // Back wall / roof to close the room and give the lights something to bounce off.
    if (this.def.type === 'indoor') {
      const wallMat = new THREE.MeshStandardMaterial({ color: 0x0a1119, roughness: 1, side: THREE.BackSide });
      const room = new THREE.Mesh(new THREE.BoxGeometry(W + 44, 24, L + 46), wallMat);
      room.position.y = 9;
      group.add(room);
    } else {
      const sky = new THREE.Mesh(
        new THREE.SphereGeometry(140, 32, 20),
        new THREE.MeshBasicMaterial({ color: 0x7fb6dd, side: THREE.BackSide })
      );
      group.add(sky);
    }

    this.root.add(group);
    this.stands = group;
  }

  _buildLighting() {
    const d = this.def;
    const f = this.field;

    const hemi = new THREE.HemisphereLight(d.ambient.sky, d.ambient.ground, d.ambient.intensity);
    this.scene.add(hemi);
    this.hemi = hemi;

    this.keyLights = [];
    const rigPositions = d.type === 'outdoor'
      ? [[0, 26, 0]]
      : [[-7, 13, -8], [7, 13, -8], [-7, 13, 8], [7, 13, 8]];

    rigPositions.forEach((p, i) => {
      const light = new THREE.SpotLight(d.key.color, d.key.intensity * (d.type === 'outdoor' ? 3 : 1), 0, Math.PI / 4.2, 0.45, 1.1);
      light.position.set(p[0], p[1], p[2]);
      light.target.position.set(p[0] * 0.25, 0, p[2] * 0.25);
      light.castShadow = i === 0;
      if (light.castShadow) {
        light.shadow.mapSize.set(2048, 2048);
        light.shadow.camera.near = 2;
        light.shadow.camera.far = 45;
        light.shadow.bias = -0.0008;
      }
      this.scene.add(light);
      this.scene.add(light.target);
      this.keyLights.push(light);

      if (d.type === 'indoor') {
        // Visible fixture plus a soft shaft so the rig reads on camera.
        const housing = new THREE.Mesh(
          new THREE.BoxGeometry(3.2, 0.35, 1.4),
          new THREE.MeshStandardMaterial({ color: 0x0b1016, roughness: 0.8 })
        );
        housing.position.set(p[0], p[1] + 0.4, p[2]);
        this.root.add(housing);

        const lamp = new THREE.Mesh(
          new THREE.PlaneGeometry(3.0, 1.2),
          new THREE.MeshBasicMaterial({ color: d.key.color, toneMapped: false })
        );
        lamp.rotation.x = -Math.PI / 2;
        lamp.position.set(p[0], p[1] + 0.19, p[2]);
        this.root.add(lamp);

        if (d.shafts) {
          const shaft = new THREE.Mesh(
            new THREE.ConeGeometry(6.5, p[1], 24, 1, true),
            new THREE.ShaderMaterial({
              transparent: true, depthWrite: false, side: THREE.DoubleSide,
              blending: THREE.AdditiveBlending,
              uniforms: { uColor: { value: new THREE.Color(d.key.color) }, uIntensity: { value: 0.055 } },
              vertexShader: `varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
              fragmentShader: `uniform vec3 uColor; uniform float uIntensity; varying float vY;
                void main(){ float t = clamp((vY + 0.5) , 0.0, 1.0); gl_FragColor = vec4(uColor, uIntensity * pow(t, 1.6)); }`,
            })
          );
          shaft.position.set(p[0], p[1] / 2, p[2]);
          this.root.add(shaft);
        }
      }
    });

    if (d.type === 'outdoor') {
      const sun = new THREE.DirectionalLight(0xfff0d0, 2.6);
      sun.position.set(18, 30, -12);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      const s = 30;
      sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
      sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
      sun.shadow.camera.far = 90;
      this.scene.add(sun);
      this.sun = sun;
    }

    this.scene.fog = new THREE.FogExp2(d.fog.color, d.fog.density);
  }

  _buildScoreboard() {
    const f = this.field;
    this.boardCanvas = document.createElement('canvas');
    this.boardCanvas.width = 1024;
    this.boardCanvas.height = 256;
    this.boardTexture = new THREE.CanvasTexture(this.boardCanvas);
    this.boardTexture.colorSpace = THREE.SRGBColorSpace;

    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(9.6, 2.4),
      new THREE.MeshBasicMaterial({ map: this.boardTexture, toneMapped: false })
    );
    board.position.set(0, 7.2, f.length / 2 + 13.5);
    board.rotation.y = Math.PI;
    this.root.add(board);

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(10.4, 3.1, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x080d12, roughness: 0.85 })
    );
    frame.position.set(0, 7.2, f.length / 2 + 13.7);
    this.root.add(frame);
    this.scoreboard = board;
  }

  /** Redraw the arena scoreboard. Cheap: only called when something changes. */
  drawScoreboard(sim) {
    const c = this.boardCanvas.getContext('2d');
    const W = this.boardCanvas.width, H = this.boardCanvas.height;
    c.fillStyle = '#04080d';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = '#16232e';
    c.lineWidth = 4;
    c.strokeRect(6, 6, W - 12, H - 12);

    c.font = 'bold 74px system-ui, sans-serif';
    c.textBaseline = 'middle';
    c.fillStyle = sim.homeTeam.colors.primary;
    c.textAlign = 'left';
    c.fillText(sim.homeTeam.short, 46, 90);
    c.fillStyle = sim.awayTeam.colors.primary;
    c.textAlign = 'right';
    c.fillText(sim.awayTeam.short, W - 46, 90);

    c.fillStyle = '#e8f6ff';
    c.textAlign = 'center';
    c.font = 'bold 96px system-ui, sans-serif';
    c.fillText(`${sim.score.home} : ${sim.score.away}`, W / 2, 90);

    const m = Math.floor(sim.gameClock / 60);
    const s = Math.floor(sim.gameClock % 60);
    c.font = 'bold 62px ui-monospace, monospace';
    c.fillStyle = '#7dd3fc';
    c.fillText(`P${sim.period}  ${m}:${String(s).padStart(2, '0')}`, W / 2, 190);

    c.font = 'bold 52px ui-monospace, monospace';
    c.fillStyle = sim.shotClock < 5 ? '#f87171' : '#fbbf24';
    c.textAlign = 'left';
    c.fillText(sim.shotClock.toFixed(0).padStart(2, '0'), 46, 190);
    c.textAlign = 'right';
    c.fillText(sim.shotClock.toFixed(0).padStart(2, '0'), W - 46, 190);

    this.boardTexture.needsUpdate = true;
  }

  connectWake(wake) {
    this.floorMaterial.uniforms.uWake.value = wake.texture;
    this.floorMaterial.uniforms.uWakeSize.value.set(wake.width, wake.length);
  }

  /**
   * Crowd reaction (section 26.4). Excitement drives a standing/sitting wave and
   * the amplitude of the idle motion.
   */
  update(dt, time, excitement) {
    this.crowdTime += dt;
    this.crowdExcitement += (excitement - this.crowdExcitement) * Math.min(1, dt * 2.5);
    this.floorMaterial.uniforms.uTime.value = time;

    if (!this.crowd) return;
    // Animate a subset each frame: the whole stand does not need to move at 60 Hz.
    const stride = 3;
    const offset = Math.floor(this.crowdTime * 60) % stride;
    const dummy = this._crowdDummy;
    const amp = 0.03 + this.crowdExcitement * 0.16;
    for (let i = offset; i < this.crowdCount; i += stride) {
      const bx = this.crowdBase[i * 3], by = this.crowdBase[i * 3 + 1], bz = this.crowdBase[i * 3 + 2];
      const ph = this.crowdPhase[i];
      const bob = Math.sin(this.crowdTime * (2.2 + this.crowdExcitement * 3.5) + ph) * amp;
      dummy.position.set(bx, by + Math.max(0, bob), bz);
      dummy.rotation.set(0, Math.atan2(-bx, -bz), Math.sin(this.crowdTime * 1.7 + ph) * 0.09 * this.crowdExcitement);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      this.crowd.setMatrixAt(i, dummy.matrix);
    }
    this.crowd.instanceMatrix.needsUpdate = true;
  }
}

/** A goal net built as a hanging grid, so shots visibly bulge it. */
function buildNet(width, height, depth, sign) {
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0xe6eef5, transparent: true, opacity: 0.5 });
  const pts = [];
  const cols = 13, rows = 8, deep = 5;

  // Back panel.
  for (let i = 0; i <= cols; i++) {
    const x = -width / 2 + (i / cols) * width;
    pts.push(x, height, sign * depth, x, -0.6, sign * depth);
  }
  for (let j = 0; j <= rows; j++) {
    const y = height - (j / rows) * (height + 0.6);
    pts.push(-width / 2, y, sign * depth, width / 2, y, sign * depth);
  }
  // Side panels and roof.
  for (let k = 0; k <= deep; k++) {
    const z = sign * (k / deep) * depth;
    pts.push(-width / 2, height, z, width / 2, height, z);
    pts.push(-width / 2, height, z, -width / 2, -0.6, z);
    pts.push(width / 2, height, z, width / 2, -0.6, z);
  }
  for (let i = 0; i <= cols; i++) {
    const x = -width / 2 + (i / cols) * width;
    pts.push(x, height, 0, x, height, sign * depth);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  group.add(new THREE.LineSegments(geo, mat));
  return group;
}

// ---------------------------------------------------------------------------
// Pool floor: tiles, regulation markings and animated caustics
// ---------------------------------------------------------------------------

const FLOOR_VERT = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FLOOR_FRAG = /* glsl */`
  precision highp float;
  uniform float uTime;
  uniform vec3 uTile;
  uniform vec3 uLine;
  uniform vec3 uAccent;
  uniform sampler2D uWake;
  uniform vec2 uWakeSize;
  uniform vec2 uHalf;
  uniform vec2 uFieldHalf;
  uniform float uCausticStrength;
  varying vec3 vWorld;

  vec2 hash2(vec2 p){
    p = vec2(dot(p, vec2(127.1,311.7)), dot(p, vec2(269.5,183.3)));
    return fract(sin(p) * 43758.5453);
  }

  // Cheap caustics: layered animated Worley-ish cells sharpened into light webs.
  float caustic(vec2 p, float t) {
    float v = 0.0;
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      vec2 q = p * (1.4 + fi * 0.85) + vec2(t * (0.08 + fi * 0.05), -t * (0.06 + fi * 0.04));
      vec2 id = floor(q);
      vec2 f = fract(q);
      float d = 1.0;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 g = vec2(float(x), float(y));
          vec2 o = hash2(id + g);
          o = 0.5 + 0.45 * sin(t * 0.9 + 6.2831 * o);
          d = min(d, length(g + o - f));
        }
      }
      v += pow(1.0 - clamp(d, 0.0, 1.0), 7.0) * (1.0 / (1.0 + fi));
    }
    return v;
  }

  void main() {
    vec2 p = vWorld.xz;

    // 250mm pool tiles with grout.
    vec2 tile = fract(p / 0.25);
    float grout = smoothstep(0.0, 0.06, min(tile.x, tile.y)) * smoothstep(0.0, 0.06, min(1.0 - tile.x, 1.0 - tile.y));
    vec3 col = mix(uTile * 0.72, uTile, grout);

    // Slight tile-to-tile colour variation so the floor is not flat.
    vec2 tid = floor(p / 0.25);
    col *= 0.94 + 0.12 * fract(sin(dot(tid, vec2(12.9898, 78.233))) * 43758.5453);

    // Lane lines running the length of the pool.
    float lane = smoothstep(0.11, 0.06, abs(mod(p.x + 1.25, 2.5) - 1.25));
    col = mix(col, uLine, lane * 0.85);

    // Field markings: goal lines, two metre, five metre, half distance.
    float gl = smoothstep(0.09, 0.04, abs(abs(p.y) - uFieldHalf.y));
    float m2 = smoothstep(0.07, 0.03, abs(abs(p.y) - (uFieldHalf.y - 2.0)));
    float m5 = smoothstep(0.07, 0.03, abs(abs(p.y) - (uFieldHalf.y - 5.0)));
    float m6 = smoothstep(0.06, 0.03, abs(abs(p.y) - (uFieldHalf.y - 6.0)));
    float hd = smoothstep(0.09, 0.04, abs(p.y));
    col = mix(col, vec3(0.92, 0.95, 0.98), gl * 0.9);
    col = mix(col, vec3(0.86, 0.12, 0.16), m2 * 0.85);
    col = mix(col, vec3(0.96, 0.78, 0.10), m5 * 0.8);
    col = mix(col, vec3(0.16, 0.68, 0.36), m6 * 0.7);
    col = mix(col, vec3(0.90, 0.93, 0.96), hd * 0.75);

    // Caustics, modulated by the live wake field so light follows the swimmers.
    vec2 wuv = vec2(p.x / uWakeSize.x + 0.5, p.y / uWakeSize.y + 0.5);
    float wake = 0.0;
    if (wuv.x > 0.0 && wuv.x < 1.0 && wuv.y > 0.0 && wuv.y < 1.0) {
      vec4 w = texture2D(uWake, wuv);
      wake = w.r;
    }
    float c = caustic(p + wake * 2.4, uTime);
    col += vec3(0.55, 0.85, 1.0) * c * (1.35 + wake * 2.0) * uCausticStrength;

    // Vignette toward the basin walls.
    vec2 e = 1.0 - clamp(abs(p) / uHalf, 0.0, 1.0);
    col *= 0.55 + 0.45 * smoothstep(0.0, 0.35, min(e.x, e.y));

    gl_FragColor = vec4(col, 1.0);
  }
`;
