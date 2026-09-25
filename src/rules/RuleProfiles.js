/**
 * AQUASTRIKE - Versioned rules profiles (Design Bible section 7.1 / 7.2).
 *
 * All match rules live in data, never scattered through gameplay code. A profile is
 * a plain object so it can be serialised into a save game, sent over the network,
 * diffed in the rule editor, and displayed in the match HUD.
 *
 * Regulatory reference: World Aquatics Competition Regulations, February 2026.
 */

/** @typedef {ReturnType<typeof makeProfile>} RuleProfile */

const BASE = {
  id: 'base',
  name: 'Base',
  governingBody: 'Unspecified',
  effectiveDate: '1900-01-01',

  // --- Field ---------------------------------------------------------------
  field: {
    length: 25.0, // metres between goal lines
    width: 20.0,
    minDepth: 2.0,
    goalWidth: 3.0,
    goalHeight: 0.9, // above water surface
    penaltyLine: 5.0, // metres from goal line
    restrictedLine: 2.0, // "two metre" line
    frontCourtLine: 6.0, // six metre line
    centreLine: 0.0,
  },

  // --- Squad ---------------------------------------------------------------
  squad: {
    maxRoster: 14,
    activePlayers: 7, // 6 field + 1 goalkeeper
    maxFieldPlayers: 7, // when the goalkeeper is pulled
    minGoalkeepers: 0, // may be removed after the match begins
    goalkeeperRequiredAtStart: true,
    capNumbersGoalkeeper: [1, 13],
  },

  // --- Timing --------------------------------------------------------------
  timing: {
    periods: 4,
    periodSeconds: 8 * 60,
    intervalSeconds: 120, // after periods 1 and 3
    halftimeSeconds: 300,
    timeoutsPerTeam: 2,
    timeoutSeconds: 60,
    normalPossession: 28,
    secondaryPossession: 18,
    exclusionSeconds: 18,
    // Time added to the game clock for dead-ball presentation, per restart type.
    restartDelay: { goal: 2.2, ordinary: 0.35, exclusion: 1.2, penalty: 2.5, neutral: 0.6 },
  },

  // --- Discipline ----------------------------------------------------------
  discipline: {
    personalFoulLimit: 3, // third personal foul => player excluded for the match
    exclusionEarlyReentry: true, // re-enter on goal / possession change
    penaltyDistance: 5.0,
    brutalityExclusionSeconds: 240,
    substituteAfterThirdFoul: true,
  },

  // --- Restart and possession semantics ------------------------------------
  restarts: {
    // A free throw taken outside the 6m line may be shot directly at goal.
    directShotOutside: 6.0,
    freeThrowMustBeImmediate: true,
    goalRestartFromCentre: true,
    swimOffAtPeriodStart: true,
    cornerThrowDistance: 2.0,
    goalThrowFromGoalLine: true,
  },

  substitution: {
    flying: true, // flying substitutions during live play
    reentryZoneLength: 2.0, // metres from own goal line
    onlyDuringStoppages: false,
  },

  shootout: {
    enabled: true,
    shootersPerTeam: 5,
    suddenDeath: true,
    fromPenaltyLine: true,
  },

  review: {
    videoReview: true,
    reviewableEvents: ['goal', 'penalty', 'brutality', 'clock'],
    coachChallenges: 1,
    challengeWindowSeconds: 8,
  },
};

function makeProfile(overrides) {
  return deepMerge(structuredClone(BASE), overrides);
}

function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      target[k] = deepMerge(target[k] ?? {}, v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/** World Aquatics, February 2026 competition regulations. The simulation default. */
export const WORLD_AQUATICS_2026 = makeProfile({
  id: 'wa-2026',
  name: 'World Aquatics 2026',
  governingBody: 'World Aquatics',
  effectiveDate: '2026-02-01',
});


/**
 * ARCADE - the default for playing. Four short periods, a snappy possession
 * clock and quick restarts, so a full match is about five minutes: long enough
 * to feel like a match, short enough to immediately play another.
 */
export const ARCADE = makeProfile({
  id: 'arcade',
  name: 'Short - 4 x 1 min',
  governingBody: 'AQUAPIX',
  effectiveDate: '2026-01-01',
  timing: {
    // Periods are short, but the possession clock is the REAL rule: 28 seconds
    // for a normal attack, 18 after an exclusion, a corner, or the attacking
    // team recovering its own shot.
    periodSeconds: 60,
    normalPossession: 28,
    secondaryPossession: 18,
    exclusionSeconds: 12,
    intervalSeconds: 6,
    halftimeSeconds: 10,
  },
});

/**
 * The same Arcade rules - snappy restarts, short breaks - at longer lengths.
 * Nobody plays a 32-minute match on a browser game, so the longest match on
 * offer is four periods of two and a half minutes: ten minutes of game clock.
 */
function arcadeOfLength(id, name, periodSeconds) {
  return makeProfile({
    ...structuredClone(ARCADE), id, name,
    timing: { ...structuredClone(ARCADE.timing), periodSeconds },
  });
}
export const ARCADE_MEDIUM = arcadeOfLength('arcade-8', 'Medium - 4 x 2 min', 120);
export const ARCADE_FULL = arcadeOfLength('arcade-10', 'Full - 4 x 2.5 min', 150);

/**
 * Longer and federation-style profiles. Kept as rules fixtures - the rules
 * engine is tested against them - but not offered in the menu: the owner set
 * ten minutes as the longest match anyone should be asked to play.
 */
export const QUICK_MATCH_6MIN = makeProfile({
  id: 'quick-6',
  name: 'Quick Match (6 min periods)',
  governingBody: 'World Aquatics (variant)',
  effectiveDate: '2026-02-01',
  timing: { periodSeconds: 6 * 60 },
});

export const QUICK_MATCH_4MIN = makeProfile({
  id: 'quick-4',
  name: 'Quick Match (4 min periods)',
  governingBody: 'World Aquatics (variant)',
  effectiveDate: '2026-02-01',
  timing: { periodSeconds: 4 * 60 },
});

export const QUICK_MATCH_2MIN = makeProfile({
  id: 'quick-2',
  name: 'Sprint Match (2 min periods)',
  governingBody: 'World Aquatics (variant)',
  effectiveDate: '2026-02-01',
  timing: { periodSeconds: 2 * 60 },
});

/** Youth profile: smaller field, shorter clock, more forgiving exclusion length. */
export const YOUTH_U16 = makeProfile({
  id: 'youth-u16',
  name: 'Youth U16',
  governingBody: 'Domestic federation (example)',
  effectiveDate: '2026-01-01',
  field: { length: 20.0, width: 15.0, penaltyLine: 5.0 },
  timing: { periodSeconds: 6 * 60, normalPossession: 30, exclusionSeconds: 20 },
  discipline: { personalFoulLimit: 3 },
  review: { videoReview: false, coachChallenges: 0 },
});

/** What the Quick Match screen offers, shortest first. Longest: 10 minutes. */
export const PLAYABLE_PROFILES = [ARCADE, ARCADE_MEDIUM, ARCADE_FULL];

export const PROFILES = {
  [ARCADE.id]: ARCADE,
  [ARCADE_MEDIUM.id]: ARCADE_MEDIUM,
  [ARCADE_FULL.id]: ARCADE_FULL,
  [WORLD_AQUATICS_2026.id]: WORLD_AQUATICS_2026,
  [QUICK_MATCH_6MIN.id]: QUICK_MATCH_6MIN,
  [QUICK_MATCH_4MIN.id]: QUICK_MATCH_4MIN,
  [QUICK_MATCH_2MIN.id]: QUICK_MATCH_2MIN,
  [YOUTH_U16.id]: YOUTH_U16,
};

export function getProfile(id) {
  const p = PROFILES[id];
  if (!p) throw new Error(`Unknown rules profile: ${id}`);
  return p;
}

export { makeProfile, deepMerge };
