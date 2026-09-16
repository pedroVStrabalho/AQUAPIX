/**
 * Team tactics, formations and set plays (Design Bible section 20).
 *
 * Formations are expressed in *goal-relative* coordinates: `d` is metres out from
 * the goal line being attacked, `x` is metres from the pool's centre line. The
 * simulation converts them into world space with the team's attack direction, so
 * one definition serves both ends of the pool and both teams.
 */

import { clamp, lerp } from '../core/Math2.js';

export const OFFENSIVE_SYSTEMS = {
  centreFirst: {
    name: 'Centre First',
    desc: 'Feed the centre forward early and play off the collapse.',
    slots: [
      { role: 'CF', d: 2.1, x: 0.0 },
      { role: 'WG', d: 2.7, x: -4.7 },
      { role: 'WG', d: 2.7, x: 4.7 },
      { role: 'DR', d: 5.6, x: -4.0 },
      { role: 'DR', d: 5.6, x: 4.0 },
      { role: 'PT', d: 7.4, x: 0.0 },
    ],
    entryBias: 0.75, driveBias: 0.25, shootBias: 0.4, tempo: 0.42,
  },
  driveHeavy: {
    name: 'Drive Heavy',
    desc: 'Constant motion, cuts from the flats, punish switch errors.',
    slots: [
      { role: 'CF', d: 2.4, x: 0.4 },
      { role: 'WG', d: 3.2, x: -5.0 },
      { role: 'WG', d: 3.2, x: 5.0 },
      { role: 'DR', d: 6.2, x: -3.8 },
      { role: 'DR', d: 6.2, x: 3.8 },
      { role: 'PT', d: 7.8, x: 0.0 },
    ],
    entryBias: 0.35, driveBias: 0.8, shootBias: 0.5, tempo: 0.68,
  },
  perimeter: {
    name: 'Perimeter Shooting',
    desc: 'Wide spacing, quick circulation, skip shots from six metres.',
    slots: [
      { role: 'CF', d: 2.6, x: 0.0 },
      { role: 'WG', d: 3.4, x: -5.4 },
      { role: 'WG', d: 3.4, x: 5.4 },
      { role: 'DR', d: 6.4, x: -3.6 },
      { role: 'DR', d: 6.4, x: 3.6 },
      { role: 'PT', d: 7.9, x: 0.0 },
    ],
    entryBias: 0.28, driveBias: 0.35, shootBias: 0.82, tempo: 0.55,
  },
  counter: {
    name: 'Counterattack Priority',
    desc: 'Sprint the moment the ball turns over; settle only if the lane closes.',
    slots: [
      { role: 'CF', d: 2.3, x: -0.6 },
      { role: 'WG', d: 3.0, x: -5.1 },
      { role: 'WG', d: 3.0, x: 5.1 },
      { role: 'DR', d: 5.8, x: -3.4 },
      { role: 'DR', d: 5.8, x: 3.4 },
      { role: 'PT', d: 7.6, x: 0.0 },
    ],
    entryBias: 0.45, driveBias: 0.62, shootBias: 0.55, tempo: 0.9,
  },
  controlledTempo: {
    name: 'Controlled Tempo',
    desc: 'Hold the ball, drain the clock, take only good shots.',
    slots: [
      { role: 'CF', d: 2.2, x: 0.0 },
      { role: 'WG', d: 2.9, x: -4.8 },
      { role: 'WG', d: 2.9, x: 4.8 },
      { role: 'DR', d: 6.4, x: -4.2 },
      { role: 'DR', d: 6.4, x: 4.2 },
      { role: 'PT', d: 7.7, x: 0.0 },
    ],
    entryBias: 0.55, driveBias: 0.3, shootBias: 0.3, tempo: 0.25,
  },
  utility: {
    name: 'Balanced Utility',
    desc: 'No fixed hierarchy; whoever is open takes the shot.',
    slots: [
      { role: 'CF', d: 2.3, x: 0.0 },
      { role: 'WG', d: 3.0, x: -4.9 },
      { role: 'WG', d: 3.0, x: 4.9 },
      { role: 'DR', d: 6.4, x: -4.2 },
      { role: 'DR', d: 6.4, x: 4.2 },
      { role: 'PT', d: 7.6, x: 0.0 },
    ],
    entryBias: 0.5, driveBias: 0.5, shootBias: 0.5, tempo: 0.5,
  },
};

/** Extra-player (six on five) structures, section 20.2. */
export const EXTRA_PLAYER_SYSTEMS = {
  fourTwo: {
    name: '4-2',
    slots: [
      { role: 'post', d: 2.0, x: -1.6 },
      { role: 'post', d: 2.0, x: 1.6 },
      { role: 'wing', d: 2.4, x: -4.8 },
      { role: 'wing', d: 2.4, x: 4.8 },
      { role: 'flat', d: 5.4, x: -2.2 },
      { role: 'flat', d: 5.4, x: 2.2 },
    ],
  },
  threeThree: {
    name: '3-3',
    slots: [
      { role: 'post', d: 2.1, x: 0.0 },
      { role: 'wing', d: 2.5, x: -4.6 },
      { role: 'wing', d: 2.5, x: 4.6 },
      { role: 'flat', d: 5.8, x: -3.4 },
      { role: 'point', d: 6.6, x: 0.0 },
      { role: 'flat', d: 5.8, x: 3.4 },
    ],
  },
};

export const DEFENSIVE_SYSTEMS = {
  fullPress: { name: 'Full Press', pressure: 0.95, drop: 0.05, frontCentre: 0.7, switchAggression: 0.6, foulRisk: 0.75 },
  controlledPress: { name: 'Controlled Press', pressure: 0.72, drop: 0.25, frontCentre: 0.5, switchAggression: 0.5, foulRisk: 0.5 },
  centreFront: { name: 'Centre Front', pressure: 0.6, drop: 0.3, frontCentre: 1.0, switchAggression: 0.45, foulRisk: 0.55 },
  centreBehind: { name: 'Centre Behind', pressure: 0.6, drop: 0.35, frontCentre: 0.0, switchAggression: 0.4, foulRisk: 0.45 },
  mDrop: { name: 'M-Drop', pressure: 0.4, drop: 0.85, frontCentre: 0.25, switchAggression: 0.35, foulRisk: 0.35 },
  zone: { name: 'Zone', pressure: 0.3, drop: 0.95, frontCentre: 0.4, switchAggression: 0.2, foulRisk: 0.3 },
  doubleStar: { name: 'Double the Star', pressure: 0.8, drop: 0.2, frontCentre: 0.6, switchAggression: 0.8, foulRisk: 0.65, doubleBest: true },
};

/** Man-down structures, section 20.3. */
export const MAN_DOWN_SYSTEMS = {
  threeTwo: {
    name: '3-2',
    slots: [
      { d: 1.9, x: -2.4 }, { d: 1.9, x: 0.0 }, { d: 1.9, x: 2.4 },
      { d: 4.4, x: -1.6 }, { d: 4.4, x: 1.6 },
    ],
  },
  twoThree: {
    name: '2-3',
    slots: [
      { d: 1.9, x: -1.6 }, { d: 1.9, x: 1.6 },
      { d: 4.2, x: -3.0 }, { d: 4.2, x: 0.0 }, { d: 4.2, x: 3.0 },
    ],
  },
};

/** Map a team's declared style to a default system pair. */
export const STYLE_PRESET = {
  'centre-first': { offense: 'centreFirst', defense: 'centreFront', extra: 'fourTwo', manDown: 'threeTwo' },
  press: { offense: 'driveHeavy', defense: 'fullPress', extra: 'fourTwo', manDown: 'threeTwo' },
  'drive-heavy': { offense: 'driveHeavy', defense: 'controlledPress', extra: 'threeThree', manDown: 'twoThree' },
  perimeter: { offense: 'perimeter', defense: 'mDrop', extra: 'threeThree', manDown: 'twoThree' },
  'controlled-tempo': { offense: 'controlledTempo', defense: 'centreBehind', extra: 'fourTwo', manDown: 'threeTwo' },
  counter: { offense: 'counter', defense: 'controlledPress', extra: 'threeThree', manDown: 'threeTwo' },
  zone: { offense: 'controlledTempo', defense: 'zone', extra: 'fourTwo', manDown: 'twoThree' },
  utility: { offense: 'utility', defense: 'controlledPress', extra: 'fourTwo', manDown: 'threeTwo' },
};

/** Tactical triggers the user can arm from the D-pad menu (section 20.4). */
export const TACTICAL_TRIGGERS = [
  { id: 'pressAfterGoal', label: 'Press after a goal', on: false },
  { id: 'dropOnCentreEntry', label: 'Drop when the centre receives', on: false },
  { id: 'doubleStar', label: 'Double the opposing star', on: false },
  { id: 'counterDesignated', label: 'Counter only with designated swimmers', on: false },
  { id: 'slowWhenLeading', label: 'Slow the tempo when leading', on: true },
  { id: 'pullKeeperLate', label: 'Pull the goalkeeper in the final possession', on: false },
  { id: 'subTiredCentreDefender', label: 'Substitute a tired centre defender after a turnover', on: true },
  { id: 'protectTwoFouls', label: 'Protect athletes with two personal fouls', on: true },
];

/**
 * Convert a goal-relative slot into world space.
 * @param {{d:number,x:number}} slot
 * @param {number} attackDir +1 or -1
 * @param {object} profile
 */
export function slotToWorld(slot, attackDir, profile) {
  const half = profile.field.length / 2;
  return {
    x: clamp(slot.x, -profile.field.width / 2 + 0.6, profile.field.width / 2 - 0.6),
    z: attackDir * (half - slot.d),
  };
}

/** Defensive marking spot: goal side of the attacker, offset by the scheme. */
export function markingSpot(attacker, defendAtDir, profile, scheme, isCentre) {
  const half = profile.field.length / 2;
  const ownGoalZ = defendAtDir * half;
  const toGoal = { x: 0 - attacker.pos.x, z: ownGoalZ - attacker.pos.z };
  const len = Math.hypot(toGoal.x, toGoal.z) || 1;
  toGoal.x /= len; toGoal.z /= len;

  // Pressing defenders sit tight and in front; dropping defenders sag toward goal.
  // How much water the defender leaves the attacker. The old range was
  // 1.35m to 0.55m - so even a "loose" mark was within arm's reach and the
  // carrier had nowhere to work at any difficulty. A dropping defence now
  // genuinely drops off.
  const tight = lerp(2.7, 0.6, scheme.pressure);
  const sag = lerp(0, 2.6, scheme.drop);

  if (isCentre && scheme.frontCentre > 0.5) {
    // Fronting: get between the ball and the centre, on the ball side.
    return { x: attacker.pos.x * 0.85, z: attacker.pos.z - defendAtDir * -0.55 };
  }
  // Bias the marking spot toward the defender's own side of the pool so six
  // defenders never stack on top of each other when the attack is narrow.
  const widen = clamp(attacker.pos.x, -6, 6) * 0.25;
  return {
    x: attacker.pos.x + toGoal.x * (tight + sag * 0.4) + widen,
    z: attacker.pos.z + toGoal.z * (tight + sag),
  };
}

export function makeTeamTactics(styleKey) {
  const preset = STYLE_PRESET[styleKey] ?? STYLE_PRESET.utility;
  return {
    offense: preset.offense,
    defense: preset.defense,
    extraPlayer: preset.extra,
    manDown: preset.manDown,
    tempo: OFFENSIVE_SYSTEMS[preset.offense].tempo,
    aggression: DEFENSIVE_SYSTEMS[preset.defense].foulRisk,
    counterCommitment: 0.5,
    triggers: TACTICAL_TRIGGERS.map((t) => ({ ...t })),
    assignments: { primaryShooter: null, postFinisher: null, distributor: null, safety: null, rebound: null },
  };
}
