// Shipped in both the standalone RTE extension and the RTE-FFZ add-on.
function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function section(card, title) {
  const block = node('section', 'lqm-section');
  block.append(node('h3', '', title));
  card.append(block);
  return block;
}

function resource(label, value, max, color) {
  const row = node('div', 'lqm-meter');
  const caption = node('div', 'lqm-pair');
  caption.append(node('b', '', label), node('span', '', `${value ?? '—'} / ${max ?? '—'}`));
  row.append(caption);
  if (Number.isFinite(value) && Number.isFinite(max) && max > 0) {
    const bar = node('meter', 'lqm-' + color);
    bar.min = 0;
    bar.max = max;
    bar.value = value;
    bar.setAttribute('aria-label', label);
    row.append(bar);
  }
  return row;
}

const moscow = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
});

function timers(p, now) {
  const entries = new Map();
  function add(at, label) {
    if (!Number.isSafeInteger(at) || at <= now || at > 8.64e15 || !label) return;
    if (!entries.has(at)) entries.set(at, []);
    entries.get(at).push(label);
  }
  add(p.activity?.until, 'Конец занятия');
  add(p.shift?.at, 'Ограничение смены');
  add(p.fatigueFull, 'Снятие усталости');
  add(p.hpFull, 'Полное HP');
  add(p.mpFull, 'Полное MP');
  add(p.injury, 'Снятие травмы');
  add(p.duelReady, 'Личные ограничения дуэлей');
  add(p.inviteUntil, 'Истечение вызова');
  add(p.rematchUntil, 'Повторная дуэль');
  if (p.art) add(p.duelAt, 'Общий кулдаун дуэлей');
  const training = new Map();
  for (const {at, label} of p.training ?? []) {
    if (!label || !at) continue;
    if (!training.has(at)) training.set(at, []);
    training.get(at).push(label);
  }
  for (const [at, skills] of training) add(at, 'Тренировки: ' + skills.join(', '));
  return [...entries].sort(([a], [b]) => a - b);
}

export function renderLasqamonCard(p, art, stale = false) {
  const card = node('div', 'lqm-card');
  const head = node('header', 'lqm-head');
  if (art) {
    const img = node('img', 'lqm-art');
    img.alt = '';
    img.src = art;
    head.append(img);
  }
  const identity = node('div', 'lqm-identity');
  if (p.level != null) identity.append(node('span', 'lqm-level', 'Уровень ' + p.level));
  identity.append(node('strong', 'lqm-name', p.name || 'Ласкамон'));
  if (p.job) identity.append(node('span', 'lqm-job', p.job));
  head.append(identity);
  card.append(head);
  if (stale || p.level == null) {
    const note = p.level == null ? (stale ? 'Статус пока недоступен' : 'Обновляем данные…') : 'Сохранённые данные';
    card.append(node('div', 'lqm-note', note));
  }
  if (p.level == null) return card;

  // Older clients receive deadline bullets appended to the label. This card draws the timestamps below.
  const status = p.activity?.label?.split('\n• ')[0] || (p.resting ? 'Отдыхает' : 'Свободен');
  card.append(node('div', 'lqm-status', status));
  const meters = node('div', 'lqm-meters');
  meters.append(resource('HP', p.hp, p.maxHP, 'hp'), resource('MP', p.mp, p.maxMP, 'mp'));
  card.append(meters);

  const stats = Object.entries(p.stats ?? {});
  if (stats.length) {
    const grid = node('dl', 'lqm-stats');
    for (const [key, value] of stats) {
      const pair = node('div', 'lqm-pair');
      pair.append(node('dt', '', key), node('dd', '', value));
      grid.append(pair);
    }
    section(card, 'Характеристики').append(grid);
  }

  const record = [['Победы', p.wins], ['Поражения', p.losses], ['Ничьи', p.draws], ['Боевой опыт', p.xp]];
  if (p.duelState || record.some(([, count]) => count != null)) {
    const duels = section(card, 'Дуэли');
    if (p.duelState) duels.append(node('p', '', p.duelState));
    const grid = node('dl', 'lqm-stats');
    for (const [key, count] of record) {
      if (count == null) continue;
      const pair = node('div', 'lqm-pair');
      pair.append(node('dt', '', key), node('dd', '', count));
      grid.append(pair);
    }
    if (grid.childElementCount) duels.append(grid);
  }

  const now = Date.now();
  const deadlines = timers(p, now);
  if (deadlines.length) {
    const block = section(card, 'Таймеры');
    for (const [at, labels] of deadlines) {
      const row = node('div', 'lqm-timer');
      const mins = Math.ceil((at - now) / 60000);
      const duration = mins >= 60 ? `${Math.floor(mins / 60)} ч ${mins % 60} мин` : mins + ' мин';
      row.append(node('span', '', labels.join(' · ')), node('b', '', duration), node('time', '', moscow.format(at) + ' МСК'));
      block.append(row);
    }
  }
  return card;
}
