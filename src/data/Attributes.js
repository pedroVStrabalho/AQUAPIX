/**
 * Player attribute framework (Design Bible section 9.2).
 *
 * Attributes are 1-99. They are stored flat for fast lookup in the simulation hot
 * path, but grouped here so the roster editor and the UI can present them
 * meaningfully and so position-specific overalls can weight them (section 9.5).
 */

export const ATTRIBUTE_GROUPS = {
  physical: [
    'swimSpeed', 'firstStroke', 'recoverySpeed', 'changeOfDirection', 'endurance',
    'burstStamina', 'upperStrength', 'legPower', 'verticalReach', 'balance',
    'leverage', 'bodyControl', 'effortRecovery', 'wingspan', 'explosiveness',
  ],
  ball: [
    'ballSecurity', 'oneHandCatch', 'wetPassControl', 'dryPassControl', 'shortPass',
    'longPass', 'passVelocity', 'entryPass', 'outletPass', 'weakHandControl',
    'firstTouch', 'quickRelease',
  ],
  shooting: [
    'shotPower', 'shotPlacement', 'releaseSpeed', 'skipControl', 'lobControl',
    'backhand', 'sweep', 'sidearm', 'penaltyComposure', 'weakHandShot',
    'pumpFake', 'shootUnderContact',
  ],
  defence: [
    'marking', 'laneDenial', 'fronting', 'stealTiming', 'blockTiming',
    'recoveryDefence', 'helpRecognition', 'centreDefence', 'contactDiscipline',
    'legalLeverage', 'foulDiscipline', 'manDownAwareness',
  ],
  goalkeeping: [
    'setPositioning', 'reactionSpeed', 'lateralMovement', 'verticalExplosion',
    'singleArmReach', 'twoArmCoverage', 'closeRange', 'lobRecognition',
    'skipTracking', 'reboundControl', 'outletAccuracy', 'gkCommunication',
    'pumpFakeDiscipline',
  ],
  mental: [
    'vision', 'anticipation', 'decisionMaking', 'composure', 'aggression',
    'workRate', 'tacticalAwareness', 'communication', 'leadership', 'adaptability',
    'concentration', 'clutch', 'coachability',
  ],
};

export const ALL_ATTRIBUTES = Object.values(ATTRIBUTE_GROUPS).flat();

export const POSITIONS = ['GK', 'CF', 'CD', 'DR', 'WG', 'PT', 'UT'];

export const POSITION_NAMES = {
  GK: 'Goalkeeper',
  CF: 'Centre Forward',
  CD: 'Centre Defender',
  DR: 'Driver',
  WG: 'Wing',
  PT: 'Point',
  UT: 'Utility',
};

/**
 * Position-specific overall weights (section 9.5: "Do not calculate one universal
 * overall rating using identical weights for every position"). Weights need not
 * sum to one; the overall normalises.
 */
export const OVERALL_WEIGHTS = {
  GK: {
    setPositioning: 3, reactionSpeed: 3.4, lateralMovement: 2.6, verticalExplosion: 2.8,
    singleArmReach: 2.2, twoArmCoverage: 2.0, closeRange: 2.4, lobRecognition: 1.8,
    skipTracking: 2.4, reboundControl: 1.8, outletAccuracy: 1.4, pumpFakeDiscipline: 1.6,
    legPower: 1.6, wingspan: 1.4, anticipation: 2.2, concentration: 1.8, composure: 1.4,
  },
  CF: {
    upperStrength: 3.0, leverage: 3.0, balance: 2.2, bodyControl: 2.4, legPower: 2.0,
    ballSecurity: 2.4, oneHandCatch: 2.6, firstTouch: 2.2, wetPassControl: 1.6,
    backhand: 2.6, sweep: 2.4, quickRelease: 2.2, shootUnderContact: 2.8,
    shotPlacement: 1.8, anticipation: 1.6, composure: 1.6, workRate: 1.2,
  },
  CD: {
    centreDefence: 3.4, fronting: 3.0, legalLeverage: 2.8, upperStrength: 2.6,
    contactDiscipline: 2.4, foulDiscipline: 2.2, marking: 2.0, helpRecognition: 2.0,
    balance: 1.8, legPower: 1.8, blockTiming: 1.6, manDownAwareness: 1.6,
    tacticalAwareness: 1.8, communication: 1.4, endurance: 1.4,
  },
  DR: {
    swimSpeed: 3.0, firstStroke: 2.8, changeOfDirection: 2.6, explosiveness: 2.4,
    endurance: 2.2, workRate: 2.2, ballSecurity: 1.8, firstTouch: 1.8,
    quickRelease: 2.0, shotPlacement: 1.8, shootUnderContact: 1.6, anticipation: 1.8,
    decisionMaking: 1.8, recoveryDefence: 1.4, burstStamina: 2.0,
  },
  WG: {
    swimSpeed: 2.4, oneHandCatch: 2.4, shotPlacement: 2.6, skipControl: 2.4,
    lobControl: 2.0, weakHandShot: 1.6, quickRelease: 2.2, firstTouch: 2.0,
    changeOfDirection: 1.8, endurance: 1.8, anticipation: 1.6, laneDenial: 1.4,
    burstStamina: 1.6, releaseSpeed: 2.0,
  },
  PT: {
    vision: 3.0, decisionMaking: 2.8, longPass: 2.6, entryPass: 2.8, passVelocity: 2.0,
    shortPass: 2.0, tacticalAwareness: 2.6, composure: 2.2, leadership: 2.0,
    shotPower: 2.0, skipControl: 2.0, legPower: 1.8, verticalReach: 1.6,
    ballSecurity: 1.8, communication: 1.6,
  },
  UT: {
    swimSpeed: 2.0, endurance: 2.2, workRate: 2.2, adaptability: 2.6, ballSecurity: 1.8,
    shotPlacement: 1.8, marking: 1.8, helpRecognition: 1.8, tacticalAwareness: 2.0,
    upperStrength: 1.6, firstTouch: 1.8, quickRelease: 1.6, decisionMaking: 1.8,
    changeOfDirection: 1.8, balance: 1.6,
  },
};

/** Position-specific overall for one athlete, 1-99. */
export function overallFor(player, position = player.position) {
  const weights = OVERALL_WEIGHTS[position] ?? OVERALL_WEIGHTS.UT;
  let sum = 0;
  let wsum = 0;
  for (const [attr, w] of Object.entries(weights)) {
    sum += (player.attr[attr] ?? 50) * w;
    wsum += w;
  }
  return Math.round(sum / wsum);
}

/**
 * How well an athlete suits a role they were not trained for. Used by the tactics
 * screen and by the career mode's position-conversion training.
 */
export function roleSuitability(player, position) {
  if (position === player.position) return 1.0;
  if (position === player.secondaryPosition) return 0.88;
  if (player.position === 'GK' || position === 'GK') return 0.25;
  if (player.position === 'UT') return 0.82;
  const near = {
    CF: ['CD', 'UT'], CD: ['CF', 'UT'], DR: ['WG', 'UT', 'PT'],
    WG: ['DR', 'UT'], PT: ['DR', 'UT', 'WG'], UT: ['DR', 'WG', 'PT', 'CD'],
  };
  return (near[player.position] ?? []).includes(position) ? 0.75 : 0.6;
}

export const TRAITS = [
  { id: 'eliteLegs', name: 'Elite Legs', desc: 'Higher ceiling and slower decay on explosive elevation.' },
  { id: 'quickRelease', name: 'Quick Release', desc: 'Shortens shot preparation; less late aim correction.' },
  { id: 'skipSpecialist', name: 'Skip Specialist', desc: 'Tighter water-entry window on skip shots.' },
  { id: 'lobArtist', name: 'Lob Artist', desc: 'Reads goalkeeper depth and lofts with unusual accuracy.' },
  { id: 'backhandThreat', name: 'Backhand Threat', desc: 'Backhand finishes keep pace and placement under contact.' },
  { id: 'centreAnchor', name: 'Centre Anchor', desc: 'Holds inside water against stronger defenders.' },
  { id: 'foulMagnet', name: 'Foul Magnet', desc: 'Draws exclusions at a higher rate from legal leverage.' },
  { id: 'counterSprinter', name: 'Counter Sprinter', desc: 'Superior first stroke off a turnover.' },
  { id: 'outletCommander', name: 'Outlet Commander', desc: 'Long outlets keep velocity and accuracy.' },
  { id: 'longReachBlocker', name: 'Long-Reach Blocker', desc: 'Extended effective block radius when set.' },
  { id: 'defensiveOrganiser', name: 'Defensive Organizer', desc: 'Teammates rotate earlier and switch cleanly.' },
  { id: 'pressureResistant', name: 'Pressure Resistant', desc: 'Smaller penalty from defender proximity.' },
  { id: 'weakHandConfidence', name: 'Weak-Hand Confidence', desc: 'Reduced weak-hand penalty on pass and shot.' },
  { id: 'lateClock', name: 'Late-Clock Specialist', desc: 'Composure rises inside the last five seconds.' },
  { id: 'reboundHunter', name: 'Rebound Hunter', desc: 'Anticipates loose balls off the frame and keeper.' },
  { id: 'highMotor', name: 'High-Motor Driver', desc: 'Slower match-fatigue accumulation from repeated drives.' },
  { id: 'pumpFakeMaster', name: 'Pump-Fake Master', desc: 'Fakes hold their value longer against disciplined keepers.' },
  { id: 'penaltySpecialist', name: 'Penalty Specialist', desc: 'Composure and placement on five-metre throws.' },
];

export const TRAIT_BY_ID = Object.fromEntries(TRAITS.map((t) => [t.id, t]));
