import {
  STATUS_LABELS, action, badge, bagsText, createApi, esc, fmtDate, formData, formatAddress, modal, money, photos, poll, renderLogin, timeline, toast, today,
} from '/shared/lib.js';

const api = createApi('admin');
const root = document.getElementById('app');
const state = {
  user: null,
  page: 'dashboard',
  couriers: [],
  zones: [],
  orderFilters: { status: 'active', date_from: '', date_to: '', courier_id: '', zone_id: '', q: '' },
  reportRange: { from: today(-29), to: today() },
};
let stopPolling = () => {};

const PAGES = {
  dashboard: { label: 'Дашборд', view: viewDashboard },
  orders: { label: 'Заказы', view: viewOrders },
  couriers: { label: 'Курьеры', view: viewCouriers },
  clients: { label: 'Клиенты', view: viewClients },
  tariffs: { label: 'Тарифы', view: viewTariffs },
  zones: { label: 'Районы', view: viewZones },
  reports: { label: 'Отчёты', view: viewReports },
};

// Какие переходы показывать админу в карточке заказа (кроме назначения курьера).
const ADMIN_ACTIONS = {
  new: [],
  assigned: [['new', 'Снять курьера']],
  on_way: [['picked_up', 'Отметить «забран»'], ['problem', 'Проблема']],
  picked_up: [['done', 'Отметить «выполнен»'], ['problem', 'Проблема']],
  problem: [['new', 'Вернуть в общий список'], ['done', 'Закрыть как выполненный']],
};

api.onUnauthorized = () => start();

async function start() {
  stopPolling();
  if (!api.token) return showLogin();
  try {
    state.user = await api.get('/api/me');
  } catch {
    return showLogin();
  }
  await loadRefs();
  renderShell();
  stopPolling = poll(() => state.page === 'dashboard' && !document.querySelector('.modal-backdrop') && show('dashboard'), 20000);
}

function showLogin() {
  renderLogin(root, { api, role: 'admin', title: 'Админ-панель', subtitle: 'Управление выносом мусора', demo: '+70000000000 / admin', onLogin: start });
}

async function loadRefs() {
  [state.couriers, state.zones] = await Promise.all([api.get('/api/admin/couriers'), api.get('/api/admin/zones')]);
}

function renderShell() {
  root.innerHTML = `
    <div class="admin">
      <nav class="sidebar">
        <div class="brand">🗑️ Вынос мусора</div>
        ${Object.entries(PAGES).map(([id, p]) => `<button data-page="${id}">${p.label}</button>`).join('')}
        <div class="spacer"></div>
        <div class="muted small" style="padding:8px">${esc(state.user.name)}</div>
        <button id="logout">Выйти</button>
      </nav>
      <main class="main" id="main"></main>
    </div>`;
  root.querySelector('.sidebar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (b) show(b.dataset.page);
  });
  root.querySelector('#logout').onclick = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    api.token = null;
    start();
  };
  show(state.page);
}

async function show(page) {
  state.page = page;
  root.querySelectorAll('[data-page]').forEach((b) => (b.dataset.page === page ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  // Каждый раз новый контейнер, чтобы обработчики событий прошлой страницы не накапливались.
  const old = root.querySelector('#main');
  const main = old.cloneNode(false);
  old.replaceWith(main);
  try {
    await PAGES[page].view(main);
  } catch (e) {
    main.innerHTML = `<div class="card">Ошибка: ${esc(e.message)}</div>`;
  }
}

const table = (head, rows, empty = 'Нет данных') =>
  `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th class="${h.startsWith('#') ? 'num' : ''}">${esc(h.replace(/^#/, ''))}</th>`).join('')}</tr></thead>
   <tbody>${rows.length ? rows.join('') : `<tr><td colspan="${head.length}" class="empty">${empty}</td></tr>`}</tbody></table></div>`;

const courierOptions = (selected, { onlyActive = true } = {}) =>
  state.couriers
    .filter((c) => !onlyActive || c.active)
    .map((c) => `<option value="${c.id}" ${String(c.id) === String(selected) ? 'selected' : ''}>${esc(c.name)}${c.on_shift ? ' · на смене' : ''}${c.zone_name ? ` (${esc(c.zone_name)})` : ''}</option>`)
    .join('');

const zoneOptions = (selected, empty = 'Все районы') =>
  `<option value="">${empty}</option>` + state.zones.map((z) => `<option value="${z.id}" ${String(z.id) === String(selected) ? 'selected' : ''}>${esc(z.name)}</option>`).join('');

const orderRow = (o) => `
  <tr class="clickable" data-order="${o.id}">
    <td>${o.id}</td>
    <td>${fmtDate(o.slot_date)}<div class="muted small">${esc(o.slot)}</div></td>
    <td>${badge(o.status)}</td>
    <td>${esc(formatAddress(o))}<div class="muted small">${esc(o.zone_name)}</div></td>
    <td>${esc(o.client_name)}<div class="muted small">${esc(o.client_phone)}</div></td>
    <td>${esc(o.tariff_name)}<div class="muted small">${bagsText(o.bags)}</div></td>
    <td>${o.courier_name ? esc(o.courier_name) : '<span class="muted">—</span>'}</td>
    <td class="num">${money(o.price)}</td>
  </tr>`;

const ORDER_HEAD = ['№', 'Когда', 'Статус', 'Адрес', 'Клиент', 'Тариф', 'Курьер', '#Цена'];

function bindOrderRows(el, onChange) {
  el.addEventListener('click', (e) => {
    const row = e.target.closest('[data-order]');
    if (row) openOrder(Number(row.dataset.order), onChange);
  });
}

// ——— Дашборд ———
async function viewDashboard(el) {
  const d = await api.get('/api/admin/dashboard');
  const t = d.today;
  const tile = (v, l, alert) => `<div class="stat ${alert && v ? 'alert' : ''}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  el.innerHTML = `
    <div class="spread"><h1>Сегодня, ${fmtDate(d.date)}</h1><button class="btn small" id="refresh">Обновить</button></div>
    <div class="stats">
      ${tile(Object.values(t).reduce((a, b) => a + b, 0), 'заказов на сегодня')}
      ${tile(t.new, 'без курьера', true)}
      ${tile(t.assigned + t.on_way + t.picked_up, 'в работе')}
      ${tile(t.done, 'выполнено')}
      ${tile(d.problems.length, 'проблем', true)}
      ${tile(d.overdue.length, 'просрочено', true)}
      ${tile(d.couriers_on_shift.length, 'курьеров на смене')}
      ${tile(money(d.revenue_today), 'выручка за день')}
    </div>
    ${d.problems.length ? `<h2>⚠️ Проблемы</h2>${table(ORDER_HEAD, d.problems.map(orderRow))}<br>` : ''}
    ${d.overdue.length ? `<h2>⏰ Просроченные</h2>${table(ORDER_HEAD, d.overdue.map(orderRow))}<br>` : ''}
    <h2>Ждут курьера (сегодня и завтра)</h2>
    ${table(ORDER_HEAD, d.unassigned.map(orderRow), 'Все заказы распределены')}
    <br>
    <h2>На смене</h2>
    <div class="card">${d.couriers_on_shift.map((c) => esc(c.name)).join(', ') || '<span class="muted">Никого нет на смене</span>'}</div>`;
  el.querySelector('#refresh').onclick = () => show('dashboard');
  bindOrderRows(el, () => show('dashboard'));
}

// ——— Заказы ———
async function viewOrders(el) {
  const f = state.orderFilters;
  el.innerHTML = `
    <h1>Заказы</h1>
    <form class="filters" id="filters">
      <label>Статус<select name="status">
        <option value="">Все</option><option value="active" ${f.status === 'active' ? 'selected' : ''}>Активные</option>
        ${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select></label>
      <label>С<input type="date" name="date_from" value="${f.date_from}"></label>
      <label>По<input type="date" name="date_to" value="${f.date_to}"></label>
      <label>Курьер<select name="courier_id"><option value="">Все</option>${courierOptions(f.courier_id, { onlyActive: false })}</select></label>
      <label>Район<select name="zone_id">${zoneOptions(f.zone_id)}</select></label>
      <label>Поиск<input name="q" value="${esc(f.q)}" placeholder="№, клиент, телефон, улица"></label>
      <button class="btn primary" type="submit">Найти</button>
    </form>
    <div id="list"><p class="muted">Загрузка…</p></div>`;

  const load = async () => {
    const qs = new URLSearchParams(Object.entries(state.orderFilters).filter(([, v]) => v));
    const orders = await api.get('/api/admin/orders?' + qs);
    el.querySelector('#list').innerHTML = `<p class="muted small">Найдено: ${orders.length}</p>` + table(ORDER_HEAD, orders.map(orderRow), 'Ничего не найдено');
  };
  el.querySelector('#filters').addEventListener('submit', (e) => {
    e.preventDefault();
    state.orderFilters = Object.fromEntries(new FormData(e.target));
    load().catch((err) => toast(err.message, 'error'));
  });
  bindOrderRows(el.querySelector('#list'), load);
  await load();
}

async function openOrder(id, onChange) {
  const o = await action(null, () => api.get(`/api/orders/${id}`));
  if (!o) return;
  const canAssign = ['new', 'assigned', 'problem'].includes(o.status);
  const canCancel = !['done', 'cancelled'].includes(o.status);
  const { el, close } = modal(`
    <h2>Заказ №${o.id}</h2>
    <div class="spread">${badge(o.status)}<span><b>${money(o.price)}</b> <span class="muted small">курьеру ${money(o.courier_fee)}</span></span></div>
    <dl class="kv">
      <dt>Когда</dt><dd>${fmtDate(o.slot_date)}, ${esc(o.slot)}</dd>
      <dt>Адрес</dt><dd>${esc(formatAddress(o, { full: true }))}<div class="muted small">${esc(o.zone_name)}${o.address_comment ? ' · ' + esc(o.address_comment) : ''}</div></dd>
      <dt>Клиент</dt><dd>${esc(o.client_name)}, <a href="tel:${esc(o.client_phone)}">${esc(o.client_phone)}</a></dd>
      <dt>Тариф</dt><dd>${esc(o.tariff_name)}, ${bagsText(o.bags)}</dd>
      <dt>Курьер</dt><dd>${o.courier_name ? `${esc(o.courier_name)}, <a href="tel:${esc(o.courier_phone)}">${esc(o.courier_phone)}</a>` : '—'}</dd>
      ${o.comment ? `<dt>Комментарий</dt><dd>${esc(o.comment)}</dd>` : ''}
      ${o.problem_note ? `<dt>Проблема</dt><dd style="color:var(--danger)">${esc(o.problem_note)}</dd>` : ''}
      ${o.cancel_reason ? `<dt>Отмена</dt><dd>${esc(o.cancel_reason)}</dd>` : ''}
      ${o.rating ? `<dt>Оценка</dt><dd>${'★'.repeat(o.rating)} ${esc(o.review || '')}</dd>` : ''}
    </dl>
    ${
      canAssign
        ? `<section><form class="inline-form" id="assign"><label>${o.courier_id ? 'Переназначить курьера' : 'Назначить курьера'}<select name="courier_id" required><option value="">Выберите…</option>${courierOptions(o.courier_id)}</select></label><button class="btn primary">Назначить</button></form></section>`
        : ''
    }
    <section class="row">
      ${(ADMIN_ACTIONS[o.status] || []).map(([s, label]) => `<button class="btn small" data-to="${s}">${label}</button>`).join('')}
      ${canCancel ? '<button class="btn small danger" data-to="cancelled">Отменить заказ</button>' : ''}
    </section>
    <section><h3>Фотоотчёт</h3>${photos(o.photos)}</section>
    <section><h3>История</h3>${timeline(o.events)}</section>`);

  const done = () => {
    close();
    onChange?.();
  };
  el.querySelector('#assign')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = formData(e.target);
    const res = await action(e.submitter, () =>
      o.status === 'problem' ? api.post(`/api/admin/orders/${id}/status`, { status: 'assigned', courier_id: body.courier_id, note: 'Назначен администратором' }) : api.post(`/api/admin/orders/${id}/assign`, body),
    'Курьер назначен');
    if (res) done();
  });
  el.querySelectorAll('[data-to]').forEach((b) =>
    b.addEventListener('click', async () => {
      const to = b.dataset.to;
      let note;
      if (to === 'cancelled' || to === 'problem') {
        note = prompt(to === 'cancelled' ? 'Причина отмены' : 'Опишите проблему');
        if (note === null) return;
      }
      if (await action(b, () => api.post(`/api/admin/orders/${id}/status`, { status: to, note: note || undefined }), 'Статус изменён')) done();
    }),
  );
}

// ——— Курьеры ———
async function viewCouriers(el) {
  await loadRefs();
  el.innerHTML = `
    <h1>Курьеры</h1>
    ${table(
      ['Имя', 'Телефон', 'Район', 'Статус', '#В работе', '#Выполнено', '#Рейтинг', ''],
      state.couriers.map(
        (c) => `<tr>
          <td>${esc(c.name)}</td><td>${esc(c.phone)}</td>
          <td><select data-zone="${c.id}" aria-label="Район">${zoneOptions(c.zone_id, 'Все районы')}</select></td>
          <td>${!c.active ? '<span class="badge s-cancelled">Заблокирован</span>' : c.on_shift ? '<span class="badge s-done">На смене</span>' : '<span class="muted">Не на смене</span>'}</td>
          <td class="num">${c.active_orders}</td><td class="num">${c.done}</td><td class="num">${c.rating ?? '—'}</td>
          <td class="row">
            <button class="btn small" data-orders="${c.id}">Заказы</button>
            <button class="btn small" data-password="${c.id}">Пароль</button>
            <button class="btn small ${c.active ? 'danger' : ''}" data-active="${c.id}" data-value="${c.active ? 0 : 1}">${c.active ? 'Заблокировать' : 'Разблокировать'}</button>
          </td></tr>`,
      ),
      'Курьеров пока нет',
    )}
    <form class="card inline-form" id="new-courier" style="margin-top:16px">
      <label>Имя<input name="name" required></label>
      <label>Телефон<input name="phone" type="tel" required placeholder="+7…"></label>
      <label>Пароль<input name="password" required minlength="4"></label>
      <label>Район<select name="zone_id">${zoneOptions('', 'Все районы')}</select></label>
      <button class="btn primary">Добавить курьера</button>
    </form>`;

  const update = async (id, body, msg, btn) => (await action(btn, () => api.patch(`/api/admin/couriers/${id}`, body), msg)) && show('couriers');
  el.addEventListener('change', (e) => e.target.dataset.zone && update(e.target.dataset.zone, { zone_id: e.target.value || null }, 'Район изменён'));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.active) update(b.dataset.active, { active: b.dataset.value === '1' }, 'Сохранено', b);
    if (b.dataset.password) {
      const password = prompt('Новый пароль курьера (не короче 4 символов)');
      if (password && password.length >= 4) update(b.dataset.password, { password }, 'Пароль изменён', b);
    }
    if (b.dataset.orders) {
      state.orderFilters = { status: '', courier_id: b.dataset.orders };
      show('orders');
    }
  });
  el.querySelector('#new-courier').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await action(e.submitter, () => api.post('/api/admin/couriers', formData(e.target)), 'Курьер добавлен')) show('couriers');
  });
}

// ——— Клиенты ———
async function viewClients(el) {
  el.innerHTML = `
    <h1>Клиенты</h1>
    <form class="filters" id="search"><label>Поиск<input name="q" placeholder="Имя или телефон"></label><button class="btn primary">Найти</button></form>
    <div id="list"></div>`;
  const load = async (q = '') => {
    const clients = await api.get('/api/admin/clients?q=' + encodeURIComponent(q));
    el.querySelector('#list').innerHTML = table(
      ['Имя', 'Телефон', 'С нами с', '#Заказов', '#Оплачено', 'Последний заказ', ''],
      clients.map(
        (c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td>${fmtDate(c.created_at)}</td>
          <td class="num">${c.orders}</td><td class="num">${money(c.spent)}</td><td>${c.last_order ? fmtDate(c.last_order) : '—'}</td>
          <td class="row"><button class="btn small" data-q="${esc(c.phone)}">Заказы</button>
          <button class="btn small ${c.active ? 'danger' : ''}" data-active="${c.id}" data-value="${c.active ? 0 : 1}">${c.active ? 'Заблокировать' : 'Разблокировать'}</button></td></tr>`,
      ),
      'Клиентов не найдено',
    );
  };
  el.querySelector('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    load(e.target.q.value);
  });
  el.querySelector('#list').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.q) {
      state.orderFilters = { status: '', q: b.dataset.q };
      return show('orders');
    }
    if (await action(b, () => api.patch(`/api/admin/clients/${b.dataset.active}`, { active: b.dataset.value === '1' }), 'Сохранено')) load(el.querySelector('[name=q]').value);
  });
  await load();
}

// ——— Тарифы ———
async function viewTariffs(el) {
  const tariffs = await api.get('/api/admin/tariffs');
  const fields = [
    ['name', 'Название', 'text'],
    ['price', 'Цена, ₽', 'number'],
    ['included_bags', 'Пакетов включено', 'number'],
    ['extra_bag_price', 'Доп. пакет, ₽', 'number'],
    ['courier_fee', 'Курьеру, ₽', 'number'],
    ['extra_bag_fee', 'Курьеру за доп. пакет, ₽', 'number'],
  ];
  const form = (t = {}) => `
    <form class="card stack" data-tariff="${t.id ?? ''}">
      <div class="spread"><h3 style="margin:0">${t.id ? esc(t.name) : 'Новый тариф'}</h3>
        ${t.id ? `<label class="row" style="flex-direction:row;color:var(--text)"><input type="checkbox" name="active" style="width:auto;min-height:0" ${t.active ? 'checked' : ''}> Активен</label>` : ''}</div>
      <div class="inline-form">${fields.map(([k, l, type]) => `<label>${l}<input name="${k}" type="${type}" ${type === 'number' ? 'min="0"' : ''} value="${esc(t[k] ?? '')}" required></label>`).join('')}</div>
      <label>Описание для клиента<input name="description" value="${esc(t.description ?? '')}"></label>
      <div><button class="btn primary">${t.id ? 'Сохранить' : 'Создать'}</button></div>
    </form>`;
  el.innerHTML = `<h1>Тарифы</h1>
    <p class="muted">Маржа = цена − выплата курьеру. Изменения применяются к новым заказам.</p>
    ${tariffs.map((t) => form(t)).join('')}${form()}`;
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = Object.fromEntries(new FormData(f));
    for (const [k, , type] of fields) if (type === 'number') body[k] = Number(body[k]);
    const id = f.dataset.tariff;
    if (id) body.active = f.active.checked;
    if (await action(e.submitter, () => (id ? api.patch(`/api/admin/tariffs/${id}`, body) : api.post('/api/admin/tariffs', body)), 'Тариф сохранён')) show('tariffs');
  });
}

// ——— Районы ———
async function viewZones(el) {
  await loadRefs();
  el.innerHTML = `
    <h1>Районы обслуживания</h1>
    ${table(
      ['Название', '#Курьеров', 'Статус', ''],
      state.zones.map(
        (z) => `<tr><td>${esc(z.name)}</td><td class="num">${z.couriers}</td>
          <td>${z.active ? '<span class="badge s-done">Работаем</span>' : '<span class="badge s-cancelled">Отключён</span>'}</td>
          <td><button class="btn small" data-zone="${z.id}" data-value="${z.active ? 0 : 1}">${z.active ? 'Отключить' : 'Включить'}</button></td></tr>`,
      ),
    )}
    <form class="card inline-form" id="new-zone" style="margin-top:16px">
      <label>Название района<input name="name" required></label>
      <button class="btn primary">Добавить</button>
    </form>`;
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-zone]');
    if (b && (await action(b, () => api.patch(`/api/admin/zones/${b.dataset.zone}`, { active: b.dataset.value === '1' }), 'Сохранено'))) show('zones');
  });
  el.querySelector('#new-zone').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await action(e.submitter, () => api.post('/api/admin/zones', formData(e.target)), 'Район добавлен')) show('zones');
  });
}

// ——— Отчёты ———
async function viewReports(el) {
  const { from, to } = state.reportRange;
  const r = await api.get(`/api/admin/reports?from=${from}&to=${to}`);
  const s = r.summary;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');
  const tile = (v, l) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  el.innerHTML = `
    <h1>Отчёты</h1>
    <form class="filters" id="range">
      <label>С<input type="date" name="from" value="${from}" required></label>
      <label>По<input type="date" name="to" value="${to}" required></label>
      <button class="btn primary">Показать</button>
      <button class="btn" type="button" data-preset="7">7 дней</button>
      <button class="btn" type="button" data-preset="30">30 дней</button>
      <button class="btn" type="button" id="csv">⬇ Выгрузить заказы (CSV)</button>
    </form>
    <div class="stats">
      ${tile(s.orders, 'заказов')}
      ${tile(`${s.done ?? 0} <span class="muted small">(${pct(s.done, s.orders)})</span>`, 'выполнено')}
      ${tile(`${s.cancelled ?? 0} <span class="muted small">(${pct(s.cancelled, s.orders)})</span>`, 'отменено')}
      ${tile(s.problems ?? 0, 'с проблемой')}
      ${tile(money(s.revenue), 'выручка')}
      ${tile(money(s.courier_payouts), 'выплаты курьерам')}
      ${tile(money(s.margin), 'валовая маржа')}
      ${tile(s.done ? money(Math.round(s.revenue / s.done)) : '—', 'средний чек')}
      ${tile(s.avg_rating ?? '—', 'средняя оценка')}
      ${tile(s.avg_minutes != null ? `${s.avg_minutes} мин` : '—', 'от назначения до выноса')}
      ${tile(s.bags, 'пакетов вынесено')}
      ${tile(s.clients, 'клиентов')}
    </div>
    <div class="grid-2">
      <div><h2>По курьерам</h2>${table(
        ['Курьер', '#Заказов', '#Выполнено', '#Проблем', '#К выплате', '#Рейтинг'],
        r.couriers.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${c.orders}</td><td class="num">${c.done}</td><td class="num">${c.problems}</td><td class="num">${money(c.earnings)}</td><td class="num">${c.rating ?? '—'}</td></tr>`),
      )}</div>
      <div><h2>По районам</h2>${table(
        ['Район', '#Заказов', '#Выполнено', '#Выручка'],
        r.zones.map((z) => `<tr><td>${esc(z.name)}</td><td class="num">${z.orders}</td><td class="num">${z.done}</td><td class="num">${money(z.revenue)}</td></tr>`),
      )}
      <h2 style="margin-top:16px">По тарифам</h2>${table(
        ['Тариф', '#Заказов', '#Выручка'],
        r.tariffs.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${t.orders}</td><td class="num">${money(t.revenue)}</td></tr>`),
      )}</div>
    </div>
    <h2 style="margin-top:16px">По дням</h2>
    ${table(
      ['Дата', '#Заказов', '#Выполнено', '#Отменено', '#Выручка'],
      r.daily.map((d) => `<tr><td>${fmtDate(d.date)}</td><td class="num">${d.orders}</td><td class="num">${d.done}</td><td class="num">${d.cancelled}</td><td class="num">${money(d.revenue)}</td></tr>`),
    )}`;

  el.querySelector('#range').addEventListener('submit', (e) => {
    e.preventDefault();
    state.reportRange = Object.fromEntries(new FormData(e.target));
    show('reports');
  });
  el.querySelectorAll('[data-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      state.reportRange = { from: today(1 - Number(b.dataset.preset)), to: today() };
      show('reports');
    }),
  );
  el.querySelector('#csv').addEventListener('click', async (e) => {
    const blob = await action(e.target, () => api.get(`/api/admin/reports/orders.csv?from=${from}&to=${to}`));
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `orders_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

start();
