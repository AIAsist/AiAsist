import {
  action, badge, bagsText, createApi, esc, fmtDate, fmtTime, formatAddress, modal, money, photos, pickPhoto, poll, renderLogin, resizeImage, timeline, toast, today,
} from '/shared/lib.js';

const api = createApi('courier');
const root = document.getElementById('app');
const state = { user: null, tab: 'mine', mine: [], available: [], stats: null };
let stopPolling = () => {};

const TABS = [
  { id: 'mine', icon: '🚶', label: 'Мои заказы' },
  { id: 'available', icon: '📋', label: 'Свободные' },
  { id: 'stats', icon: '💰', label: 'Заработок' },
];

api.onUnauthorized = () => start();

async function start() {
  stopPolling();
  if (!api.token) return showLogin();
  try {
    state.user = await api.get('/api/me');
  } catch {
    return showLogin();
  }
  await refresh();
  stopPolling = poll(async () => {
    if (document.querySelector('.modal-backdrop')) return; // не перерисовываем, пока открыто окно
    await refresh();
  }, 15000);
}

function showLogin() {
  renderLogin(root, { api, role: 'courier', title: 'Приложение курьера', subtitle: 'Вход для сотрудников', demo: '+70000000001 / courier', onLogin: start });
}

async function refresh() {
  try {
    if (state.tab === 'mine') state.mine = await api.get('/api/courier/orders/mine');
    if (state.tab === 'available') state.available = await api.get('/api/courier/orders/available');
    if (state.tab === 'stats') state.stats = await api.get('/api/courier/stats');
  } catch (e) {
    toast(e.message, 'error');
  }
  render();
}

function render() {
  const tab = TABS.find((t) => t.id === state.tab);
  const on = state.user.on_shift;
  root.innerHTML = `
    <div class="mobile">
      <header class="topbar">
        <h1>${esc(tab.label)}</h1>
        <div class="shift-toggle">
          <span class="dot ${on ? 'on' : ''}" aria-hidden="true"></span>
          <button class="btn small ${on ? '' : 'primary'}" id="shift">${on ? 'Завершить смену' : 'Начать смену'}</button>
        </div>
      </header>
      <main class="content" id="view"></main>
      <nav class="tabbar"><div class="tabbar-inner">
        ${TABS.map((t) => `<button data-tab="${t.id}" ${t.id === state.tab ? 'aria-current="page"' : ''}><span aria-hidden="true">${t.icon}</span>${t.label}</button>`).join('')}
      </div></nav>
    </div>`;

  root.querySelector('#shift').onclick = async (e) => {
    const res = await action(e.target, () => api.post(`/api/courier/shift/${on ? 'end' : 'start'}`), on ? 'Смена завершена' : 'Смена началась');
    if (!res) return;
    state.user.on_shift = res.on_shift;
    render();
  };
  root.querySelector('.tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    refresh();
  });
  ({ mine: viewMine, available: viewAvailable, stats: viewStats })[state.tab](root.querySelector('#view'));
}

const mapsLink = (o) => `https://yandex.ru/maps/?text=${encodeURIComponent(`${o.street} ${o.house}`)}`;

function orderCard(o, actions) {
  return `
    <div class="card order-card">
      <div class="spread"><b>№${o.id} · ${o.slot_date === today() ? 'сегодня' : fmtDate(o.slot_date)}, ${esc(o.slot)}</b>${badge(o.status)}</div>
      <div><b>${esc(formatAddress(o, { full: true }))}</b></div>
      <div class="muted small">${esc(o.zone_name)} · ${esc(o.tariff_name)} · ${bagsText(o.bags)} · вам ${money(o.courier_fee)}</div>
      ${o.address_comment ? `<div class="small">📍 ${esc(o.address_comment)}</div>` : ''}
      ${o.comment ? `<div class="small">💬 ${esc(o.comment)}</div>` : ''}
      ${o.status === 'problem' ? `<div class="small" style="color:var(--danger)">⚠️ ${esc(o.problem_note)} — ждём решения диспетчера</div>` : ''}
      <div class="actions">${actions}</div>
    </div>`;
}

// ——— Мои заказы ———
function viewMine(el) {
  const active = state.mine.filter((o) => o.status !== 'done');
  const done = state.mine.filter((o) => o.status === 'done');
  if (!state.mine.length) {
    el.innerHTML = `<div class="empty">${state.user.on_shift ? 'Нет назначенных заказов. Загляните во вкладку «Свободные».' : 'Начните смену, чтобы брать заказы.'}</div>`;
    return;
  }
  const buttons = (o) => {
    const map = `<a class="btn small" href="${mapsLink(o)}" target="_blank" rel="noopener">Карта</a>`;
    const call = `<a class="btn small" href="tel:${esc(o.client_phone)}">Позвонить</a>`;
    const detail = `<button class="btn small" data-detail="${o.id}">Детали</button>`;
    switch (o.status) {
      case 'assigned':
        return `<button class="btn primary" data-status="on_way" data-id="${o.id}">Выехал</button><button class="btn small danger" data-release="${o.id}">Отказаться</button>${map}${call}`;
      case 'on_way':
        return `<button class="btn primary" data-photo="pickup" data-next="picked_up" data-id="${o.id}">📷 Забрал пакет</button><button class="btn small danger" data-problem="${o.id}">Проблема</button>${map}${call}`;
      case 'picked_up':
        return `<button class="btn primary" data-photo="disposal" data-next="done" data-id="${o.id}">📷 Выбросил в контейнер</button><button class="btn small danger" data-problem="${o.id}">Проблема</button>`;
      default:
        return `${call}${detail}`;
    }
  };
  el.innerHTML = `
    ${active.map((o) => orderCard(o, buttons(o))).join('') || '<div class="empty">Активных заказов нет</div>'}
    ${done.length ? `<h3 style="margin-top:20px">Выполнено сегодня: ${done.length}</h3>${done.map((o) => orderCard(o, `<span class="muted small">Готово в ${fmtTime(o.completed_at)}</span><button class="btn small" data-detail="${o.id}">Детали</button>`)).join('')}` : ''}`;

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.detail) return showDetail(Number(d.detail));
    if (d.status && (await action(b, () => api.post(`/api/courier/orders/${d.id}/status`, { status: d.status }), 'Статус обновлён'))) return refresh();
    if (d.release) {
      const reason = prompt('Почему отказываетесь от заказа?');
      if (reason === null) return;
      if (await action(b, () => api.post(`/api/courier/orders/${d.release}/release`, { reason: reason || undefined }), 'Заказ возвращён в общий список')) refresh();
      return;
    }
    if (d.problem) return reportProblem(Number(d.problem));
    if (d.photo) {
      // Фото обязательно: сначала загружаем, потом меняем статус.
      const file = await pickPhoto();
      if (!file) return;
      const ok = await action(b, async () => {
        await api.post(`/api/courier/orders/${d.id}/photos`, { kind: d.photo, data: await resizeImage(file) });
        await api.post(`/api/courier/orders/${d.id}/status`, { status: d.next });
      }, d.next === 'done' ? 'Заказ выполнен 👍' : 'Отмечено: пакет забран');
      if (ok) refresh();
    }
  });
}

function reportProblem(id) {
  const reasons = ['Пакета нет у двери', 'Не пускают в подъезд', 'Пакет порван / протекает', 'Объём больше заказанного'];
  const { el, close } = modal(`
    <h2>Проблема с заказом №${id}</h2>
    <form class="stack">
      <div class="options">${reasons.map((r, i) => `<label class="option"><input type="radio" name="reason" value="${esc(r)}" ${i === 0 ? 'checked' : ''}>${esc(r)}</label>`).join('')}
        <label class="option"><input type="radio" name="reason" value="">Другое</label></div>
      <label>Комментарий<textarea name="note" maxlength="400"></textarea></label>
      <label class="option"><input type="checkbox" name="photo" checked>Приложить фото</label>
      <button class="btn primary" type="submit">Отправить диспетчеру</button>
    </form>`);
  el.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const note = [f.reason.value, f.note.value.trim()].filter(Boolean).join('. ');
    if (!note) return toast('Опишите проблему', 'error');
    const file = f.photo.checked ? await pickPhoto() : null;
    const ok = await action(e.submitter, async () => {
      if (file) await api.post(`/api/courier/orders/${id}/photos`, { kind: 'problem', data: await resizeImage(file) });
      await api.post(`/api/courier/orders/${id}/status`, { status: 'problem', note });
    }, 'Диспетчер получил сообщение');
    if (ok) {
      close();
      refresh();
    }
  });
}

async function showDetail(id) {
  const o = await action(null, () => api.get(`/api/orders/${id}`));
  if (!o) return;
  modal(`
    <h2>Заказ №${o.id}</h2>
    <div class="spread">${badge(o.status)}<b>вам ${money(o.courier_fee)}</b></div>
    <dl class="kv">
      <dt>Адрес</dt><dd>${esc(formatAddress(o, { full: true }))}</dd>
      <dt>Клиент</dt><dd>${esc(o.client_name)}, <a href="tel:${esc(o.client_phone)}">${esc(o.client_phone)}</a></dd>
      <dt>Объём</dt><dd>${esc(o.tariff_name)}, ${bagsText(o.bags)}</dd>
    </dl>
    <section><h3>Фото</h3>${photos(o.photos)}</section>
    <section><h3>История</h3>${timeline(o.events)}</section>`);
}

// ——— Свободные заказы ———
function viewAvailable(el) {
  if (!state.available.length) {
    el.innerHTML = '<div class="empty">Свободных заказов нет</div>';
    return;
  }
  el.innerHTML =
    (state.user.on_shift ? '' : '<div class="card small" style="margin-bottom:12px">Начните смену, чтобы брать заказы.</div>') +
    state.available.map((o) => orderCard(o, `<button class="btn primary" data-take="${o.id}" ${state.user.on_shift ? '' : 'disabled'}>Взять заказ</button>`)).join('');
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-take]');
    if (!b) return;
    const ok = await action(b, () => api.post(`/api/courier/orders/${b.dataset.take}/take`), 'Заказ ваш');
    if (ok) {
      state.tab = 'mine';
      refresh();
    } else refresh();
  });
}

// ——— Заработок ———
function viewStats(el) {
  const s = state.stats;
  if (!s) return;
  const tile = (label, p) => `<div class="stat"><div class="l">${label}</div><div class="v">${money(p.earnings)}</div><div class="l">${p.done} заказов${p.rating ? ` · ★ ${p.rating}` : ''}</div></div>`;
  el.innerHTML = `
    <div class="stats">${tile('Сегодня', s.today)}${tile('7 дней', s.week)}${tile('Этот месяц', s.month)}${tile('Всего', s.total)}</div>
    <h3>Последние заказы</h3>
    ${
      s.recent.length
        ? `<div class="card">${s.recent
            .map((o) => `<div class="spread small" style="padding:6px 0"><span>№${o.id} · ${fmtDate(o.slot_date)} · ${esc(formatAddress(o))}</span><b>${money(o.courier_fee)}${o.rating ? ` · ★${o.rating}` : ''}</b></div>`)
            .join('')}</div>`
        : '<div class="empty">Пока нет выполненных заказов</div>'
    }
    <button class="btn block" id="logout" style="margin-top:16px">Выйти</button>`;
  el.querySelector('#logout').onclick = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    api.token = null;
    start();
  };
}

start();
