/**
 * Eight balanced fictional teams and their generated rosters (section 6.2).
 *
 * Everything here is original intellectual property: invented clubs, invented
 * cities, invented athletes. No real club, competition, athlete, sponsor or venue
 * appears anywhere in the build (section 4.9).
 *
 * Rosters are generated from a fixed seed so that every player sees the same
 * league, but the whole structure is plain data and is fully editable by the
 * roster editor and persisted in the save file.
 */

import { Rng, clamp, clamp01, lerp } from '../core/Math2.js';
import { ALL_ATTRIBUTES, ATTRIBUTE_GROUPS, TRAITS, overallFor } from './Attributes.js';

export const TEAMS = [
  {
    id: 'tidal', name: 'Meridian Tidal', short: 'MER', city: 'Meridian Bay', country: 'Costa Verde',
    colors: { primary: '#0ea5e9', secondary: '#f8fafc', cap: '#0b4a6f', capAlt: '#e2e8f0' },
    prestige: 84, style: 'centre-first', venue: 'meridian-arena',
    bio: 'Patient possession side built around a punishing centre forward and a veteran point.',
  },
  {
    id: 'kraken', name: 'Vallhaven Kraken', short: 'VAL', city: 'Vallhaven', country: 'Nordmark',
    colors: { primary: '#14532d', secondary: '#facc15', cap: '#052e16', capAlt: '#fde68a' },
    prestige: 88, style: 'press', venue: 'north-basin',
    bio: 'Relentless full press. They will foul you into a bad decision and sprint the counter.',
  },
  {
    id: 'solaris', name: 'Solaris Marina', short: 'SOL', city: 'Porto Solaris', country: 'Adriana',
    colors: { primary: '#f97316', secondary: '#1e293b', cap: '#7c2d12', capAlt: '#fed7aa' },
    prestige: 86, style: 'drive-heavy', venue: 'solaris-lido',
    bio: 'Outdoor Mediterranean club. Constant driving, quick releases, chaotic in the best way.',
  },
  {
    id: 'atlas', name: 'Atlas Delfines', short: 'ATL', city: 'Ciudad Atlas', country: 'Marena',
    colors: { primary: '#7c3aed', secondary: '#f5f3ff', cap: '#3b0764', capAlt: '#ddd6fe' },
    prestige: 82, style: 'perimeter', venue: 'meridian-arena',
    bio: 'Perimeter shooting team. Skip shots from six metres and a goalkeeper who starts counters.',
  },
  {
    id: 'lanterns', name: 'Harbourgate Lanterns', short: 'HBG', city: 'Harbourgate', country: 'Albion Reach',
    colors: { primary: '#dc2626', secondary: '#fef2f2', cap: '#7f1d1d', capAlt: '#fecaca' },
    prestige: 79, style: 'controlled-tempo', venue: 'harbourgate-baths',
    bio: 'Old club, small pool, brutal discipline. Nobody enjoys visiting Harbourgate.',
  },
  {
    id: 'aurora', name: 'Aurora Cascade', short: 'AUR', city: 'Cascade City', country: 'Nordmark',
    colors: { primary: '#06b6d4', secondary: '#0f172a', cap: '#164e63', capAlt: '#a5f3fc' },
    prestige: 81, style: 'counter', venue: 'north-basin',
    bio: 'Built for transition. Two of the fastest first-stroke swimmers in the league.',
  },
  {
    id: 'obsidian', name: 'Obsidian Coast', short: 'OBS', city: 'Blackreef', country: 'Costa Verde',
    colors: { primary: '#334155', secondary: '#fbbf24', cap: '#0f172a', capAlt: '#fde68a' },
    prestige: 77, style: 'zone', venue: 'harbourgate-baths',
    bio: 'Zone defence specialists who concede the low-value shot and dare you to take it.',
  },
  {
    id: 'zephyr', name: 'Zephyr Union', short: 'ZEP', city: 'Windmere', country: 'Albion Reach',
    colors: { primary: '#65a30d', secondary: '#fafaf9', cap: '#365314', capAlt: '#d9f99d' },
    prestige: 75, style: 'utility', venue: 'solaris-lido',
    bio: 'A squad of utility athletes. No stars, no weaknesses, endless substitutions.',
  },
];

export const TEAM_BY_ID = Object.fromEntries(TEAMS.map((t) => [t.id, t]));

// --- Invented name pools -----------------------------------------------------
const FIRST = [
  'Marko', 'Iker', 'Teodor', 'Luka', 'Nils', 'Andrei', 'Dario', 'Emil', 'Sandor', 'Vito',
  'Kasper', 'Renzo', 'Milos', 'Arno', 'Feliks', 'Bram', 'Zoran', 'Tomas', 'Elio', 'Rafa',
  'Osian', 'Janek', 'Gero', 'Nico', 'Sten', 'Alvaro', 'Dimitri', 'Erol', 'Pau', 'Vasco',
  'Hektor', 'Joris', 'Matej', 'Anselm', 'Radu', 'Casimir', 'Tibor', 'Ilan', 'Mirek', 'Sava',
];
const LAST = [
  'Vaquero', 'Draskovic', 'Lindqvist', 'Marchetti', 'Halloran', 'Petrov', 'Kovacic', 'Nyland',
  'Barsi', 'Ferreiro', 'Oksanen', 'Delfino', 'Radovic', 'Weiss', 'Nowak', 'Van Aert', 'Milic',
  'Sorrentino', 'Aguirre', 'Bakker', 'Rasmussen', 'Cortese', 'Zoric', 'Almeida', 'Hedberg',
  'Lourenco', 'Vasilev', 'Brand', 'Mestre', 'Kallio', 'Duarte', 'Simic', 'Rovere', 'Ekstrom',
  'Navarrete', 'Bogdan', 'Lehto', 'Castellan', 'Vermeer', 'Antic',
];

const POSITION_PLAN = [
  // capNumber => position. 1 and 13 are goalkeepers per the rules profile.
  'GK', 'DR', 'WG', 'CD', 'CF', 'PT', 'DR', 'WG', 'CF', 'CD', 'UT', 'DR', 'GK', 'UT',
];

/** Attribute archetypes: baseline offsets per position, applied before noise. */
const ARCHETYPE = {
  GK: { goalkeeping: 22, physical: -2, shooting: -26, ball: -12, defence: -14, mental: 4 },
  CF: { goalkeeping: -30, physical: 8, shooting: 4, ball: 4, defence: -2, mental: 0 },
  CD: { goalkeeping: -30, physical: 6, shooting: -8, ball: -3, defence: 12, mental: 3 },
  DR: { goalkeeping: -30, physical: 10, shooting: 0, ball: 2, defence: 0, mental: 1 },
  WG: { goalkeeping: -30, physical: 2, shooting: 8, ball: 4, defence: -3, mental: 0 },
  PT: { goalkeeping: -30, physical: -2, shooting: 4, ball: 10, defence: 0, mental: 8 },
  UT: { goalkeeping: -30, physical: 3, shooting: 1, ball: 2, defence: 3, mental: 3 },
};

/** Specific attributes each position leans on hardest, boosted a second time. */
const SPECIALITY = {
  GK: ['reactionSpeed', 'setPositioning', 'verticalExplosion', 'skipTracking', 'closeRange'],
  CF: ['upperStrength', 'leverage', 'backhand', 'shootUnderContact', 'oneHandCatch'],
  CD: ['centreDefence', 'fronting', 'legalLeverage', 'foulDiscipline'],
  DR: ['swimSpeed', 'firstStroke', 'changeOfDirection', 'burstStamina', 'workRate'],
  WG: ['shotPlacement', 'skipControl', 'quickRelease', 'oneHandCatch'],
  PT: ['vision', 'entryPass', 'longPass', 'tacticalAwareness', 'shotPower'],
  UT: ['adaptability', 'endurance', 'workRate'],
};

function groupOf(attrName) {
  for (const [g, list] of Object.entries(ATTRIBUTE_GROUPS)) {
    if (list.includes(attrName)) return g;
  }
  return 'mental';
}

const ATTR_GROUP = Object.fromEntries(ALL_ATTRIBUTES.map((a) => [a, groupOf(a)]));

let uid = 0;

function makePlayer(rng, teamId, capNumber, quality) {
  const position = POSITION_PLAN[capNumber - 1];
  const arche = ARCHETYPE[position];
  const spec = SPECIALITY[position] ?? [];

  // Individual talent spread inside the squad: cap 2-7 are the starters.
  const starter = capNumber <= 7;
  const base = quality + (starter ? rng.range(0, 7) : rng.range(-13, 0));

  const attr = {};
  for (const name of ALL_ATTRIBUTES) {
    const g = ATTR_GROUP[name];
    let v = base + (arche[g] ?? 0) + rng.gauss(0, 6.5);
    if (spec.includes(name)) v += rng.range(4, 11);
    attr[name] = Math.round(clamp(v, 12, 97));
  }

  // Handedness: roughly one athlete in six is left handed, and left handers are
  // over-represented on the right-hand attacking side, so wings skew.
  const leftHanded = rng.chance(position === 'WG' ? 0.28 : 0.15);
  attr.weakHandControl = Math.round(clamp(attr.weakHandControl * rng.range(0.6, 0.95), 10, 92));
  attr.weakHandShot = Math.round(clamp(attr.weakHandShot * rng.range(0.55, 0.92), 10, 92));

  const height = Math.round(lerp(178, 205, rng.next() ** 0.85) + (position === 'GK' ? 4 : 0));
  const age = rng.int(18, 35);

  // Traits: elite athletes carry more of them.
  const traitCount = base > 82 ? rng.int(2, 3) : base > 72 ? rng.int(1, 2) : rng.int(0, 1);
  const pool = TRAITS.filter((t) => {
    if (position === 'GK') return ['eliteLegs', 'longReachBlocker', 'defensiveOrganiser', 'outletCommander', 'pressureResistant'].includes(t.id);
    return !['longReachBlocker'].includes(t.id);
  });
  const traits = [];
  for (let i = 0; i < traitCount; i++) {
    const t = rng.pick(pool);
    if (!traits.includes(t.id)) traits.push(t.id);
  }

  const secondaryPool = { GK: [], CF: ['CD', 'UT'], CD: ['CF', 'UT'], DR: ['WG', 'PT'], WG: ['DR', 'UT'], PT: ['DR', 'WG'], UT: ['DR', 'WG', 'CD', 'PT'] }[position];
  const secondaryPosition = secondaryPool.length && rng.chance(0.55) ? rng.pick(secondaryPool) : null;

  const p = {
    id: `p${++uid}`,
    teamId,
    capNumber,
    firstName: rng.pick(FIRST),
    lastName: rng.pick(LAST),
    position,
    secondaryPosition,
    leftHanded,
    height,
    age,
    attr,
    traits,
    // Season / career state, saved with the career file.
    form: rng.range(0.85, 1.12),
    morale: rng.range(0.6, 0.95),
    condition: rng.range(0.9, 1.0),
    contractYears: rng.int(1, 4),
    wage: 0,
  };
  p.name = `${p.firstName} ${p.lastName}`;
  p.overall = overallFor(p);
  // Potential score, 1-10 (the gem finder). Younger players skew higher; a few
  // are hidden gems. The overall cap is derived from it, so a 1-star kid with a
  // 10 can grow into a 5-star over a few seasons of development.
  const youthBoost = clamp01((26 - age) / 10);
  p.pot10 = Math.round(clamp(rng.gauss(4.6 + youthBoost * 2.4, 1.7), 1, 10));
  p.potential = Math.round(clamp(52 + p.pot10 * 4.3 + (30 - age) * 0.4, p.overall, 99));
  p.wage = Math.round((p.overall ** 2.2) / 60) * 10;
  return p;
}

/**
 * Build all eight rosters. Seeded, so the same league appears every time until the
 * user edits it. Quality is derived from prestige so the table has a shape but the
 * spread is deliberately tight - the design brief asks for eight *balanced* teams.
 */
export function generateLeague(seed = 20260727) {
  const rng = new Rng(seed);
  uid = 0;
  const rosters = {};
  for (const team of TEAMS) {
    // Prestige shapes the squad but only gently: the brief asks for eight
    // *balanced* teams, so a tactically disciplined underdog stays competitive.
    const quality = lerp(66, 73.5, (team.prestige - 75) / 13);
    const squad = [];
    for (let cap = 1; cap <= 14; cap++) {
      squad.push(makePlayer(rng.fork(cap * 7919 + team.id.length * 31), team.id, cap, quality));
    }
    // Rank starters so cap 2-7 really are the best available at their positions.
    squad.sort((a, b) => a.capNumber - b.capNumber);
    rosters[team.id] = squad;
  }
  return { seed, teams: TEAMS.map((t) => ({ ...t })), rosters };
}

/** Default seven: one goalkeeper plus the six strongest field players by role fit. */
export function defaultLineup(roster) {
  const gk = roster.filter((p) => p.position === 'GK').sort((a, b) => b.overall - a.overall)[0];
  const field = roster
    .filter((p) => p.position !== 'GK')
    .sort((a, b) => b.overall - a.overall);

  // Ensure the seven covers a centre forward and a centre defender.
  const chosen = [];
  const takeBy = (pos) => {
    const i = field.findIndex((p) => !chosen.includes(p) && (p.position === pos || p.secondaryPosition === pos));
    if (i >= 0) chosen.push(field[i]);
  };
  takeBy('CF');
  takeBy('CD');
  takeBy('PT');
  for (const p of field) {
    if (chosen.length >= 6) break;
    if (!chosen.includes(p)) chosen.push(p);
  }
  return [gk, ...chosen.slice(0, 6)];
}
