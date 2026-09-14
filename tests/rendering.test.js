/**
 * View geometry: the pool is drawn LANDSCAPE, and the controls must agree.
 *
 * The renderer's world-to-screen transform and Input2D's screen-to-world
 * mapping are two halves of the same rotation. When the view was turned a
 * quarter turn, forgetting the input half left the controls rotated 90 degrees
 * from the picture - so these assert the two stay in step.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// A canvas stub: the renderer only needs a 2D context shaped like the real one.
const ctxStub = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : (t[k] = typeof k === 'string' && k.startsWith('create')
    ? () => ({ addColorStop() {} }) : () => {})),
  set: (t, k, v) => { t[k] = v; return true; },
});
globalThis.window = { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1 };
Object.defineProperty(globalThis, 'navigator', { value: { maxTouchPoints: 0 }, configurable: true });
globalThis.document = { getElementById: () => null, createElement: () => ({ style: {}, getContext: () => ctxStub }) };

const { generateLeague } = await import('../src/data/Teams.js');
const { getProfile } = await import('../src/rules/RuleProfiles.js');
const { MatchSim, ASSIST_PROFILE } = await import('../src/core/MatchSim.js');
const { PixelRenderer } = await import('../src/render2d/PixelRenderer.js');

const league = generateLeague();

function renderer(cssW = 1440, cssH = 860) {
  const sim = new MatchSim({
    profile: getProfile('arcade'), league, homeId: 'tidal', awayId: 'kraken',
    seed: 3, difficulty: 'national', assist: ASSIST_PROFILE.STANDARD,
    refereeProfile: 'standard', userSide: 'home',
  });
  sim.start();
  const canvas = {
    style: {}, clientWidth: cssW, clientHeight: cssH,
    width: 0, height: 0, getContext: () => ctxStub,
  };
  const r = new PixelRenderer(canvas, sim);
  r.resize();
  return { r, sim };
}

test('the whole pool fits on screen, with no scrolling', () => {
  const { r, sim } = renderer();
  const f = sim.profile.field;
  assert.ok(r.fitsVertically, 'the view never needs to scroll');

  // Every corner of the pool must land inside the art buffer.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const p = r.worldToScreen(sx * f.width / 2, sz * f.length / 2);
      assert.ok(p.sx >= 0 && p.sx <= r.aw, `corner is on screen horizontally (${p.sx.toFixed(0)} of ${r.aw})`);
      assert.ok(p.sy >= 0 && p.sy <= r.ah, `corner is on screen vertically (${p.sy.toFixed(0)} of ${r.ah})`);
    }
  }
});

test('the pool is drawn landscape: its length runs across the screen', () => {
  const { r, sim } = renderer();
  const f = sim.profile.field;
  const goalA = r.worldToScreen(0, -f.length / 2);
  const goalB = r.worldToScreen(0, f.length / 2);
  const sideA = r.worldToScreen(-f.width / 2, 0);
  const sideB = r.worldToScreen(f.width / 2, 0);

  const goalSpanX = Math.abs(goalA.sx - goalB.sx);
  const goalSpanY = Math.abs(goalA.sy - goalB.sy);
  assert.ok(goalSpanX > goalSpanY * 4,
    'the goals sit left and right of each other, not above and below');

  const widthSpanY = Math.abs(sideA.sy - sideB.sy);
  assert.ok(widthSpanY > Math.abs(sideA.sx - sideB.sx) * 4,
    'the pool width runs down the screen');

  // And it genuinely uses the screen: the pool should be wider than it is tall.
  assert.ok(goalSpanX > widthSpanY, 'the drawn pool is landscape');
});

test('the controls are not rotated relative to the picture', async () => {
  const { Input2D } = await import('../src/ui/Input2D.js');
  const { r, sim } = renderer();
  const input = new Input2D(sim, { renderer: r });

  // Press RIGHT; the resulting world direction must move an athlete toward
  // increasing screen x in the renderer's own transform.
  const me = sim.activeAthletes('home').find((a) => !a.isGoalkeeper);
  sim.setUserAthlete(me);
  input.down.add('right');
  const cmd = input.update(1 / 60);
  input.down.clear();
  assert.ok(cmd.dir, 'a direction was produced');

  const here = r.worldToScreen(me.pos.x, me.pos.z);
  const there = r.worldToScreen(me.pos.x + cmd.dir.x, me.pos.z + cmd.dir.z);
  assert.ok(there.sx - here.sx > 0.5,
    'pressing RIGHT moves the athlete right on screen');
  assert.ok(Math.abs(there.sy - here.sy) < Math.abs(there.sx - here.sx),
    'and mostly horizontally, not vertically');
});
