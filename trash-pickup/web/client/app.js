import {
  action, badge, bagsText, createApi, esc, fmtDate, formatAddress, formData, modal, money, photos, poll, renderLogin, timeline, toast, today,
} from '/shared/lib.js';

const api = createApi('client');
const root = document.getElementById('app');
const state = { user: null, meta: null, addresses: [], orders: [], tab: 'order' };
let stopPolling = () => {};

const TABS = [
  { id: 'order', icon: '➕', label: 'Заказать' },
  { id: 'orders', icon: '📦', label: 'Мои заказы' },
  { id: 'addresses', icon: '📍', label: 'Адреса' },
  { id: 'profile', icon: '👤', label: 'Профиль' },
];

api.onUnauthorized = () => start();

async function start() {
  stopPolling();
  if (!api.token) return showLogin();
  try {
    [state.user, state.meta] = await Promise.all([api.get('/api/me'), api.get('/api/meta')]);
  } catch {
    return showLogin();
  }
  await Promise.all([loadAddresses(), loadOrders()]);
  if (!state.addresses.length) state.tab = 'addresses';
  render();
  stopPolling = poll(async () => {
    if (state.tab !== 'orders') return;
    await loadOrders();
    render();
  }, 15000);
}

function showLogin() {
  renderLogin(root, {
    api,
    role: 'client',
    title: 'Вынос мусора от двери',
    subtitle: 'Оставьте пакет у двери — курьер заберёт его в выбранное время',
    demo: '+70000000002 / client',
    allowRegister: true,
    onLogin: start,
  });
}

const loadAddresses = async () => (state.addresses = await api.get('/api/client/addresses'));
const loadOrders = async () => (state.orders = await api.get('/api/client/orders'));

function render() {
  const tab = TABS.find((t) => t.id === state.tab);
  root.innerHTML = `
    <div class="mobile">
      <header class="topbar"><h1>${esc(tab.label)}</h1></header>
      <main class="content" id="view"></main>
      <nav class="tabbar"><div class="tabbar-inner">
        ${TABS.map((t) => `<button data-tab="${t.id}" ${t.id === state.tab ? 'aria-current="page"' : ''}><span aria-hidden="true">${t.icon}</span>${t.label}</button>`).join('')}
      </div></nav>
    </div>`;
  root.querySelector('.tabbar').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    if (state.tab === 'orders') await loadOrders();
    render();
  });
  ({ order: viewOrder, orders: viewOrders, addresses: viewAddresses, profile: viewProfile })[state.tab](root.querySelector('#view'));
}

// ——— Новый заказ ———
function viewOrder(el) {
  const { tariffs, slots, booking_days } = state.meta;
  if (!state.addresses.length) {
    el.innerHTML = `<div class="card empty"><p>Сначала добавьте адрес</p><button class="btn primary" data-go="addresses">Добавить адрес</button></div>`;
    el.querySelector('[data-go]').onclick = () => ((state.tab = 'addresses'), render());
    return;
  }
  const dates = Array.from({ length: booking_days + 1 }, (_, i) => today(i));
  const nowHour = new Date().getHours();
  const slotAvailable = (date, slot) => date !== today() || Number(slot.slice(6, 8)) > nowHour;
  const firstDate = dates.find((d) => slots.some((s) => slotAvailable(d, s)));

  el.innerHTML = `
    <form id="order-form" class="stack">
      <div class="card stack">
        <label>Адрес
          <select name="address_id">${state.addresses.map((a) => `<option value="${a.id}">${esc(formatAddress(a))}</option>`).join('')}</select>
        </label>
      </div>
      <div class="card stack">
        <h3>Тариф</h3>
        <div class="options">
          ${tariffs
            .map(
              (t, i) => `<label class="option"><input type="radio" name="tariff_id" value="${t.id}" ${i === 0 ? 'checked' : ''}>
              <div><b>${esc(t.name)} — ${money(t.price)}</b><div class="muted small">${esc(t.description || '')}</div>
              <div class="muted small">${bagsText(t.included_bags)} включено, далее ${money(t.extra_bag_price)} за пакет</div></div></label>`,
            )
            .join('')}
        </div>
      </div>
      <div class="card spread">
        <h3 style="margin:0">Пакетов</h3>
        <div class="stepper">
          <button type="button" class="btn" data-bags="-1" aria-label="Меньше">−</button>
          <output id="bags">1</output>
          <button type="button" class="btn" data-bags="1" aria-label="Больше">+</button>
        </div>
      </div>
      <div class="card stack">
        <h3>Когда забрать</h3>
        <div class="chips" id="dates">
          ${dates.map((d) => `<label class="chip"><input type="radio" name="slot_date" value="${d}" ${d === firstDate ? 'checked' : ''}><span>${d === today() ? 'Сегодня' : d === today(1) ? 'Завтра' : fmtDate(d)}</span></label>`).join('')}
        </div>
        <div class="chips" id="slots"></div>
        <p class="muted small">Выставьте пакет за дверь до начала окна. Курьер сфотографирует его у двери и у контейнера.</p>
      </div>
      <div class="card stack">
        <label>Комментарий для курьера<textarea name="comment" maxlength="500" placeholder="Например: пакет в синей сумке, не звонить"></textarea></label>
      </div>
      <div class="card spread">
        <div><div class="muted small">Итого</div><div class="total" id="total"></div></div>
        <button class="btn primary lg" type="submit">Заказать</button>
      </div>
    </form>`;

  const form = el.querySelector('#order-form');
  let bags = 1;
  const drawSlots = () => {
    const date = form.slot_date.value;
    const box = el.querySelector('#slots');
    const prev = box.querySelector('input:checked')?.value;
    box.innerHTML = slots
      .map((s) => `<label class="chip"><input type="radio" name="slot" value="${s}" ${slotAvailable(date, s) ? '' : 'disabled'}><span>${s}</span></label>`)
      .join('');
    const enabled = [...box.querySelectorAll('input:not(:disabled)')];
    const keep = enabled.find((i) => i.value === prev) || enabled[0];
    if (keep) keep.checked = true;
  };
  const drawTotal = () => {
    const t = tariffs.find((x) => String(x.id) === form.tariff_id.value);
    el.querySelector('#bags').textContent = bags;
    el.querySelector('#total').textContent = money(t.price + Math.max(0, bags - t.included_bags) * t.extra_bag_price);
  };
  drawSlots();
  drawTotal();

  form.addEventListener('change', (e) => {
    if (e.target.name === 'slot_date') drawSlots();
    drawTotal();
  });
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bags]');
    if (!b) return;
    bags = Math.min(20, Math.max(1, bags + Number(b.dataset.bags)));
    drawTotal();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = formData(form);
    if (!data.slot) return toast('Выберите время', 'error');
    const order = await action(e.submitter, () => api.post('/api/client/orders', { ...data, bags }), 'Заказ оформлен');
    if (!order) return;
    await loadOrders();
    state.tab = 'orders';
    render();
  });
}

// ——— Мои заказы ———
function viewOrders(el) {
  if (!state.orders.length) {
    el.innerHTML = '<div class="empty">Заказов пока нет</div>';
    return;
  }
  el.innerHTML = state.orders
    .map(
      (o) => `
      <div class="card order-card">
        <div class="spread"><b>№${o.id} · ${fmtDate(o.slot_date)}, ${esc(o.slot)}</b>${badge(o.status)}</div>
        <div>${esc(formatAddress(o))}</div>
        <div class="muted small">${esc(o.tariff_name)} · ${bagsText(o.bags)} · ${money(o.price)}${o.courier_name ? ' · Курьер: ' + esc(o.courier_name) : ''}</div>
        ${o.status === 'cancelled' && o.cancel_reason ? `<div class="muted small">Причина: ${esc(o.cancel_reason)}</div>` : ''}
        ${o.status === 'problem' ? `<div class="small" style="color:var(--danger)">${esc(o.problem_note)}. Мы свяжемся с вами.</div>` : ''}
        ${o.rating ? `<div class="small">Ваша оценка: ${'★'.repeat(o.rating)}</div>` : ''}
        <div class="actions">
          <button class="btn small" data-detail="${o.id}">Подробнее</button>
          ${['new', 'assigned'].includes(o.status) ? `<button class="btn small danger" data-cancel="${o.id}">Отменить</button>` : ''}
          ${o.status === 'done' && !o.rating ? `<button class="btn small primary" data-rate="${o.id}">Оценить</button>` : ''}
        </div>
      </div>`,
    )
    .join('');

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.detail) return showDetail(Number(t.dataset.detail));
    if (t.dataset.rate) return rate(Number(t.dataset.rate));
    if (t.dataset.cancel) {
      const reason = prompt('Причина отмены (необязательно)');
      if (reason === null) return;
      if (await action(t, () => api.post(`/api/client/orders/${t.dataset.cancel}/cancel`, { reason: reason || undefined }), 'Заказ отменён')) {
        await loadOrders();
        render();
      }
    }
  });
}

async function showDetail(id) {
  const o = await action(null, () => api.get(`/api/orders/${id}`));
  if (!o) return;
  modal(`
    <h2>Заказ №${o.id}</h2>
    <div class="spread">${badge(o.status)}<b>${money(o.price)}</b></div>
    <dl class="kv">
      <dt>Когда</dt><dd>${fmtDate(o.slot_date)}, ${esc(o.slot)}</dd>
      <dt>Адрес</dt><dd>${esc(formatAddress(o, { full: true }))}</dd>
      <dt>Тариф</dt><dd>${esc(o.tariff_name)}, ${bagsText(o.bags)}</dd>
      ${o.courier_name ? `<dt>Курьер</dt><dd>${esc(o.courier_name)}</dd>` : ''}
      ${o.comment ? `<dt>Комментарий</dt><dd>${esc(o.comment)}</dd>` : ''}
    </dl>
    <section><h3>Фотоотчёт</h3>${photos(o.photos)}</section>
    <section><h3>История</h3>${timeline(o.events)}</section>`);
}

function rate(id) {
  let rating = 5;
  const { el, close } = modal(`
    <h2>Как всё прошло?</h2>
    <form class="stack">
      <div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" class="on" aria-label="${n}">★</button>`).join('')}</div>
      <label>Отзыв<textarea name="review" maxlength="1000" placeholder="Необязательно"></textarea></label>
      <button class="btn primary" type="submit">Отправить</button>
    </form>`);
  el.querySelector('.stars').addEventListener('click', (e) => {
    const b = e.target.closest('[data-star]');
    if (!b) return;
    rating = Number(b.dataset.star);
    el.querySelectorAll('[data-star]').forEach((s) => s.classList.toggle('on', Number(s.dataset.star) <= rating));
  });
  el.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await action(e.submitter, () => api.post(`/api/client/orders/${id}/rate`, { rating, ...formData(e.target) }), 'Спасибо за оценку!')) {
      close();
      await loadOrders();
      render();
    }
  });
}

// ——— Адреса ———
function viewAddresses(el) {
  el.innerHTML = `
    ${state.addresses
      .map(
        (a) => `<div class="card spread"><div><div>${esc(formatAddress(a, { full: true }))}</div><div class="muted small">${esc(a.zone_name)}${a.comment ? ' · ' + esc(a.comment) : ''}</div></div>
        <button class="btn small danger" data-del="${a.id}" aria-label="Удалить адрес">Удалить</button></div>`,
      )
      .join('')}
    <form class="card stack" id="addr-form" style="margin-top:12px">
      <h3>Новый адрес</h3>
      <label>Район<select name="zone_id" required>${state.meta.zones.map((z) => `<option value="${z.id}">${esc(z.name)}</option>`).join('')}</select></label>
      <div class="grid-2">
        <label>Улица<input name="street" required></label>
        <label>Дом<input name="house" required></label>
        <label>Подъезд<input name="entrance" inputmode="numeric"></label>
        <label>Этаж<input name="floor" inputmode="numeric"></label>
        <label>Квартира<input name="apartment"></label>
        <label>Код домофона<input name="intercom"></label>
      </div>
      <label>Как пройти / где оставите пакет<textarea name="comment" maxlength="500"></textarea></label>
      <button class="btn primary" type="submit">Сохранить адрес</button>
    </form>`;

  el.querySelector('#addr-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await action(e.submitter, () => api.post('/api/client/addresses', formData(e.target)), 'Адрес добавлен')) {
      await loadAddresses();
      state.tab = 'order';
      render();
    }
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b || !confirm('Удалить адрес?')) return;
    if (await action(b, () => api.del(`/api/client/addresses/${b.dataset.del}`), 'Адрес удалён')) {
      await loadAddresses();
      render();
    }
  });
}

// ——— Профиль ———
function viewProfile(el) {
  const done = state.orders.filter((o) => o.status === 'done');
  el.innerHTML = `
    <div class="card">
      <h2>${esc(state.user.name)}</h2>
      <p class="muted">${esc(state.user.phone)}</p>
    </div>
    <div class="stats" style="margin-top:12px">
      <div class="stat"><div class="v">${done.length}</div><div class="l">выносов</div></div>
      <div class="stat"><div class="v">${done.reduce((s, o) => s + o.bags, 0)}</div><div class="l">пакетов</div></div>
    </div>
    <button class="btn block" id="logout">Выйти</button>`;
  el.querySelector('#logout').onclick = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    api.token = null;
    start();
  };
}

start();
