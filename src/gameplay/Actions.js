/**
 * Passing, catching and shooting resolution (Design Bible sections 13 and 14).
 *
 * Every outcome here is computed from the listed contributing factors - aim,
 * power, release timing, elevation, shoulder orientation, dominant hand, player
 * attributes, fatigue, ball control, defender proximity, goalkeeper position,
 * water contact, distance and angle - and every one of those factors is reported
 * back in the returned record so the HUD, the replay overlay and the post-match
 * analysis can explain *why* something happened (section 3: the game must never
 * feel as though it secretly decided an outcome).
 */

import { clamp, clamp01, lerp, smoothstep, angleDelta, dist2, segmentPointDistance } from '../core/Math2.js';

const a01 = (v) => clamp01((v - 10) / 85);

export const SHOT_TYPES = {
  POWER: 'power',
  QUICK: 'quick',
  CATCH_AND_SHOOT: 'catchAndShoot',
  SKIP: 'skip',
  BOUNCE: 'bounce',
  LOB: 'lob',
  SIDEARM: 'sidearm',
  CROSS_CAGE: 'crossCage',
  NEAR_POST: 'nearPost',
  BACKHAND: 'backhand',
  SWEEP: 'sweep',
  CENTRE_TURN: 'centreTurn',
  POP: 'pop',
  WEAK_HAND: 'weakHand',
  DELAYED: 'delayed',
  PENALTY: 'penalty',
  DESPERATION: 'desperation',
};

export const PASS_TYPES = {
  DRY: 'dry',
  HIGH_DRY: 'highDry',
  DRIVEN: 'driven',
  WET: 'wet',
  LEAD: 'lead',
  ENTRY: 'entry',
  CROSS: 'cross',
  SKIP: 'skipPass',
  OUTLET: 'outlet',
  ONE_TOUCH: 'oneTouch',
  SAFETY: 'safety',
  LOB_RELEASE: 'lobRelease',
  /** A high, soft pass lofted over a defender's reach. The lob control was
   *  bound to this type but the type itself was never defined, so the modifier
   *  resolved to `undefined` and threw an ordinary flat pass. */
  LOB: 'lobPass',
  RESTART: 'restart',
  GK_OUTLET: 'gkOutlet',
};

// ---------------------------------------------------------------------------
// Pressure and orientation helpers
// ---------------------------------------------------------------------------

/** Defensive pressure on an athlete: 0 = free, 1 = smothered. */
export function pressureOn(athlete, opponents) {
  let p = 0;
  for (const d of opponents) {
    if (!d.inPool || d.isGoalkeeper) continue;
    const dd = dist2(athlete.pos, d.pos);
    if (dd > 2.6) continue;
    // A defender in front of the throwing shoulder matters far more than one behind.
    const ang = Math.atan2(d.pos.x - athlete.pos.x, d.pos.z - athlete.pos.z);
    const front = clamp01(1 - Math.abs(angleDelta(athlete.shoulder, ang)) / Math.PI);
    const arm = clamp01(d.armRaised * 0.6 + 0.4);
    const near = clamp01(1 - (dd - 0.55) / 2.05);
    p = Math.max(p, near * lerp(0.35, 1, front) * arm * lerp(0.7, 1.15, d.elevation / 0.6));
  }
  if (athlete.has('pressureResistant')) p *= 0.72;
  return clamp01(p);
}

/** Is the passing lane between two points open? Returns 0..1 plus the threat. */
export function laneOpenness(from, to, opponents, exclude = null) {
  let worst = 1;
  let threat = null;
  for (const d of opponents) {
    if (!d.inPool || d === exclude) continue;
    const s = segmentPointDistance(from.x, from.z, to.x, to.z, d.pos.x, d.pos.z);
    if (s.t <= 0.02 || s.t >= 0.995) continue;
    // Reach grows with raised arm and elevation.
    const reach = d.reach * (0.62 + 0.55 * d.armRaised) + d.elevation * 0.5;
    const clearance = clamp01((s.dist - reach) / 1.15);
    if (clearance < worst) { worst = clearance; threat = d; }
  }
  return { open: worst, threat };
}

// ---------------------------------------------------------------------------
// Passing
// ---------------------------------------------------------------------------


/**
 * The rise a throw needs to ARRIVE, against the ball's real air drag.
 *
 * A drag-free ballistic solve is not good enough here. The ball carries
 * quadratic drag (k ~ 0.026 v^2, about 6 m/s^2 at 15 m/s) and that damps the
 * VERTICAL speed as well, so the ball tops out lower and drops earlier than the
 * clean parabola predicts. Measured in an empty pool with a stationary
 * receiver, passes were landing a metre short of the man every single time -
 * the "ball stops in the middle" - and only 43-70% were caught.
 *
 * So the trajectory is integrated with the same drag the ball itself uses, and
 * the launch rise is searched for: the smallest rise that still has the ball at
 * or above the receiver's hands when it gets there.
 */
const THROW_DRAG_K = 0.0259;   // 0.5 * rho_air * Cd * A / m, matching Ball.js

function riseToArrive(y0, targetY, flat, horiz) {
  const fly = (vy) => {
    let x = 0, y = y0, vx = horiz, v = vy;
    const dt = 1 / 120;
    for (let i = 0; i < 480; i++) {
      const sp = Math.hypot(vx, v) || 1e-6;
      const damp = 1 / (1 + THROW_DRAG_K * sp * dt);
      v = (v - 9.81 * dt) * damp;
      vx *= damp;
      x += vx * dt;
      y += v * dt;
      if (x >= flat) return { arrived: true, y };
      if (y <= 0.02) return { arrived: false, y };
    }
    return { arrived: false, y };
  };
  let lo = 0, hi = 11;
  if (fly(hi).arrived === false && fly(hi).y < targetY) return hi;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const r = fly(mid);
    if (r.arrived && r.y >= targetY) hi = mid; else lo = mid;
  }
  return hi;
}

/**
 * Resolve a pass. Returns a record describing the launch and the factors used.
 * The caller launches the ball; this function does not mutate world state beyond
 * the passer's action timers.
 *
 * @param {import('./Athlete.js').Athlete} passer
 * @param {{x:number,z:number}} target aim point on the water plane
 * @param {object} opts { type, power (0..1), receiver, opponents, rng, assist }
 */
export function resolvePass(passer, target, opts) {
  const { type = PASS_TYPES.DRY, power = 0.6, opponents = [], rng, receiver = null, assist = 0.5 } = opts;
  const attr = passer.player.attr;
  const from = passer.handPoint();

  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const distance = Math.hypot(dx, dz);

  const wet = type === PASS_TYPES.WET || type === PASS_TYPES.LEAD;
  const isLong = distance > 9;

  // --- Contributing factors (section 13.2) ------------------------------
  const factors = {
    distance,
    passType: type,
    facing: passer.facingQuality(target.x, target.z),
    elevation: clamp01(passer.elevation / Math.max(0.2, passer.maxElevation)),
    freshness: passer.freshness,
    pressure: pressureOn(passer, opponents),
    wetBall: passer.hasBall ? 0.55 : 0.85,
    weakHand: 0,
    control: a01(isLong ? attr.longPass : attr.shortPass),
    technique: a01(wet ? attr.wetPassControl : attr.dryPassControl),
    velocityAttr: a01(attr.passVelocity),
    vision: a01(attr.vision),
  };

  if (type === PASS_TYPES.ENTRY) factors.control = lerp(factors.control, a01(attr.entryPass), 0.75);
  if (type === PASS_TYPES.OUTLET || type === PASS_TYPES.GK_OUTLET) {
    factors.control = lerp(factors.control, a01(passer.isGoalkeeper ? attr.outletAccuracy : attr.outletPass), 0.8);
    if (passer.has('outletCommander')) factors.control = clamp01(factors.control + 0.12);
  }

  // Throwing across the body with the weak hand costs accuracy and velocity.
  const targetSide = Math.sign(
    Math.sin(passer.shoulder) * (target.z - passer.pos.z) - Math.cos(passer.shoulder) * (target.x - passer.pos.x)
  );
  if (targetSide === -passer.hand) {
    factors.weakHand = lerp(0.32, 0.08, a01(attr.weakHandControl)) * (passer.has('weakHandConfidence') ? 0.6 : 1);
  }

  // --- Velocity ----------------------------------------------------------
  const baseSpeed = lerp(7.5, 15.5, factors.velocityAttr) * lerp(0.55, 1.12, power);
  let speed = baseSpeed
    * lerp(0.68, 1.0, factors.facing)
    * lerp(0.74, 1.0, factors.freshness)
    * lerp(1.0, 0.82, factors.pressure)
    * (1 - factors.weakHand * 0.5)
    * lerp(0.86, 1.05, factors.elevation);

  if (type === PASS_TYPES.DRIVEN) speed *= 1.22;
  if (type === PASS_TYPES.SAFETY) speed *= 0.72;
  if (type === PASS_TYPES.WET) speed *= 0.92;
  if (type === PASS_TYPES.LOB_RELEASE) speed *= 0.7;


  // --- Accuracy ----------------------------------------------------------
  // Error is an angle, so long passes miss by more metres from the same skill.
  let errRad = lerp(0.155, 0.017, factors.control * 0.6 + factors.technique * 0.4)
    * lerp(1.55, 1.0, factors.facing)
    * lerp(1.5, 1.0, factors.freshness)
    * (1 + factors.pressure * 0.95)
    * (1 + factors.weakHand * 2.2)
    * lerp(1.18, 0.92, factors.elevation);

  // Assistance profiles bend the aim toward a legal receiver but never guarantee it.
  errRad *= lerp(1.0, 0.42, clamp01(assist));

  const yaw = Math.atan2(dx, dz) + rng.gauss(0, errRad);
  const distErr = 1 + rng.gauss(0, errRad * 0.8);

  // --- Flight shape ------------------------------------------------------
  let launchY, rise;
  const targetY = wet ? 0.12 : lerp(0.55, 1.25, factors.elevation);
  const flightTime = Math.max(0.12, (distance * distErr) / Math.max(4, speed));
  // Ballistic solve for the vertical component to arrive at targetY.
  rise = (targetY - from.y) / flightTime + 0.5 * 9.81 * flightTime;
  if (type === PASS_TYPES.HIGH_DRY || type === PASS_TYPES.LOB_RELEASE) rise += 2.4;
  if (type === PASS_TYPES.SKIP) rise -= 1.1;
  if (wet) rise = Math.min(rise, 1.4);
  launchY = rise;

  // The ball carries real air drag, but the vertical solve above is a drag-FREE
  // ballistic one: it picks an arc that would arrive at `distance` if the ball
  // never slowed down. It does slow down, so the arc hit the water short every
  // single time - measured in an empty pool with a stationary receiver, a 12m
  // pass died at 9.7m and only 70% of passes reached anybody at all. That is the
  // "ball stops in the middle" you see in play, and no defender is involved.
  //
  // Compensate both levers: throw it harder AND flatten the arc against a longer
  // real flight time, so the ball arrives in the receiver's hands.
  const dragComp = 1 + clamp(distance * 0.026, 0.12, 0.40);
  let horiz = speed * dragComp;

  // A direct pass is thrown FLAT. Solving the arc ballistically for a given
  // flight time means a longer pass needs more and more lift - an 8m pass came
  // out with 3.9 m/s of rise, an arc peaking around 0.8m, which looks like a
  // small lob. The lob is its own key (C) and a direct pass on Z must never
  // impersonate it. So the arc is capped low and the throw is made fast enough
  // to arrive inside that flat trajectory instead.
  if (type !== PASS_TYPES.LOB) {
    const flat = distance * distErr;
    // How hard this athlete actually throws it. Capping every pass at a single
    // speed made a soft pass and a driven one identical beyond about six
    // metres, which is why power stopped mattering at all.
    const PASS_SPEED_CAP = 15.5;   // a pass must never outrun a shot
    horiz = clamp(horiz, 4, PASS_SPEED_CAP);
    // ...and the rise that gets it there at that speed, against real drag.
    //
    // Arriving at hand height measured best: lofting it above his hands to keep
    // it over the traffic cut interceptions but cost more completions than it
    // saved, because the ball then drops behind him and has to be chased.
    launchY = riseToArrive(from.y, targetY, flat, horiz);
    if (type === PASS_TYPES.HIGH_DRY || type === PASS_TYPES.LOB_RELEASE) launchY += 2.4;
    if (type === PASS_TYPES.SKIP) launchY = Math.max(0, launchY - 1.1);
    if (wet) launchY = Math.min(launchY, 1.4);
  }

  // A genuine lob: a slow, high ball dropped over a defender's reach and INTO
  // the receiver's hands. It is solved as its own trajectory rather than by
  // adding lift to a flat pass - adding lift alone keeps the flat horizontal
  // speed, so the ball simply sails long past the target.
  if (type === PASS_TYPES.LOB) {
    const flatDist = distance * distErr;
    // Solve from the APEX, not from a flight time. Scaling the arc off distance
    // meant a short lob barely cleared the water (measured 0.48m), which is not
    // a lob at all - the whole point is to clear a defender's raised arm, and
    // that height is the same whether the receiver is three metres away or ten.
    const apex = clamp(1.5 + flatDist * 0.10, 1.5, 3.0);
    const rise0 = Math.max(0.25, apex - from.y);
    // The ball carries real air drag, which a pure ballistic solve ignores:
    // measured, a drag-free 1.37m arc only reached 0.77m in flight. Compensate
    // so the lob clears what it is aimed to clear.
    const DRAG_COMP = 1.45;
    const vy = Math.sqrt(2 * 9.81 * rise0) * DRAG_COMP;
    const fall = Math.sqrt(2 * Math.max(0.05, apex - targetY) / 9.81);
    const lobTime = Math.max(0.45, vy / 9.81 + fall);
    horiz = flatDist / lobTime;
    launchY = vy;
  }

  const vel = { x: Math.sin(yaw) * horiz, y: launchY, z: Math.cos(yaw) * horiz };
  const spin = { x: Math.cos(yaw) * (wet ? 8 : 14), y: rng.gauss(0, 3), z: -Math.sin(yaw) * (wet ? 8 : 14) };

  const lane = laneOpenness(passer.pos, target, opponents, null);

  return {
    from, vel, spin, type, factors, distance,
    laneOpen: lane.open,
    interceptor: lane.threat,
    receiver,
    aimError: errRad,
    quality: clamp01(0.5 * factors.control + 0.25 * factors.facing + 0.25 * (1 - factors.pressure)),
  };
}

/**
 * Resolve a receiver's attempt to take the ball (section 13.4). The full outcome
 * ladder is present: a difficult pass does not automatically fail, it creates a
 * harder receiving action.
 */
export function resolveCatch(receiver, ball, rng, opts = {}) {
  const attr = receiver.player.attr;
  const relSpeed = ball.speed;
  const hand = receiver.handPoint();
  const gap = ball.distanceTo(hand.x, hand.y, hand.z);

  const factors = {
    gap,
    ballSpeed: relSpeed,
    catchSkill: a01(attr.oneHandCatch) * 0.6 + a01(attr.firstTouch) * 0.4,
    balance: a01(attr.balance),
    freshness: receiver.freshness,
    pressure: opts.pressure ?? 0,
    elevation: clamp01(receiver.elevation / Math.max(0.2, receiver.maxElevation)),
    facing: receiver.facingQuality(ball.pos.x, ball.pos.z),
    wetCatch: ball.pos.y < 0.28,
    weakSide: 0,
  };

  const targetSide = Math.sign(
    Math.sin(receiver.shoulder) * (ball.pos.z - receiver.pos.z) - Math.cos(receiver.shoulder) * (ball.pos.x - receiver.pos.x)
  );
  if (targetSide === -receiver.hand) factors.weakSide = lerp(0.22, 0.05, a01(attr.weakHandControl));

  // Elite athletes catch almost everything that is thrown at them properly; the
  // interesting failures come from pressure, speed, reach and the weak side.
  // Seven penalties multiplied together fall away faster than any one of them
  // suggests: a receiver who was turning, a little tired and marked came out
  // around 0.6, so he fumbled a routine pass two times in five. Measured over
  // real matches, 14% of EVERY pass ended with the receiver knocking his own
  // ball into the water - from the player's seat, the ball "stopping in the
  // middle" just short of the man. An open athlete in clear water catches what
  // is thrown to him; pressure, speed and reach still cost, but they no longer
  // stack into a coin flip.
  let p = 0.90 + 0.09 * factors.catchSkill;
  p *= lerp(0.86, 1.0, factors.facing);
  p *= lerp(0.92, 1.0, factors.freshness);
  p *= 1 - factors.pressure * 0.22;
  p *= 1 - factors.weakSide * 0.5;
  p *= lerp(1.0, 0.90, clamp01((relSpeed - 13) / 10));  // a driven pass is harder
  p *= lerp(1.0, 0.88, clamp01((gap - 0.55) / 0.95));   // reach catches are harder
  if (factors.wetCatch) p *= lerp(0.92, 1.0, a01(attr.wetPassControl));
  if (receiver.hasBall) p = 1;
  p = clamp01(p);

  const roll = rng.next();
  let outcome;
  // The ways a catch can FAIL scale with how hard the catch was. Fixed-width
  // failure bands meant a wide-open receiver still dropped one pass in five,
  // which made dropped passes the single largest source of turnovers in the
  // match - two thirds of them. A free player in clear water keeps the ball.
  const fail = 1 - p;
  if (roll < p * 0.70) outcome = factors.wetCatch ? 'wetCollection' : (gap > 0.55 ? 'reachCatch' : 'clean');
  else if (roll < p) outcome = factors.elevation > 0.5 ? 'highCatch' : 'delayedControl';
  else if (roll < p + fail * 0.62) outcome = 'bobble';   // stays at his hands
  else if (roll < p + fail * 0.78) outcome = 'deflection';
  else outcome = 'drop';

  // A delayed control is still a catch - the athlete simply needs an extra beat
  // before they can do anything with it, which the caller applies as a lock.
  const controlled = outcome === 'clean' || outcome === 'reachCatch' ||
    outcome === 'wetCollection' || outcome === 'highCatch' || outcome === 'delayedControl';

  return { outcome, probability: p, factors, controlled };
}

// ---------------------------------------------------------------------------
// Shooting
// ---------------------------------------------------------------------------

/**
 * Aim point on the goal mouth. `aim` is a normalised (-1..1, 0..1) offset chosen
 * by the right stick, by the mouse, or by the assistance layer.
 */
export function goalAimPoint(profile, attackDir, aim) {
  const f = profile.field;
  const gz = attackDir * (f.length / 2);
  const x = clamp(aim.x, -1, 1) * (f.goalWidth / 2 - 0.14);
  const y = clamp(aim.y, -0.05, 1) * (f.goalHeight - 0.12) + 0.06;
  return { x, y, z: gz };
}

/**
 * Resolve a shot (section 14.2). Returns the launch plus a full factor record and
 * an explainable shot-quality estimate (section 29.1).
 */
export function resolveShot(shooter, aimPoint, opts) {
  const {
    type = SHOT_TYPES.POWER, charge = 0.6, timing = 1, opponents = [], rng,
    goalkeeper = null, profile, breakaway = false,
  } = opts;
  const attr = shooter.player.attr;
  const from = shooter.handPoint();

  // Alone with the keeper on the counter: aim inside the posts, not at them.
  if (breakaway && profile?.field) {
    const half = profile.field.goalWidth / 2;
    aimPoint = { ...aimPoint, x: clamp(aimPoint.x, -half * 0.62, half * 0.62), y: clamp(aimPoint.y, 0.25, 0.75) };
  }

  const dx = aimPoint.x - from.x;
  const dy = aimPoint.y - from.y;
  const dz = aimPoint.z - from.z;
  const distance = Math.hypot(dx, dz);
  const angle = Math.abs(Math.atan2(aimPoint.x - shooter.pos.x, Math.abs(aimPoint.z - shooter.pos.z)));

  const targetSide = Math.sign(
    Math.sin(shooter.shoulder) * dz - Math.cos(shooter.shoulder) * dx
  );
  const weakHand = targetSide === -shooter.hand
    ? lerp(0.30, 0.07, a01(attr.weakHandShot)) * (shooter.has('weakHandConfidence') ? 0.6 : 1)
    : 0;

  const techAttr = {
    [SHOT_TYPES.SKIP]: attr.skipControl,
    [SHOT_TYPES.BOUNCE]: attr.skipControl,
    [SHOT_TYPES.LOB]: attr.lobControl,
    [SHOT_TYPES.BACKHAND]: attr.backhand,
    [SHOT_TYPES.SWEEP]: attr.sweep,
    [SHOT_TYPES.SIDEARM]: attr.sidearm,
    [SHOT_TYPES.CENTRE_TURN]: attr.backhand,
    [SHOT_TYPES.POP]: attr.quickRelease,
    [SHOT_TYPES.QUICK]: attr.quickRelease,
    [SHOT_TYPES.CATCH_AND_SHOOT]: attr.quickRelease,
    [SHOT_TYPES.PENALTY]: attr.penaltyComposure,
    [SHOT_TYPES.WEAK_HAND]: attr.weakHandShot,
  }[type] ?? attr.shotPlacement;

  const factors = {
    shotType: type,
    distance,
    angle,
    charge,
    timing,
    elevation: clamp01(shooter.elevation / Math.max(0.2, shooter.maxElevation)),
    shoulder: shooter.facingQuality(aimPoint.x, aimPoint.z),
    freshness: shooter.freshness,
    pressure: pressureOn(shooter, opponents),
    weakHand,
    power: a01(attr.shotPower),
    placement: a01(attr.shotPlacement),
    technique: a01(techAttr),
    release: a01(attr.releaseSpeed),
    underContact: a01(attr.shootUnderContact),
    lateClock: 0,
  };

  // Blocking arms in the flight path.
  const block = laneOpenness(shooter.pos, { x: aimPoint.x, z: aimPoint.z }, opponents);
  factors.blockOpen = block.open;
  factors.blocker = block.threat;

  // --- Ball speed --------------------------------------------------------
  let speed = lerp(11, 24.5, factors.power)
    * lerp(0.52, 1.06, charge)
    * lerp(0.62, 1.0, factors.elevation * 0.55 + 0.45)
    * lerp(0.72, 1.0, factors.freshness)
    * lerp(0.7, 1.0, factors.shoulder)
    * (1 - weakHand * 0.55)
    * lerp(1.0, lerp(0.72, 0.95, factors.underContact), factors.pressure);

  const typeSpeed = {
    [SHOT_TYPES.LOB]: 0.42, [SHOT_TYPES.QUICK]: 0.88, [SHOT_TYPES.POP]: 0.72,
    [SHOT_TYPES.BACKHAND]: 0.74, [SHOT_TYPES.SWEEP]: 0.8, [SHOT_TYPES.SIDEARM]: 0.9,
    [SHOT_TYPES.SKIP]: 0.98, [SHOT_TYPES.PENALTY]: 0.95, [SHOT_TYPES.DESPERATION]: 0.8,
    [SHOT_TYPES.CENTRE_TURN]: 0.78, [SHOT_TYPES.CATCH_AND_SHOOT]: 0.93,
  }[type] ?? 1;
  speed *= typeSpeed;

  // A shot must always leave the hand harder than a pass, whatever the body
  // position costs. Pressing SHOOT fires the instant the athlete is free, so the
  // release happens at zero elevation with the shoulders still turning - and the
  // stacked penalties for that were dragging a genuine shot below a soft pass.
  // The lob is the one shot that is MEANT to be slow, so it keeps its own speed.
  if (type !== SHOT_TYPES.LOB) {
    speed = Math.max(speed, 17.5 * lerp(0.92, 1.06, factors.power));
  }

  // --- Accuracy ----------------------------------------------------------
  // Perfect release timing produces the best version of the shot this athlete can
  // physically execute (section 14.4) - it never guarantees a goal.
  const timingBonus = lerp(0.55, 1.0, smoothstep(timing));
  // These are ANGULAR errors, and they compound. At the old figures an average
  // shooter's spread reached ~19 degrees, which at six metres is a two metre
  // miss against a goal three metres wide and only 0.9 m high - so roughly two
  // thirds of all shots missed the target entirely and scoring was throttled by
  // accuracy rather than by goalkeeping.
  let errRad = lerp(0.045, 0.007, factors.placement * 0.55 + factors.technique * 0.45)
    / timingBonus
    * lerp(1.18, 1.0, factors.shoulder)
    * lerp(1.35, 1.0, factors.freshness)
    * (1 + factors.pressure * (0.45 - 0.25 * factors.underContact))
    * (1 + weakHand * 1.9)
    * lerp(1.18, 0.92, factors.elevation);

  if (shooter.has('lateClock') && opts.shotClock != null && opts.shotClock < 5) {
    factors.lateClock = 1;
    errRad *= 0.82;
  }
  if (type === SHOT_TYPES.PENALTY) errRad *= lerp(1.35, 0.85, a01(attr.penaltyComposure)) * (shooter.has('penaltySpecialist') ? 0.85 : 1);
  if (type === SHOT_TYPES.DESPERATION) errRad *= 1.9;
  if (breakaway) errRad = Math.min(errRad, 0.02);   // ~6cm at three metres

  // --- Flight ------------------------------------------------------------
  const yaw = Math.atan2(dx, dz) + rng.gauss(0, errRad);
  const spin = { x: 0, y: 0, z: 0 };
  let vy;
  const flat = Math.hypot(dx, dz);
  const t = flat / Math.max(5, speed);

  if (type === SHOT_TYPES.LOB) {
    // Loft it over a keeper who has come up: aim for the crossbar's underside.
    const apex = 2.1 + rng.gauss(0, 0.16 * (1.4 - a01(attr.lobControl)));
    vy = (apex - from.y) / (t * 0.5) * 0.62 + 0.5 * 9.81 * t;
    spin.x = -Math.cos(yaw) * 9;
    spin.z = Math.sin(yaw) * 9;
  } else if (type === SHOT_TYPES.SKIP || type === SHOT_TYPES.BOUNCE) {
    // Drive it down into the water short of the line, with topspin so buoyancy
    // and Magnus throw it back up at the low corner.
    const skipDist = lerp(1.4, 3.4, a01(attr.skipControl)) * (shooter.has('skipSpecialist') ? 1.05 : 1);
    const toWater = Math.max(0.9, flat - skipDist);
    const tw = toWater / Math.max(5, speed);
    vy = (0.02 - from.y) / tw + 0.5 * 9.81 * tw;
    const topspin = lerp(28, 62, a01(attr.skipControl)) * lerp(0.7, 1.15, charge);
    spin.x = Math.cos(yaw) * topspin;
    spin.z = -Math.sin(yaw) * topspin;
    vy += rng.gauss(0, 0.42 * (1.3 - a01(attr.skipControl)));
  } else {
    vy = (aimPoint.y - from.y) / t + 0.5 * 9.81 * t + rng.gauss(0, errRad * 3.2);
    spin.x = Math.cos(yaw) * -12;
    spin.z = -Math.sin(yaw) * -12;
    spin.y = rng.gauss(0, 5);
  }

  const vel = { x: Math.sin(yaw) * speed, y: vy, z: Math.cos(yaw) * speed };

  // --- Explainable shot quality (section 29.1) ---------------------------
  const quality = shotQuality({
    distance, angle, profile,
    goalkeeper, shooter, factors,
  });

  return { from, vel, spin, type, factors, distance, angle, quality, aimPoint, aimError: errRad };
}

/**
 * Estimated shot quality, 0..1. Explicitly an *estimate*: it is displayed with
 * that label and never presented as certainty.
 */
export function shotQuality({ distance, angle, goalkeeper, shooter, factors, profile }) {
  const f = profile?.field;

  // Distance dominates, and it does so multiplicatively. In water polo a shot
  // from twelve metres is not "a slightly worse six metre shot" - it is a
  // different proposition entirely, and no amount of open water redeems it.
  // Roughly: 2 m -> 0.95, 5 m -> 0.62, 7 m -> 0.41, 9 m -> 0.24, 12 m -> 0.09.
  const distTerm = Math.exp(-Math.pow(Math.max(0, distance - 1.0) / 6.4, 1.6));

  // Angle: shooting from the wing is genuinely harder.
  const angleTerm = Math.pow(clamp01(1 - angle / 1.3), 0.8);

  // Goalkeeper: how much goal they are actually leaving open.
  // A correctly positioned keeper is beatable: the goal is three metres wide and
  // they are one person. This used to fall to nearly zero whenever the keeper sat
  // on their line and on the angle - which, once the keeper AI was fixed, was
  // ALWAYS - so the shot heuristic concluded no shot was ever worth taking and
  // the AI simply stopped shooting. The floor is what a shooter can still see
  // past a perfect keeper.
  let gkTerm = 0.5;
  if (goalkeeper) {
    const gz = f ? Math.sign(goalkeeper.pos.z) * f.length / 2 : goalkeeper.pos.z;
    const off = Math.abs(goalkeeper.pos.x - shooter.pos.x * 0.35);
    const depth = clamp01((Math.abs(gz - goalkeeper.pos.z) - 0.2) / 1.5);
    gkTerm = clamp01(0.34 + clamp01(off / 1.6) * 0.42 + depth * 0.3);
  }

  const execution = 0.80 + 0.20 * (
    0.45 * factors.elevation + 0.35 * factors.shoulder + 0.20 * factors.freshness
  );

  // Each of these penalties is reasonable alone, but they MULTIPLY: five modest
  // discounts stacked turned a good six metre shot into a 0.09. The floors keep
  // the combination survivable, so this stays on its documented scale of
  // "roughly the probability this ends in a goal".
  const q = distTerm
    * lerp(0.72, 1.0, angleTerm)
    * lerp(0.70, 1.0, gkTerm)
    * (1 - 0.35 * factors.pressure)
    * lerp(0.68, 1.0, clamp01(factors.blockOpen))
    * execution;

  return clamp01(q);
}

/**
 * Choose a shot type from context when the user has not explicitly asked for one.
 * Contextual inputs must be predictable (section 18.1): this only ever picks the
 * technique that the athlete's current body position actually permits.
 */
export function contextualShotType(shooter, distance, pressure, afterFake, fromCatch, goalkeeperUp) {
  if (shooter.pendingPenalty) return SHOT_TYPES.PENALTY;
  const facing = shooter.facingQuality(0, Math.sign(shooter.attackDir) * 20);
  if (facing < 0.35) return distance < 3.5 ? SHOT_TYPES.BACKHAND : SHOT_TYPES.SWEEP;
  if (distance < 2.4 && pressure > 0.45) return SHOT_TYPES.POP;
  if (distance < 3.2 && facing < 0.6) return SHOT_TYPES.CENTRE_TURN;
  // A lob is a rare, deliberate answer to a keeper who has genuinely charged out.
  // This used to read `goalkeeperUp && distance > 5.5`, where goalkeeperUp meant
  // "the keeper is more than 1m off its line" - which is true of a keeper simply
  // sitting where a keeper sits. So EVERY shot from beyond 5.5m was silently
  // turned into a lob, and a lob leaves the hand at 42% speed. That is why
  // shooting was slower than passing: measured, 6.5 m/s against a 10.3 m/s soft
  // pass. Shots from range are power shots unless the keeper is really stranded.
  if (goalkeeperUp && distance > 6.5 && distance < 11) return SHOT_TYPES.LOB;
  if (afterFake) return SHOT_TYPES.DELAYED;
  if (fromCatch) return SHOT_TYPES.CATCH_AND_SHOOT;
  if (shooter.elevation < shooter.maxElevation * 0.32 && distance > 5) return SHOT_TYPES.SIDEARM;
  return SHOT_TYPES.POWER;
}
