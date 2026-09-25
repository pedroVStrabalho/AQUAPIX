/**
 * Front end (Design Bible section 28.4).
 *
 * Menus are original, fast, readable, controller-friendly and shallow: no mode
 * is more than two steps from the main menu. Unfinished systems are never
 * presented as functional buttons - they appear in the Implementation Status
 * screen with an honest label instead (sections 28.4 and 46, step 6).
 */

import { TEAMS } from '../data/Teams.js';
import { PROFILES, PLAYABLE_PROFILES, getProfile } from '../rules/RuleProfiles.js';
import { DIFFICULTY } from '../ai/TeamAI.js';
import { ASSIST_PROFILE } from '../core/MatchSim.js';
import { headlineRows, STAT_COLORS, starString, teamLevel } from '../data/DisplayStats.js';
import { OFFENSIVE_SYSTEMS, DEFENSIVE_SYSTEMS, EXTRA_PLAYER_SYSTEMS, MAN_DOWN_SYSTEMS } from '../ai/Tactics.js';
import { overallFor, POSITION_NAMES, ATTRIBUTE_GROUPS, TRAIT_BY_ID } from '../data/Attributes.js';
import { humanise } from './HUD.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const frag = () => document.createDocumentFragment();

export class ScreenManager {
  constructor(root, game) {
    this.root = root;
    this.game = game;
    this.current = null;
    this.node = null;
  }

  show(name, params = {}) {
    this.clear();
    this.current = name;
    const build = SCREENS[name];
    if (!build) throw new Error(`Unknown screen: ${name}`);
    this.node = build(this.game, params, this);
    this.root.appendChild(this.node);
    return this.node;
  }

  clear() {
    if (this.node) { this.node.remove(); this.node = null; }
    this.current = null;
  }

  toast(msg, ms = 2200) {
    const t = el('div', 'toast', msg);
    this.root.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }
}

function shell(title, bodyBuilder) {
  const s = el('div', 'screen');
  const head = el('div', 'screen-head');
  const brandWrap = el('div');
  brandWrap.appendChild(el('div', 'brand', 'AQUAPIX'));
  brandWrap.appendChild(el('div', 'brand-sub', 'Feel every splash. Command the water.'));
  head.appendChild(brandWrap);
  head.appendChild(el('div', 'screen-title', title));
  s.appendChild(head);
  const body = el('div', 'screen-body');
  bodyBuilder(body);
  s.appendChild(body);
  return s;
}

function menuItem(title, desc, tag, onClick, disabled = false) {
  const b = el('button', 'menu-item');
  const wrap = el('div');
  wrap.appendChild(el('div', 'mi-title', title));
  if (desc) wrap.appendChild(el('div', 'mi-desc', desc));
  b.appendChild(wrap);
  if (tag) {
    const cls = tag.startsWith('Playable') || tag === 'Implemented' ? 'tag-full'
      : tag.startsWith('Partial') ? 'tag-partial' : 'tag-designed';
    b.appendChild(el('span', `mi-tag ${cls}`, tag));
  }
  b.disabled = disabled;
  if (!disabled) b.addEventListener('click', onClick);
  return b;
}

/**
 * A headline play card for the main menu.
 *
 * Deliberately not a `menuItem`: the whole point is that starting a game must
 * not look like opening Settings. Each mode carries its own accent colour and
 * glyph so the eye can tell them apart before reading a word.
 */
function playCard(opts) {
  const b = el('button', `play-card ${opts.className ?? 'is-lead'}`);
  b.style.setProperty('--accent', opts.accent);
  b.style.setProperty('--wash', opts.wash);
  b.appendChild(el('span', 'pc-glyph', opts.glyph));
  if (opts.kicker) b.appendChild(el('div', 'pc-kicker', opts.kicker));
  b.appendChild(el('div', 'pc-title', opts.title));
  if (opts.desc) b.appendChild(el('div', 'pc-desc', opts.desc));
  b.addEventListener('click', opts.onClick);
  return b;
}

/** A quiet text link for tools and reference screens. */
function utilLink(label, onClick) {
  const b = el('button', 'util-link', label);
  b.addEventListener('click', onClick);
  return b;
}

function chipRow(options, value, onPick) {
  const wrap = el('div', 'field-control');
  for (const o of options) {
    const c = el('button', `chip ${o.value === value ? 'on' : ''}`, o.label);
    c.addEventListener('click', () => onPick(o.value));
    wrap.appendChild(c);
  }
  return wrap;
}

function field(label, control) {
  const row = el('div', 'field-row');
  row.appendChild(el('div', 'field-label', label));
  row.appendChild(control);
  return row;
}

// ===========================================================================
const SCREENS = {

  // ---------------------------------------------------------------- main ---
  main: (game, params, mgr) => shell('Main Menu', (body) => {
    const grid = el('div', 'play-grid');

    grid.appendChild(playCard({
      title: 'Quick Match', kicker: 'Jump in', glyph: '\u{1F93D}',
      accent: '#7dd3fc', wash: 'linear-gradient(135deg, #0c3b52, #072433)',
      desc: 'Pick two clubs and a rules profile, then play.',
      onClick: () => mgr.show('matchSetup'),
    }));

    grid.appendChild(playCard({
      title: 'Player Career', kicker: 'Be the athlete', glyph: '\u{1F3C5}',
      accent: '#fbbf24', wash: 'linear-gradient(135deg, #4a3410, #221806)',
      desc: 'You ARE a player: train, earn, live your life, then play the matches.',
      onClick: () => mgr.show('playerCreate'),
    }));

    grid.appendChild(playCard({
      title: 'Coach Career', kicker: 'Run the club', glyph: '\u{1F3DF}',
      accent: '#4ade80', wash: 'linear-gradient(135deg, #0d3f2a, #051c13)',
      className: 'is-wide',
      desc: 'Sign players, run an academy, work the market and the money, and win a league.',
      onClick: () => mgr.show('careerSetup'),
    }));

    grid.appendChild(playCard({
      title: 'Training Arena', kicker: 'Practice', glyph: '\u{1F3AF}',
      accent: '#c084fc', wash: 'linear-gradient(135deg, #331b4d, #180d24)',
      className: 'is-wide is-compact',
      desc: 'Isolated drills: shooting, passing under pressure, extra-player attack.',
      onClick: () => mgr.show('training'),
    }));

    body.appendChild(grid);

    // Tools and reference. Present, but not competing with the game itself.
    const util = el('div', 'util-row');
    const items = [
      ['Teams and Rosters', 'rosters'],
      ['Controls', 'controls'],
      ['Settings', 'settings'],
      ['Implementation Status', 'status'],
    ];
    items.forEach(([label, screen], i) => {
      if (i) util.appendChild(el('span', 'util-sep', '\u00b7'));
      util.appendChild(utilLink(label, () => mgr.show(screen)));
    });
    body.appendChild(util);
  }),

  // -------------------------------------------------------- match setup ---
  matchSetup: (game, params, mgr) => shell('Quick Match', (body) => {
    const cfg = game.matchConfig;

    const teamGrid = el('div', 'grid grid-3');
    const rebuild = () => {
      teamGrid.innerHTML = '';
      for (const t of TEAMS) {
        const card = el('div', 'card team-card');
        card.style.setProperty('--team', t.colors.primary);
        if (t.id === cfg.homeId) card.classList.add('selected');
        if (t.id === cfg.awayId) card.classList.add('selected');
        card.appendChild(el('div', 'tc-name', t.name));
        card.appendChild(el('div', 'tc-city', `${t.city} · ${t.country}`));
        card.appendChild(el('div', 'tc-bio', t.bio));

        const roster = game.league.rosters[t.id];
        const ovr = Math.round(roster.slice(0, 7).reduce((s, p) => s + p.overall, 0) / 7);
        const stats = el('div', 'tc-stats');
        const add = (label, value) => {
          const d = el('div', 'tc-stat');
          d.appendChild(el('b', null, value));
          d.appendChild(document.createTextNode(label));
          stats.appendChild(d);
        };
        add('SEVEN', ovr);
        add('PRESTIGE', t.prestige);
        add('STYLE', '');
        stats.lastChild.querySelector('b').textContent = humanise(t.style);
        stats.lastChild.querySelector('b').style.fontSize = '12px';
        card.appendChild(stats);

        const caps = el('div', 'tc-caps');
        for (const c of [t.colors.primary, t.colors.secondary, t.colors.cap, t.colors.capAlt]) {
          const dot = el('i', 'tc-cap');
          dot.style.background = c;
          caps.appendChild(dot);
        }
        card.appendChild(caps);

        const role = el('div', 'mi-desc');
        role.textContent = t.id === cfg.homeId ? 'HOME' : t.id === cfg.awayId ? 'AWAY' : 'Click to select home, then away';
        role.style.marginTop = '8px';
        role.style.letterSpacing = '0.2em';
        role.style.color = t.id === cfg.homeId || t.id === cfg.awayId ? t.colors.primary : '';
        card.appendChild(role);

        card.addEventListener('click', () => {
          if (cfg.homeId === t.id) { cfg.homeId = null; }
          else if (cfg.awayId === t.id) { cfg.awayId = null; }
          else if (!cfg.homeId) cfg.homeId = t.id;
          else if (!cfg.awayId) cfg.awayId = t.id;
          else { cfg.homeId = t.id; cfg.awayId = null; }
          rebuild();
          updateActions();
        });
        teamGrid.appendChild(card);
      }
    };

    body.appendChild(el('h3', null, ''));
    body.appendChild(teamGrid);
    rebuild();

    // ---- Options ---------------------------------------------------------
    const options = el('div', 'card');
    options.style.marginTop = '22px';
    options.appendChild(el('h3', null, 'Match Options'));

    // A saved choice of a profile that is no longer offered falls back to Short.
    if (!PLAYABLE_PROFILES.some((p) => p.id === cfg.profileId)) cfg.profileId = 'arcade';
    options.appendChild(field('Match length', chipRow(
      PLAYABLE_PROFILES.map((p) => ({ value: p.id, label: p.name })),
      cfg.profileId, (v) => { cfg.profileId = v; mgr.show('matchSetup'); })));

    options.appendChild(field('Difficulty', chipRow(
      Object.entries(DIFFICULTY).map(([k, v]) => ({ value: k, label: v.label })),
      cfg.difficulty, (v) => { cfg.difficulty = v; mgr.show('matchSetup'); })));

    options.appendChild(field('Assistance', chipRow([
      { value: ASSIST_PROFILE.BEGINNER, label: 'Beginner' },
      { value: ASSIST_PROFILE.STANDARD, label: 'Standard' },
      { value: ASSIST_PROFILE.COMPETITIVE, label: 'Competitive' },
      { value: ASSIST_PROFILE.FULL_SIM, label: 'Full Simulation' },
    ], cfg.assist, (v) => { cfg.assist = v; mgr.show('matchSetup'); })));

    options.appendChild(field('Officiating', chipRow([
      { value: 'strict', label: 'Strict' },
      { value: 'standard', label: 'Standard professional' },
      { value: 'human', label: 'Human-like' },
    ], cfg.refereeProfile, (v) => { cfg.refereeProfile = v; mgr.show('matchSetup'); })));

    // No spectate option: AQUAPIX is a game you play, not one you watch. The
    // AI-versus-AI simulation itself stays - Coach Career needs it to run the
    // fixtures you are not playing in - it just is not something you can sit
    // down in front of.
    options.appendChild(field('You control', chipRow([
      { value: 'home', label: 'Home' },
      { value: 'away', label: 'Away' },
    ], cfg.userSide === 'away' ? 'away' : 'home', (v) => { cfg.userSide = v; mgr.show('matchSetup'); })));

    body.appendChild(options);

    const actions = el('div', 'actions');
    const start = el('button', 'btn', 'Start Match');
    const back = el('button', 'btn ghost', 'Back');
    const hint = el('span', 'mi-desc');
    actions.appendChild(start);
    actions.appendChild(back);
    actions.appendChild(hint);
    body.appendChild(actions);

    const updateActions = () => {
      const ok = cfg.homeId && cfg.awayId && cfg.homeId !== cfg.awayId;
      start.disabled = !ok;
      hint.textContent = ok
        ? `${game.league.teams.find((t) => t.id === cfg.homeId).name}  v  ${game.league.teams.find((t) => t.id === cfg.awayId).name}`
        : 'Select a home club and an away club.';
    };
    updateActions();

    start.addEventListener('click', () => game.startQuickMatch());
    back.addEventListener('click', () => mgr.show('main'));
  }),

  // ------------------------------------------------------------ controls ---
  controls: (game, params, mgr) => shell('Controls', (body) => {
    const rows = [
      ['W A S D', 'Swim and orient the body', 'Drive, cut, reposition', 'Mark and recover', 'Position in goal'],
      ['Z', 'Pass', 'Call for the pass', 'Raise arm / block', 'Short outlet'],
      ['X', 'Shoot', 'Contextual one-touch', 'Steal - best right on the ball', 'Aggressive save'],
      ['Space', 'Shoot', '-', 'Foul your man - in front: free throw, behind: exclusion', '-'],
      ['C', 'Lob pass - lofted over a defender', 'Request a lead pass', '-', 'Long outlet'],
      ['Shift', 'Sprint - needs 70% readiness', 'Sprint into space', 'Recovery sprint', 'Explosive rise when set'],
      ['L', 'Pump fake, skip-shot modifier', 'Call teammate movement', 'Raise arm / block (alt)', 'Block modifier'],
      ['Q', 'Protect the ball', 'Tactical modifier', 'Press', 'Defensive command'],
      ['E', 'Switch player', 'Switch player', 'Switch controlled defender', '-'],
      ['G', 'Toggle goalkeeper control', '-', '-', 'Take manual control'],
      ['Arrows or mouse', 'Aim the shot or pass', 'Direction feint', 'Manual arm and steal direction', 'Manual save direction'],
      ['Shootout', 'UP / DOWN pick a corner, X or Space to shoot', '-', '-', 'UP / DOWN pick your dive - nothing stays in the middle'],
    ];

    const table = el('table', 'data');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['Input', 'In possession', 'Off ball', 'Defence', 'Goalkeeper']) hr.appendChild(el('th', null, h));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tb = el('tbody');
    for (const r of rows) {
      const tr = el('tr');
      r.forEach((c, i) => {
        const td = el('td');
        if (i === 0) {
          for (const part of c.split(' / ')) {
            const k = el('span', 'kbd', part);
            k.style.marginRight = '5px';
            td.appendChild(k);
          }
        } else td.textContent = c;
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    const card = el('div', 'card');
    card.appendChild(el('h3', null, 'Control scheme'));
    card.appendChild(table);
    body.appendChild(card);

    const extra = el('div', 'card');
    extra.style.marginTop = '16px';
    extra.appendChild(el('h3', null, 'Match commands'));
    const list = el('div', 'grid grid-3');
    // Only commands that are actually wired up. This list used to advertise a
    // camera on C (which is the lob pass), a tactics board, substitutions,
    // pulling the keeper and an AI overlay - none of which any key triggered.
    const cmds = [
      ['Esc / P', 'Pause - resume, statistics, quick settings, abandon'],
      ['T', 'Call a timeout (your possession, two a match)'],
      ['R', 'Substitutions - made at once, or at the next stoppage'],
      ['G', 'Take or release manual goalkeeper control'],
    ];
    for (const [k, d] of cmds) {
      const c = el('div');
      const kb = el('span', 'kbd', k);
      c.appendChild(kb);
      c.appendChild(document.createTextNode(' ' + d));
      c.style.fontSize = '11.5px';
      c.style.padding = '4px 0';
      list.appendChild(c);
    }
    extra.appendChild(list);
    body.appendChild(extra);

    const back = el('button', 'btn ghost', 'Back');
    back.addEventListener('click', () => mgr.show(params.from ?? 'main'));
    const a = el('div', 'actions');
    a.appendChild(back);
    body.appendChild(a);
  }),

  // ------------------------------------------------------------ settings ---
  settings: (game, params, mgr) => shell('Settings', (body) => {
    const s = game.settings;
    const refresh = () => mgr.show('settings', params);

    const gfx = el('div', 'card');
    gfx.appendChild(el('h3', null, 'Presentation'));
    gfx.appendChild(field('Splash density', chipRow([
      { value: 0, label: 'Off' }, { value: 0.5, label: 'Low' },
      { value: 1, label: 'Full' }, { value: 1.5, label: 'Maximum' },
    ], s.splashDensity, (v) => { s.splashDensity = v; game.applySettings(); refresh(); })));
    gfx.appendChild(field('Screen shake', chipRow([
      { value: true, label: 'On' }, { value: false, label: 'Off' },
    ], s.cameraShake, (v) => { s.cameraShake = v; game.applySettings(); refresh(); })));
    gfx.appendChild(field('Control hints', chipRow([
      { value: true, label: 'On' }, { value: false, label: 'Off' },
    ], s.showHints, (v) => { s.showHints = v; game.applySettings(); refresh(); })));
    body.appendChild(gfx);

    const acc = el('div', 'card');
    acc.style.marginTop = '16px';
    acc.appendChild(el('h3', null, 'Accessibility and readability'));
    acc.appendChild(field('Visual whistle indicator', chipRow([
      { value: true, label: 'On' }, { value: false, label: 'Off' },
    ], s.visualWhistle, (v) => { s.visualWhistle = v; game.applySettings(); refresh(); })));
    body.appendChild(acc);

    const a = el('div', 'actions');
    const back = el('button', 'btn ghost', 'Back');
    back.addEventListener('click', () => mgr.show(params.from ?? 'main'));
    a.appendChild(back);
    body.appendChild(a);
  }),

  // ------------------------------------------------------------- rosters ---
  rosters: (game, params, mgr) => shell('Teams and Rosters', (body) => {
    let selected = params.teamId ?? TEAMS[0].id;

    const tabs = el('div', 'field-control');
    tabs.style.marginBottom = '16px';
    for (const t of TEAMS) {
      const c = el('button', `chip ${t.id === selected ? 'on' : ''}`, t.short);
      c.addEventListener('click', () => mgr.show('rosters', { teamId: t.id, from: params.from }));
      tabs.appendChild(c);
    }
    body.appendChild(tabs);

    const team = TEAMS.find((t) => t.id === selected);
    const roster = game.league.rosters[selected];

    const head = el('div', 'card');
    head.style.borderLeft = `4px solid ${team.colors.primary}`;
    head.appendChild(el('div', 'tc-name', team.name));
    head.appendChild(el('div', 'tc-city', `${team.city} · ${team.country} · ${humanise(team.style)}`));
    head.appendChild(el('p', null, team.bio));
    body.appendChild(head);

    const table = el('table', 'data');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['Cap', 'Name', 'Pos', 'Age', 'OVR', 'Stars', 'Traits']) {
      hr.appendChild(el('th', h === 'OVR' ? 'num' : null, h));
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tb = el('tbody');
    for (const p of roster) {
      const tr = el('tr');
      if (p.capNumber <= 7) tr.className = 'row-hi';
      tr.appendChild(el('td', 'num', String(p.capNumber)));
      tr.appendChild(el('td', null, p.name));
      tr.appendChild(el('td', null, `${p.position}${p.secondaryPosition ? '/' + p.secondaryPosition : ''}`));
      tr.appendChild(el('td', 'num', String(p.age)));
      tr.appendChild(el('td', 'num', String(p.overall)));
      const st = el('td', null, starString(p.overall)); st.style.color = '#f4c430';
      tr.appendChild(st);
      tr.appendChild(el('td', null, (p.traits ?? []).map((t) => TRAIT_BY_ID[t]?.name ?? t).join(', ')));
      tr.addEventListener('click', () => mgr.show('player', { playerId: p.id, teamId: selected, from: params.from }));
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    const card = el('div', 'card');
    card.style.marginTop = '14px';
    card.appendChild(el('h3', null, 'Squad — click an athlete for the full attribute sheet'));
    card.appendChild(table);
    body.appendChild(card);

    const a = el('div', 'actions');
    const back = el('button', 'btn ghost', 'Back');
    back.addEventListener('click', () => mgr.show(params.from ?? 'main'));
    a.appendChild(back);
    body.appendChild(a);
  }),

  // -------------------------------------------------------------- player ---
  player: (game, params, mgr) => shell('Athlete', (body) => {
    const roster = game.league.rosters[params.teamId];
    const p = roster.find((x) => x.id === params.playerId);
    const team = TEAMS.find((t) => t.id === params.teamId);

    const head = el('div', 'card');
    head.style.borderLeft = `4px solid ${team.colors.primary}`;
    const nameRow = el('div', 'tc-name', `#${p.capNumber}  ${p.name}`);
    head.appendChild(nameRow);
    const stars = el('div', null, starString(p.overall));
    stars.style.color = '#f4c430'; stars.style.fontSize = '16px'; stars.style.letterSpacing = '2px';
    head.appendChild(stars);
    head.appendChild(el('div', 'tc-city',
      `${POSITION_NAMES[p.position]}${p.secondaryPosition ? ' · also ' + POSITION_NAMES[p.secondaryPosition] : ''} · ` +
      `${p.age} years · ${p.height} cm · ${p.leftHanded ? 'left' : 'right'} handed`));

    const overalls = el('div', 'tc-stats');
    for (const pos of [p.position, p.secondaryPosition].filter(Boolean)) {
      const d = el('div', 'tc-stat');
      d.appendChild(el('b', null, String(overallFor(p, pos))));
      d.appendChild(document.createTextNode(`${pos} OVERALL`));
      overalls.appendChild(d);
    }
    const pot = el('div', 'tc-stat');
    pot.appendChild(el('b', null, String(p.potential)));
    pot.appendChild(document.createTextNode('POTENTIAL'));
    overalls.appendChild(pot);
    const form = el('div', 'tc-stat');
    form.appendChild(el('b', null, `${Math.round(p.form * 100)}%`));
    form.appendChild(document.createTextNode('FORM'));
    overalls.appendChild(form);
    head.appendChild(overalls);

    // Headline five-stat panel with bars (the readable sports-game view).
    const bigFive = el('div', 'big5');
    for (const [label, key, val] of headlineRows(p)) {
      const row = el('div', 'big5-row');
      row.appendChild(el('span', 'big5-l', label));
      const bar = el('div', 'big5-bar');
      const fill = el('i');
      fill.style.width = `${val}%`;
      fill.style.background = STAT_COLORS[key] ?? '#7dd3fc';
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(el('span', 'big5-v', String(val)));
      bigFive.appendChild(row);
    }
    head.appendChild(bigFive);

    if (p.traits?.length) {
      const tr = el('p', null, p.traits.map((t) => TRAIT_BY_ID[t]?.name).filter(Boolean).join(' · '));
      tr.style.color = team.colors.primary;
      tr.style.marginTop = '10px';
      head.appendChild(tr);
    }
    body.appendChild(head);

    const grid = el('div', 'grid grid-3');
    grid.style.marginTop = '14px';
    for (const [group, attrs] of Object.entries(ATTRIBUTE_GROUPS)) {
      if (group === 'goalkeeping' && p.position !== 'GK') continue;
      const card = el('div', 'card');
      card.appendChild(el('h3', null, humanise(group)));
      for (const key of attrs) {
        const v = p.attr[key] ?? 50;
        const row = el('div', 'pcb');
        row.appendChild(el('span', 'pcb-l', humanise(key)));
        const bar = el('div', 'pcb-bar');
        const fill = el('i');
        fill.style.width = `${v}%`;
        fill.style.background = v >= 85 ? '#4ade80' : v >= 70 ? '#7dd3fc' : v >= 55 ? '#fbbf24' : '#f87171';
        bar.appendChild(fill);
        row.appendChild(bar);
        row.style.gridTemplateColumns = '120px 1fr';
        card.appendChild(row);
      }
      grid.appendChild(card);
    }
    body.appendChild(grid);

    const a = el('div', 'actions');
    const back = el('button', 'btn ghost', 'Back to squad');
    back.addEventListener('click', () => mgr.show('rosters', { teamId: params.teamId, from: params.from }));
    a.appendChild(back);
    body.appendChild(a);
  }),

  // ------------------------------------------------------------- training ---
  training: (game, params, mgr) => shell('Training Arena', (body) => {
    body.appendChild(el('p', null,
      'Isolated drills that run on the full match simulation - the same physics, the same officiating, the same AI.'));
    const list = el('div', 'menu-list');
    const drills = [
      ['freePlay', 'Free Play', 'Full seven-on-seven with the clock stopped. Learn the water.'],
      ['shooting', 'Shooting Drill', 'Repeated possessions against a live goalkeeper from six metres.'],
      ['extraPlayer', 'Extra-Player Attack', 'Six-on-five with the possession clock at eighteen seconds.'],
      ['centre', 'Centre Battle', 'Two-on-two around the centre forward. Learn leverage and exclusions.'],
      ['counter', 'Counterattack', 'Turnover into transition, repeatedly.'],
    ];
    for (const [id, title, desc] of drills) {
      list.appendChild(menuItem(title, desc, null, () => game.startTraining(id)));
    }
    body.appendChild(list);

    const a = el('div', 'actions');
    const back = el('button', 'btn ghost', 'Back');
    back.addEventListener('click', () => mgr.show('main'));
    a.appendChild(back);
    body.appendChild(a);
  }),

  // --------------------------------------------------------------- status ---
  status: (game, params, mgr) => shell('Implementation Status', (body) => {
    body.appendChild(el('p', null,
      'Section 46, step 6 of the design bible requires an honest completion report. ' +
      'Nothing below is described as finished unless it is actually running in the match simulation.'));

    // Moved here off the main menu: it is a statement of record, not something
    // a player needs to read before choosing a game mode.
    const ip = el('div', 'card');
    ip.style.marginBottom = '18px';
    ip.appendChild(el('h3', null, 'Original intellectual property'));
    ip.appendChild(el('p', null,
      'Every club, athlete, venue, competition and item of equipment in AQUAPIX is invented. ' +
      'No real team, player, federation, sponsor or likeness appears anywhere in this build.'));
    ip.appendChild(el('p', null,
      `Rules follow the ${getProfile('wa-2026').name} profile: 25 m field, four eight-minute periods, ` +
      '28-second possession, 18-second secondary possession, 18-second exclusions, penalties from five metres.'));
    body.appendChild(ip);

    const groups = [
      ['Fully implemented and playable', 'tag-full', [
        'Versioned rules profiles with the World Aquatics 2026 baseline',
        'Match state machine: periods, intervals, swim-off, restarts, timeouts, shootout',
        'Possession clock: 28 second normal and 18 second secondary, with correct resets',
        'Hydrodynamic locomotion: propulsion, quadratic drag, directional resistance, momentum, turning radius',
        'Eggbeater elevation with three-layer stamina and explosive-effort decay',
        'Ball physics: buoyancy, partial submersion, air and water drag, spin, Magnus, physical skip shots',
        'Passing: fourteen pass types, receiver selection, ten catch outcomes',
        'Shooting: seventeen techniques, release timing, explainable shot quality',
        'Continuous contact model and the fifteen-step foul classification pipeline',
        'Ordinary fouls, exclusions, penalties, personal fouls, exclusion re-entry',
        'Goalkeeper: geometric save volumes, rebound control, pump-fake discipline, three assist profiles',
        'Seven-layer AI with tendency learning and a debug overlay',
        'Team tactics: offensive systems, defensive systems, extra-player and man-down structures',
        'Substitutions including flying substitutions and pulling the goalkeeper',
        'Full statistics package and deterministic match record',
        'Broadcast water rendering: planar reflection, screen-space refraction, wake field, caustics, foam',
        'Nine cameras, HUD, call explanations, accessibility settings',
        'Save and load for both a match and a career season',
      ]],
      ['Partially implemented', 'tag-partial', [
        'Manager Career - squad, tactics, training, fixtures, table and transfers are functional; ' +
        'scouting, staff, facilities and finances are simplified to a single club-level model',
        'Video review - the deterministic snapshot and reversal logic exist and are unit tested, ' +
        'but there is no cinematic review presentation yet',
        'Commentary - a written event ticker and analyst lines; no recorded voice',
        'Animation - fully procedural rigs; no motion capture',
        'Venues - four invented venues share one architectural kit',
      ]],
      ['Designed but not implemented', 'tag-designed', [
        'Player Career, Ultimate Squad, Online Clubs and cooperative team control',
        'Online play, matchmaking, server-authoritative ball and anti-cheat',
        'Live seasons, community rosters, cross-platform infrastructure',
        'Recorded two-person commentary booth and crowd chant packs',
        'Coach challenge presentation flow',
      ]],
      ['Blocked by licensing or production resources', 'tag-designed', [
        'Real clubs, national teams, athletes, likenesses, venues, competitions, trophies and sponsors ' +
        '- none may appear without the necessary rights (section 4.9)',
        'Motion capture of real athletes',
        'Professional commentary recording',
      ]],
    ];

    const grid = el('div', 'grid grid-2');
    grid.style.marginTop = '18px';
    for (const [title, cls, items] of groups) {
      const card = el('div', 'card');
      const h = el('h3', null, title);
      h.className = `${cls}`;
      h.style.fontSize = '11px';
      h.style.letterSpacing = '0.2em';
      card.appendChild(h);
      const ul = el('ul');
      ul.style.margin = '0';
      ul.style.paddingLeft = '18px';
      for (const i of items) {
        const li = el('li', null, i);
        li.style.fontSize = '11.5px';
        li.style.color = 'var(--muted)';
        li.style.lineHeight = '1.65';
        li.style.marginBottom = '5px';
        ul.appendChild(li);
      }
      card.appendChild(ul);
      grid.appendChild(card);
    }
    body.appendChild(grid);

    const a = el('div', 'actions');
    const back = el('button', 'btn ghost', 'Back');
    back.addEventListener('click', () => mgr.show('main'));
    a.appendChild(back);
    body.appendChild(a);
  }),
};

// Career screens are registered by the career module to keep this file focused.
export function registerScreen(name, builder) { SCREENS[name] = builder; }
export { shell, menuItem, chipRow, field, el };
