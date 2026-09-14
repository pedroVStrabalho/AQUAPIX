/**
 * AQUAPIX progression economy (XP, Fans, Money).
 *
 * Every tunable number in the progression loop lives HERE and nowhere else, so
 * the whole economy can be rebalanced from one file without hunting through the
 * career, match and UI code.
 *
 * Design rules this file exists to enforce:
 *   - Normal play awards everything. There is no reward in this file that
 *     depends on watching an advertisement, and no code path here talks to any
 *     ad provider. Rewarded video, if it is ever switched on, may only ever
 *     MULTIPLY what these functions already returned.
 *   - Earnings follow performance, not luck: winning, goal difference, clean
 *     sheets, shooting accuracy and discipline all move the numbers.
 *   - Every value is derived from the match the player actually played, so a
 *     dull 1-0 and a wild 9-8 do not pay the same.
 */

export const GAME_ECONOMY_CONFIG = {
  /** Manager XP. Levels gate nothing yet; they are a progress spine. */
  xp: {
    perWin: 120,
    perDraw: 60,
    perLoss: 25,          // losing still teaches you something
    perGoalScored: 8,
    perGoalDifference: 10, // only when positive
    cleanSheet: 45,
    /** XP needed to go from level n to n+1. Gentle curve, no wall. */
    levelCurve: (level) => Math.round(400 * Math.pow(1.18, level - 1)),
    maxLevel: 50,
  },

  /** Supporters. Grow with success and spectacle, shrink slowly with failure. */
  fans: {
    perWin: 900,
    perDraw: 250,
    perLoss: -400,
    perGoalScored: 120,        // fans like goals
    perGoalConceded: -35,
    bigWinMargin: 4,           // margin at or above this is a statement
    bigWinBonus: 700,
    upsetBonus: 1200,          // beating a stronger club
    streakBonus: 350,          // per match of the current winning streak
    floor: 500,                // a club always has its diehards
  },

  /** Money. Gate receipts scale with support, so fans compound into budget. */
  money: {
    perWin: 2600,
    perDraw: 1700,
    perLoss: 700,              // you still get paid
    perGoalScored: 90,
    cleanSheet: 500,
    streakBonus: 300,          // per match of the current winning streak
  },

  /**
   * Running a water polo club, day by day.
   *
   * A club spends money on ordinary Tuesdays, not only on match days. Wages,
   * pool time, physios and the office all tick over seven days a week, and a
   * fixture adds its own bill on top - stewards and officials at home, a coach
   * and often a hotel away. Every figure here is per DAY unless it says
   * otherwise, so the weekly ledger is just these rates multiplied out.
   */
  operations: {
    /** Per athlete, per day, scaled by their star rating. */
    wagePerStarPerDay: 34,
    /** Flat daily overheads that do not depend on squad size. */
    coachingStaffPerDay: 420,
    poolHirePerDay: 280,          // lane time, heating, chemicals, filtration
    medicalPerDay: 155,           // physio, strapping, rehab
    adminPerDay: 205,             // office, kit wash, admin staff
    daysPerRound: 7,

    matchDay: {
      /** Playing squad that travels to an away fixture. */
      travellingParty: 18,

      /** Home fixture: you host, so you staff the building. */
      homeStewarding: 620,
      homeOfficials: 340,
      homeMatchOps: 280,          // timing desk, water testing, laundry

      /** Away fixture: you move eighteen people across the map. */
      awayCoachHire: 480,         // fixed cost of the bus before a wheel turns
      awayCostPerKm: 1.9,         // fuel, driver, tolls - each way is charged
      awayMealsPerHead: 26,
      /** Beyond this distance the squad stays overnight. */
      hotelThresholdKm: 300,
      awayHotelPerHead: 115,
    },
  },

  /** Money coming in beyond the result itself. */
  income: {
    ticketPrice: 5,
    concessionsPerHead: 1.8,
    /** Share of your supporters who actually turn up to a home fixture. */
    baseAttendanceRate: 0.42,
    /** A winning run fills the stands. */
    attendancePerStreak: 0.05,
    maxAttendanceRate: 0.92,
    /** Sponsorship is paid weekly and scales with how big the club has grown. */
    sponsorshipBase: 5200,
    sponsorshipPerThousandFans: 150,
    /**
     * Merchandise and streaming. Paid every week, home or away, and scaled by
     * the supporter base rather than by seats - so a club whose support has
     * outgrown its pool still earns from it.
     */
    merchPerThousandFans: 90,
  },

  /**
   * Debt. Money can go negative - you simply owe it - but the board will not
   * watch that happen indefinitely.
   */
  debt: {
    weeksBeforeSack: 6,
    confidencePerWeek: 0.09,
  },

  /** Winning streaks multiply the whole payout, capped so it cannot run away. */
  streak: {
    bonusPerMatch: 0.06,
    maxMultiplier: 1.5,
  },
};

const CFG = GAME_ECONOMY_CONFIG;

/** Total XP required to have REACHED a given level from zero. */
export function xpForLevel(level) {
  let total = 0;
  for (let l = 1; l < level; l++) total += CFG.xp.levelCurve(l);
  return total;
}

/** Resolve a raw lifetime XP figure into a level and progress within it. */
export function levelFromXp(totalXp) {
  let level = 1;
  let remaining = Math.max(0, Math.round(totalXp));
  while (level < CFG.xp.maxLevel) {
    const need = CFG.xp.levelCurve(level);
    if (remaining < need) return { level, into: remaining, need };
    remaining -= need;
    level++;
  }
  return { level: CFG.xp.maxLevel, into: 0, need: 0 };
}

/**
 * Work out what a single match earned.
 *
 * @param {object} m
 *   @param {number} m.scored      goals the player's club scored
 *   @param {number} m.conceded    goals it conceded
 *   @param {boolean} m.home       was it a home fixture (gate receipts)
 *   @param {number} m.fans        current supporter count
 *   @param {number} m.streak      winning streak INCLUDING this match
 *   @param {boolean} [m.upset]    beat a club of higher prestige
 * @returns {{xp:number, fans:number, money:number, lines:Array, result:string}}
 *   `lines` is an itemised breakdown, ready to show on an earnings screen.
 */
export function computeMatchEarnings(m) {
  const scored = Math.max(0, m.scored | 0);
  const conceded = Math.max(0, m.conceded | 0);
  const won = scored > conceded;
  const drew = scored === conceded;
  const diff = scored - conceded;
  const cleanSheet = conceded === 0;
  const streak = won ? Math.max(1, m.streak | 0) : 0;

  const lines = [];
  let xp = 0, fans = 0, money = 0;

  const add = (label, dXp, dFans, dMoney) => {
    if (!dXp && !dFans && !dMoney) return;
    xp += dXp; fans += dFans; money += dMoney;
    lines.push({ label, xp: dXp, fans: dFans, money: dMoney });
  };

  // --- Result -------------------------------------------------------------
  if (won) add('Victory', CFG.xp.perWin, CFG.fans.perWin, CFG.money.perWin);
  else if (drew) add('Draw', CFG.xp.perDraw, CFG.fans.perDraw, CFG.money.perDraw);
  else add('Defeat', CFG.xp.perLoss, CFG.fans.perLoss, CFG.money.perLoss);

  // --- What happened in the water -----------------------------------------
  if (scored) {
    add(`${scored} goal${scored === 1 ? '' : 's'} scored`,
      scored * CFG.xp.perGoalScored,
      scored * CFG.fans.perGoalScored,
      scored * CFG.money.perGoalScored);
  }
  if (conceded) add(`${conceded} conceded`, 0, conceded * CFG.fans.perGoalConceded, 0);
  if (diff > 0) add('Goal difference', diff * CFG.xp.perGoalDifference, 0, 0);
  if (cleanSheet) add('Clean sheet', CFG.xp.cleanSheet, 0, CFG.money.cleanSheet);
  if (won && diff >= CFG.fans.bigWinMargin) add('Statement win', 0, CFG.fans.bigWinBonus, 0);
  if (won && m.upset) add('Upset the favourites', 0, CFG.fans.upsetBonus, 0);

  // --- Support and streak --------------------------------------------------
  if (streak > 1) {
    add(`${streak}-match winning run`, 0,
      streak * CFG.fans.streakBonus,
      streak * CFG.money.streakBonus);
  }


  // --- Streak multiplier on the whole payout -------------------------------
  let multiplier = 1;
  if (streak > 1) {
    multiplier = Math.min(
      CFG.streak.maxMultiplier,
      1 + (streak - 1) * CFG.streak.bonusPerMatch
    );
    xp = Math.round(xp * multiplier);
    fans = Math.round(fans * multiplier);
    money = Math.round(money * multiplier);
  }

  return {
    xp: Math.round(xp),
    fans: Math.round(fans),
    money: Math.round(money),
    multiplier,
    lines,
    result: won ? 'win' : drew ? 'draw' : 'loss',
  };
}

/**
 * Apply earnings to a running progression wallet, keeping fans above the floor
 * and recomputing the level. Returns what actually changed, so the UI can count
 * from the old numbers to the new ones.
 */
export function applyEarnings(wallet, earned) {
  const before = { xp: wallet.xp, fans: wallet.fans, money: wallet.money, level: wallet.level };
  wallet.xp = Math.max(0, Math.round(wallet.xp + earned.xp));
  wallet.fans = Math.max(GAME_ECONOMY_CONFIG.fans.floor, Math.round(wallet.fans + earned.fans));
  // Deliberately NOT floored at zero: a club can be in debt, and the board
  // reacts to that. Flooring it here would hide the whole debt mechanic.
  wallet.money = Math.round(wallet.money + earned.money);
  const lv = levelFromXp(wallet.xp);
  wallet.level = lv.level;
  wallet.xpIntoLevel = lv.into;
  wallet.xpForNext = lv.need;
  return { before, after: { ...wallet }, levelledUp: wallet.level > before.level };
}

/** A fresh wallet for a newly appointed manager. */
export function newWallet(club) {
  const lv = levelFromXp(0);
  return {
    xp: 0,
    level: lv.level,
    xpIntoLevel: lv.into,
    xpForNext: lv.need,
    fans: Math.round((club?.prestige ?? 75) * 120),
    money: Math.round((club?.prestige ?? 75) * 1800),
    streak: 0,
    bestStreak: 0,
  };
}


/**
 * Work out a week of club operations: what it costs to exist for seven days,
 * plus the bill for that week's fixture, plus what came through the gate.
 *
 * @param {object} w
 *   @param {Array}   w.squad        the full squad (for the wage bill)
 *   @param {number}  w.squadStars   average star rating of the first seven
 *   @param {boolean} w.home         is this week's fixture at home
 *   @param {number}  w.distanceKm   travel distance for an away fixture
 *   @param {number}  w.fans         supporter base
 *   @param {number}  w.capacity     home venue capacity
 *   @param {number}  w.streak       current winning streak
 *   @param {string}  [w.opponent]   opponent name, for the ledger text
 * @returns {{lines:Array, costs:number, income:number, net:number, attendance:number}}
 */
export function computeWeeklyOperations(w) {
  const OP = CFG.operations;
  const IN = CFG.income;
  const days = OP.daysPerRound;
  const lines = [];
  let costs = 0, income = 0;

  const spend = (label, detail, amount) => {
    if (!amount) return;
    costs += amount;
    lines.push({ label, detail, money: -Math.round(amount), kind: 'cost' });
  };
  const earn = (label, detail, amount) => {
    if (!amount) return;
    income += amount;
    lines.push({ label, detail, money: Math.round(amount), kind: 'income' });
  };

  // --- Seven ordinary days -------------------------------------------------
  const squadSize = Math.max(1, w.squad?.length ?? 14);
  const wagePerDay = squadSize * (w.squadStars ?? 3) * OP.wagePerStarPerDay;
  spend('Player wages', `${squadSize} players · ${days} days × $${Math.round(wagePerDay).toLocaleString()}`,
    wagePerDay * days);
  spend('Coaching staff', `${days} days × $${OP.coachingStaffPerDay}`, OP.coachingStaffPerDay * days);
  spend('Pool hire and heating', `${days} days × $${OP.poolHirePerDay}`, OP.poolHirePerDay * days);
  spend('Medical and physio', `${days} days × $${OP.medicalPerDay}`, OP.medicalPerDay * days);
  spend('Admin and kit', `${days} days × $${OP.adminPerDay}`, OP.adminPerDay * days);

  // --- Match day -----------------------------------------------------------
  const MD = OP.matchDay;
  if (w.home) {
    spend('Stewarding and security', 'home fixture', MD.homeStewarding);
    spend('Match officials', 'home fixture', MD.homeOfficials);
    spend('Match operations', 'timing desk, water testing, laundry', MD.homeMatchOps);

    // Gate: your supporters, capped by the building.
    const rate = Math.min(
      IN.maxAttendanceRate,
      IN.baseAttendanceRate + Math.max(0, w.streak ?? 0) * IN.attendancePerStreak
    );
    const attendance = Math.min(w.capacity ?? 3500, Math.round((w.fans ?? 0) * rate));
    earn('Ticket sales', `${attendance.toLocaleString()} in · $${IN.ticketPrice} each`,
      attendance * IN.ticketPrice);
    earn('Concessions', `${attendance.toLocaleString()} × $${IN.concessionsPerHead}`,
      attendance * IN.concessionsPerHead);

    earn('Sponsorship', 'weekly retainer', sponsorship());
    earn('Merchandise and streaming', `${Math.round((w.fans ?? 0) / 1000)}k supporters`, merch());

    return finish(attendance);
  }

  // Away: move the party across the map. Charged both ways.
  const km = Math.max(0, Math.round(w.distanceKm ?? 0));
  const party = MD.travellingParty;
  spend('Team coach', `${km} km each way`, MD.awayCoachHire + km * 2 * MD.awayCostPerKm);
  spend('Meals on the road', `${party} × $${MD.awayMealsPerHead}`, party * MD.awayMealsPerHead);
  if (km > MD.hotelThresholdKm) {
    spend('Overnight stay', `${party} beds · ${km} km away`, party * MD.awayHotelPerHead);
  }

  earn('Sponsorship', 'weekly retainer', sponsorship());
  earn('Merchandise and streaming', `${Math.round((w.fans ?? 0) / 1000)}k supporters`, merch());

  return finish(0);

  function sponsorship() {
    return IN.sponsorshipBase + (w.fans ?? 0) / 1000 * IN.sponsorshipPerThousandFans;
  }
  function merch() {
    return (w.fans ?? 0) / 1000 * IN.merchPerThousandFans;
  }

  function finish(attendance) {
    return {
      lines,
      costs: Math.round(costs),
      income: Math.round(income),
      net: Math.round(income - costs),
      attendance,
      days,
    };
  }
}
