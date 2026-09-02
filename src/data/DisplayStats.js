/**
 * Headline stats - the simple, readable five-category view a sports game shows.
 *
 * The simulation runs on granular attributes (Attributes.js). These five numbers
 * are an aggregate *view* of those attributes so the UI can show, e.g.,
 * "Swimming 87, Strength 65, Stamina 78, Passing 76, Shooting 84" plus a star
 * rating and morale - without the engine losing its depth. For a goalkeeper the
 * fifth category becomes Goalkeeping.
 */

const avg = (obj, keys) => Math.round(keys.reduce((s, k) => s + (obj[k] ?? 50), 0) / keys.length);

const MAP = {
  swimming: ['swimSpeed', 'firstStroke', 'changeOfDirection', 'recoverySpeed', 'explosiveness'],
  strength: ['upperStrength', 'leverage', 'legPower', 'balance', 'bodyControl'],
  stamina: ['endurance', 'burstStamina', 'effortRecovery'],
  passing: ['shortPass', 'longPass', 'vision', 'entryPass', 'dryPassControl'],
  shooting: ['shotPower', 'shotPlacement', 'skipControl', 'releaseSpeed', 'backhand'],
  goalkeeping: ['reactionSpeed', 'setPositioning', 'lateralMovement', 'reboundControl', 'verticalExplosion'],
};

/** The five headline numbers for a player. GK swaps shooting -> goalkeeping. */
export function headlineStats(player) {
  const a = player.attr;
  const gk = player.position === 'GK';
  return {
    swimming: avg(a, MAP.swimming),
    strength: avg(a, MAP.strength),
    stamina: avg(a, MAP.stamina),
    passing: avg(a, MAP.passing),
    [gk ? 'goalkeeping' : 'shooting']: avg(a, gk ? MAP.goalkeeping : MAP.shooting),
  };
}

/** Ordered [label, key, value] rows for display. */
export function headlineRows(player) {
  const h = headlineStats(player);
  const gk = player.position === 'GK';
  return [
    ['Swimming', 'swimming', h.swimming],
    ['Strength', 'strength', h.strength],
    ['Stamina', 'stamina', h.stamina],
    ['Passing', 'passing', h.passing],
    [gk ? 'Goalkeeping' : 'Shooting', gk ? 'goalkeeping' : 'shooting', gk ? h.goalkeeping : h.shooting],
  ];
}

export const STAT_COLORS = {
  swimming: '#38bdf8', strength: '#f97316', stamina: '#a3e635',
  passing: '#c084fc', shooting: '#f43f5e', goalkeeping: '#facc15',
};

/** Star rating 0.5..5 in half-star steps, from the position-weighted overall. */
export function starRating(overall) {
  // 50 -> 1 star, 88+ -> 5 stars, in half-star steps.
  const stars = 1 + ((overall - 50) / 38) * 4;
  return Math.max(0.5, Math.min(5, Math.round(stars * 2) / 2));
}

/** Render stars as a compact string, e.g. "★★★½☆". */
export function starString(overall) {
  const s = starRating(overall);
  const full = Math.floor(s);
  const half = s - full >= 0.5;
  let out = '★'.repeat(full);
  if (half) out += '½';
  out += '☆'.repeat(5 - full - (half ? 1 : 0));
  return out;
}

/** Team level = average headline overall of the best seven. */
export function teamLevel(roster) {
  const seven = roster.slice().sort((a, b) => b.overall - a.overall).slice(0, 7);
  return Math.round(seven.reduce((s, p) => s + p.overall, 0) / Math.max(1, seven.length));
}

/** Team morale = average of individual morale (0..1 stored) -> 0..100. */
export function teamMorale(roster, moraleOf) {
  const vals = roster.map((p) => moraleOf ? moraleOf(p) : (p.morale ?? 0.7));
  return Math.round((vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length)) * 100);
}
