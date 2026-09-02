/**
 * Star-based match simulation for games the user chooses to SIM (not play).
 *
 * The winner is decided by each team's average star rating (1-5, from the best
 * seven), and the scoreline margin scales with the gap in star level. But upsets
 * happen: roughly one simmed match in four, the weaker team wins anyway - so a
 * season is never fully predictable.
 */

import { starRating } from '../data/DisplayStats.js';

/** Average star level (1..5) of a roster's best seven. */
export function teamStars(roster) {
  const seven = roster.slice().sort((a, b) => b.overall - a.overall).slice(0, 7);
  if (!seven.length) return 3;
  return seven.reduce((s, p) => s + starRating(p.overall), 0) / seven.length;
}

/**
 * Simulate a fixture from star levels.
 * @returns {{home:number, away:number, upset:boolean, hStars:number, aStars:number}}
 */
export function simulateByStars(homeRoster, awayRoster, rng) {
  const hStars = teamStars(homeRoster);
  const aStars = teamStars(awayRoster);
  const homeEdge = 0.15;                 // small home advantage in star terms
  const diff = (hStars + homeEdge) - aStars;
  const absGap = Math.abs(diff);

  // One simmed match in four is an upset - the team that "should" lose, wins.
  const upset = rng.chance(0.25);
  let favourite = diff >= 0 ? 'home' : 'away';
  if (absGap < 0.12) favourite = rng.chance(0.5) ? 'home' : 'away'; // near-level: coin flip
  const winner = upset ? (favourite === 'home' ? 'away' : 'home') : favourite;

  // Margin scales with the star gap (the scoreboard reflects the level gap).
  // A big upset produces a narrow win; a dominant favourite a wide one.
  const baseMargin = upset ? Math.max(1, Math.round(absGap * 0.9 + rng.range(0, 1)))
                           : Math.max(1, Math.round(absGap * 2.4 + rng.range(0, 1.6)));
  const margin = Math.min(baseMargin, 10);

  const loserGoals = rng.int(4, 9);
  const winnerGoals = loserGoals + margin;

  const home = winner === 'home' ? winnerGoals : loserGoals;
  const away = winner === 'home' ? loserGoals : winnerGoals;
  return { home, away, upset, hStars: +hStars.toFixed(2), aStars: +aStars.toFixed(2) };
}
