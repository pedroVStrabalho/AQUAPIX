/**
 * Player Career screens - create-a-player, the life dashboard, training, the
 * shop, contracts, and the match hand-off. Registered onto the shared screen
 * manager so they slot in beside the other modes.
 */

import { registerScreen, shell, menuItem, chipRow, field, el } from '../ui/Screens.js';
import { TEAMS } from '../data/Teams.js';
import { POSITIONS, POSITION_NAMES } from '../data/Attributes.js';
import { headlineRows, STAT_COLORS, starString, teamLevel } from '../data/DisplayStats.js';
import { ACTIVITIES, SHOP } from './PlayerCareer.js';

function bar(label, value01, color, sub) {
  const wrap = el('div', 'lifebar');
  wrap.appendChild(el('span', 'lifebar-l', label));
  const b = el('div', 'lifebar-bar');
  const fill = el('i');
  fill.style.width = `${Math.max(0, Math.min(100, value01 * 100))}%`;
  fill.style.background = color;
  b.appendChild(fill);
  wrap.appendChild(b);
  wrap.appendChild(el('span', 'lifebar-v', sub ?? Math.round(value01 * 100)));
  return wrap;
}

registerScreen('playerCreate', (game, params, mgr) => shell('Create Your Player', (body) => {
  const draft = game.playerDraft ?? (game.playerDraft = { name: '', position: 'DR', clubId: 'zephyr', leftHanded: false });

  const saved = game.loadPlayerSave();
  if (saved) {
    const resume = el('div', 'menu-list');
    resume.appendChild(menuItem('Continue Your Career',
      `${saved.me.name} · ${TEAMS.find((t) => t.id === saved.clubId)?.name} · season ${saved.season}`,
      null, () => game.resumePlayerCareer(saved)));
    body.appendChild(resume);
  }

  const card = el('div', 'card');
  card.appendChild(el('h3', null, 'Who are you?'));

  // Name.
  const nameRow = el('div', 'field-row');
  nameRow.appendChild(el('div', 'field-label', 'Name'));
  const input = el('input');
  input.type = 'text'; input.placeholder = 'e.g. Alex Marsh'; input.value = draft.name;
  input.className = 'text-input';
  input.addEventListener('input', () => { draft.name = input.value; });
  const wrap = el('div', 'field-control'); wrap.appendChild(input);
  nameRow.appendChild(wrap);
  card.appendChild(nameRow);

  // Position.
  card.appendChild(field('Position', chipRow(
    POSITIONS.map((p) => ({ value: p, label: `${p} · ${POSITION_NAMES[p]}` })),
    draft.position, (v) => { draft.position = v; mgr.show('playerCreate'); })));

  // Handedness.
  card.appendChild(field('Handedness', chipRow(
    [{ value: false, label: 'Right' }, { value: true, label: 'Left' }],
    draft.leftHanded, (v) => { draft.leftHanded = v; mgr.show('playerCreate'); })));

  body.appendChild(card);

  // Club selection.
  const clubCard = el('div', 'card');
  clubCard.style.marginTop = '14px';
  clubCard.appendChild(el('h3', null, 'Sign for a club — weaker clubs give you a start, stronger clubs are a challenge'));
  const grid = el('div', 'grid grid-4');
  for (const t of [...TEAMS].sort((a, b) => a.prestige - b.prestige)) {
    const c = el('div', 'card team-card');
    c.style.setProperty('--team', t.colors.primary);
    if (t.id === draft.clubId) c.classList.add('selected');
    c.appendChild(el('div', 'tc-name', t.short));
    c.appendChild(el('div', 'tc-city', t.name));
    c.appendChild(el('div', 'mi-desc', `Team level ${teamLevel(game.league.rosters[t.id])} · prestige ${t.prestige}`));
    c.addEventListener('click', () => { draft.clubId = t.id; mgr.show('playerCreate'); });
    grid.appendChild(c);
  }
  clubCard.appendChild(grid);
  body.appendChild(clubCard);

  const a = el('div', 'actions');
  const start = el('button', 'btn', 'Begin Career');
  start.addEventListener('click', () => {
    if (!draft.name.trim()) draft.name = 'Alex Marsh';
    game.startPlayerCareer(draft);
  });
  const back = el('button', 'btn ghost', 'Back');
  back.addEventListener('click', () => mgr.show('main'));
  a.appendChild(start); a.appendChild(back);
  body.appendChild(a);
}));

registerScreen('playerHub', (game, params, mgr) => shell('Your Career', (body) => {
  const c = game.player;
  const club = c.club;
  const me = c.me;

  // ---- Header ------------------------------------------------------------
  const head = el('div', 'card');
  head.style.borderLeft = `4px solid ${club.colors.primary}`;
  const nameRow = el('div', 'tc-name', `${me.name}  #${me.capNumber}`);
  head.appendChild(nameRow);
  const stars = el('div', null, starString(me.overall));
  stars.style.color = '#f4c430'; stars.style.fontSize = '18px'; stars.style.letterSpacing = '3px';
  head.appendChild(stars);
  head.appendChild(el('div', 'tc-city',
    `${POSITION_NAMES[me.position]} · ${club.name} · age ${me.age} · OVR ${me.overall}`));

  const money = el('div', 'tc-stats');
  const addStat = (label, val, color) => {
    const d = el('div', 'tc-stat');
    const b = el('b', null, val); if (color) b.style.color = color;
    d.appendChild(b); d.appendChild(document.createTextNode(label));
    money.appendChild(d);
  };
  addStat('BALANCE', `$${c.money}`, c.money > 0 ? '#5ef08a' : '#ff5a5a');
  addStat('WAGE / GAME', `$${c.contract.wage}`);
  addStat('CONTRACT', `${c.contract.weeksLeft}w`);
  addStat('REPUTATION', Math.round(c.reputation));
  head.appendChild(money);
  body.appendChild(head);

  // ---- Life dashboard ----------------------------------------------------
  const cols = el('div', 'grid grid-2');
  cols.style.marginTop = '14px';

  const life = el('div', 'card');
  life.appendChild(el('h3', null, 'Life'));
  life.appendChild(bar('Energy', c.energy / 100, c.energy > 40 ? '#5ef08a' : '#ffcf4d'));
  life.appendChild(bar('Morale', c.morale / 100, c.morale > 40 ? '#8be9fd' : '#ff9a5a'));
  life.appendChild(bar('Form', (c.form - 0.7) / 0.65, '#c084fc', `${Math.round(c.form * 100)}%`));
  life.appendChild(bar('Reputation', c.reputation / 100, '#f4c430', Math.round(c.reputation)));
  cols.appendChild(life);

  // ---- Your five stats ---------------------------------------------------
  const statsCard = el('div', 'card');
  statsCard.appendChild(el('h3', null, 'Your Stats'));
  const big5 = el('div', 'big5');
  for (const [label, key, val] of headlineRows(me)) {
    const row = el('div', 'big5-row');
    row.appendChild(el('span', 'big5-l', label));
    const b = el('div', 'big5-bar'); const fill = el('i');
    fill.style.width = `${val}%`; fill.style.background = STAT_COLORS[key] ?? '#7dd3fc';
    b.appendChild(fill); row.appendChild(b);
    row.appendChild(el('span', 'big5-v', String(val)));
    big5.appendChild(row);
  }
  statsCard.appendChild(big5);
  statsCard.appendChild(el('p', null, `Potential ${me.potential} · training raises stats toward it while you are young.`));
  cols.appendChild(statsCard);
  body.appendChild(cols);

  // ---- This week ---------------------------------------------------------
  const week = el('div', 'card');
  week.style.marginTop = '14px';
  week.appendChild(el('h3', null, c.finished ? 'Season complete' : `Season ${c.season} · Week ${c.week + 1} of ${c.fixtures.length}`));

  if (c.finished) {
    const sm = c.seasonSummary;
    week.appendChild(el('p', null,
      `${club.short} finished ${ordinal(sm.pos)}. You: ${sm.appearances} apps, ${sm.goals}G ${sm.assists}A, ` +
      `avg rating ${sm.avgRating.toFixed(1)}, ${sm.motm} MOTM.`));
    const btn = el('button', 'btn', 'Start Next Season');
    btn.addEventListener('click', () => { c.startNextSeason(); game.savePlayerCareer(); mgr.show('playerHub'); });
    week.appendChild(btn);
  } else {
    const fx = c.currentFixture();
    const verdict = c.managerVerdict();
    if (fx) {
      const opp = TEAMS.find((t) => t.id === (fx.home === c.clubId ? fx.away : fx.home));
      week.appendChild(el('div', 'tc-name', `${c.isHome() ? 'vs' : '@'} ${opp.name}`));
      const vLine = el('div', 'mi-desc',
        verdict.starts ? 'The manager has named you in the starting seven.'
          : verdict.reason === 'injured' ? 'You are injured and cannot play this week.'
            : 'You are on the bench — come on and prove the manager wrong.');
      vLine.style.color = verdict.starts ? '#5ef08a' : verdict.reason === 'injured' ? '#ff5a5a' : '#ffcf4d';
      week.appendChild(vLine);
    } else {
      week.appendChild(el('p', null, 'No fixture this week — a chance to train and recover.'));
    }

    // Activity picker.
    week.appendChild(el('h3', null, 'Choose one activity for the week'));
    const actGrid = el('div', 'grid grid-3');
    for (const [key, act] of Object.entries(ACTIVITIES)) {
      const b = el('button', `chip ${c.pendingActivity === key ? 'on' : ''}`);
      b.style.textAlign = 'left'; b.style.padding = '9px 12px'; b.style.height = 'auto';
      b.innerHTML = `<b>${act.name}</b><br><span style="opacity:.7;font-size:10px">${act.desc}</span>`;
      b.addEventListener('click', () => {
        const r = c.chooseActivity(key);
        if (!r.ok) mgr.toast(r.reason === 'noMoney' ? 'Not enough money.' : r.reason === 'formTooLow' ? 'Your form is too low for that.' : 'Cannot do that now.');
        mgr.show('playerHub');
      });
      actGrid.appendChild(b);
    }
    week.appendChild(actGrid);

    const acts = el('div', 'actions');
    if (fx && verdict.reason !== 'injured') {
      const play = el('button', 'btn', c.pendingActivity ? 'Play Match ▶' : 'Pick an activity first');
      play.disabled = !c.pendingActivity;
      play.addEventListener('click', () => game.playPlayerMatch());
      acts.appendChild(play);
    }
    const skip = el('button', 'btn ghost', fx ? 'Sim the week' : 'Advance week');
    skip.disabled = !c.pendingActivity && !!fx;
    skip.addEventListener('click', () => game.simPlayerWeek());
    acts.appendChild(skip);
    week.appendChild(acts);
  }
  body.appendChild(week);

  // ---- Contract offers ---------------------------------------------------
  if (c.contractOffer || c.transferOffer) {
    const off = el('div', 'card');
    off.style.marginTop = '14px';
    off.style.borderLeft = '4px solid #f4c430';
    off.appendChild(el('h3', null, 'Contract Decision'));
    if (c.contractOffer) {
      const p = el('p', null, `${c.contractOffer.from} offer a renewal: $${c.contractOffer.wage}/game for ${c.contractOffer.weeksLeft} weeks.`);
      off.appendChild(p);
      const b = el('button', 'chip', 'Re-sign');
      b.addEventListener('click', () => { c.acceptOffer('renew'); game.savePlayerCareer(); mgr.show('playerHub'); });
      off.appendChild(b);
    }
    if (c.transferOffer) {
      const p = el('p', null, `${c.transferOffer.from} want to sign you: $${c.transferOffer.wage}/game. A step up.`);
      off.appendChild(p);
      const b = el('button', 'chip', 'Transfer');
      b.style.marginLeft = '8px';
      b.addEventListener('click', () => { c.acceptOffer('transfer'); game.savePlayerCareer(); mgr.show('playerHub'); });
      off.appendChild(b);
    }
    body.appendChild(off);
  }

  // ---- Menu --------------------------------------------------------------
  const list = el('div', 'menu-list');
  list.style.marginTop = '14px';
  list.appendChild(menuItem('Shop', 'Spend your earnings on gear and lifestyle boosts.', null, () => mgr.show('playerShop')));
  list.appendChild(menuItem('Squad & Club', 'Your teammates and the club level.', null, () => mgr.show('rosters', { teamId: c.clubId, from: 'playerHub' })));
  list.appendChild(menuItem('League Table', 'Standings and your club\'s season.', null, () => mgr.show('playerTable')));
  body.appendChild(list);

  // ---- News --------------------------------------------------------------
  if (c.news.length) {
    const news = el('div', 'card');
    news.style.marginTop = '14px';
    news.appendChild(el('h3', null, 'Your Story'));
    for (const n of c.news.slice(0, 8)) {
      const p = el('p', null, n.text); p.style.margin = '0 0 6px';
      news.appendChild(p);
    }
    body.appendChild(news);
  }

  const foot = el('div', 'actions');
  const save = el('button', 'btn ghost', 'Save');
  save.addEventListener('click', () => { game.savePlayerCareer(); mgr.toast('Saved.'); });
  const quit = el('button', 'btn ghost', 'Main Menu');
  quit.addEventListener('click', () => mgr.show('main'));
  foot.appendChild(save); foot.appendChild(quit);
  body.appendChild(foot);
}));

registerScreen('playerShop', (game, params, mgr) => shell('Shop', (body) => {
  const c = game.player;
  body.appendChild(el('p', null, `Balance: $${c.money}`));
  const grid = el('div', 'grid grid-2');
  for (const item of SHOP) {
    const card = el('div', 'card');
    card.appendChild(el('div', 'tc-name', item.name));
    card.appendChild(el('div', 'mi-desc', item.desc));
    const owned = c.hasItem(item.id);
    const b = el('button', 'chip', owned ? 'Owned' : `Buy · $${item.cost}`);
    b.disabled = owned || c.money < item.cost;
    b.style.marginTop = '10px';
    b.addEventListener('click', () => {
      const r = c.buyItem(item.id);
      if (!r.ok) mgr.toast(r.reason === 'noMoney' ? 'Not enough money.' : 'Already owned.');
      else { game.savePlayerCareer(); mgr.show('playerShop'); }
    });
    card.appendChild(b);
    grid.appendChild(card);
  }
  body.appendChild(grid);
  const a = el('div', 'actions');
  const back = el('button', 'btn ghost', 'Back');
  back.addEventListener('click', () => mgr.show('playerHub'));
  a.appendChild(back);
  body.appendChild(a);
}));

registerScreen('playerTable', (game, params, mgr) => shell('League', (body) => {
  const c = game.player;
  const table = el('table', 'data');
  const thead = el('thead'); const hr = el('tr');
  for (const h of ['#', 'Club', 'P', 'W', 'D', 'L', 'GF', 'GA', 'Pts']) hr.appendChild(el('th', h.length <= 2 && h !== 'Club' ? 'num' : null, h));
  thead.appendChild(hr); table.appendChild(thead);
  const tb = el('tbody');
  c.standings().forEach((row, i) => {
    const team = TEAMS.find((t) => t.id === row.id);
    const tr = el('tr');
    if (row.id === c.clubId) tr.className = 'row-hi';
    tr.appendChild(el('td', 'num', String(i + 1)));
    tr.appendChild(el('td', null, team.name));
    for (const v of [row.played, row.won, row.drawn, row.lost, row.gf, row.ga, row.pts]) tr.appendChild(el('td', 'num', String(v)));
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  const card = el('div', 'card'); card.appendChild(el('h3', null, `Season ${c.season}`)); card.appendChild(table);
  body.appendChild(card);
  const a = el('div', 'actions');
  const back = el('button', 'btn ghost', 'Back'); back.addEventListener('click', () => mgr.show('playerHub'));
  a.appendChild(back); body.appendChild(a);
}));

function ordinal(n) { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]); }
