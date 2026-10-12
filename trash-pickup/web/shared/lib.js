// Общие утилиты для всех трёх приложений.

export const STATUS_LABELS = {
  new: 'Новый',
  assigned: 'Курьер назначен',
  on_way: 'Курьер в пути',
  picked_up: 'Мусор забран',
  done: 'Выполнен',
  problem: 'Проблема',
  cancelled: 'Отменён',
};

export const PHOTO_LABELS = { pickup: 'У двери', disposal: 'У контейнера', problem: 'Проблема' };

/** API-клиент. Токен хранится отдельно для каждого приложения, чтобы можно было одновременно открыть клиента, курьера и админку. */
export function createApi(app) {
  const key = `trash:${app}:token`;
  const api = {
    get token() {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set token(value) {
      try {
        value ? localStorage.setItem(key, value) : localStorage.removeItem(key);
      } catch {}
    },
    onUnauthorized: () => {},

    async request(method, url, body) {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(api.token ? { Authorization: `Bearer ${api.token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 401 && api.token) {
        api.token = null;
        api.onUnauthorized();
      }
      const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.blob();
      if (!res.ok) throw new Error(data?.error || `Ошибка ${res.status}`);
      return data;
    },
    get: (url) => api.request('GET', url),
    post: (url, body = {}) => api.request('POST', url, body),
    patch: (url, body) => api.request('PATCH', url, body),
    del: (url) => api.request('DELETE', url),
  };
  return api;
}

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const money = (v) => `${Number(v || 0).toLocaleString('ru-RU')} ₽`;

export const fmtDate = (d) => {
  if (!d) return '';
  const date = new Date(d.length === 10 ? d + 'T12:00:00' : d);
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: d.length === 10 ? 'short' : undefined });
};

export const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '');
export const fmtDateTime = (d) => (d ? `${new Date(d).toLocaleDateString('ru-RU')} ${fmtTime(d)}` : '');

export const today = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('sv-SE');
};

export const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};

export const bagsText = (n) => `${n} ${plural(n, 'пакет', 'пакета', 'пакетов')}`;

export const badge = (status) => `<span class="badge s-${status}">${esc(STATUS_LABELS[status] || status)}</span>`;

export const formatAddress = (o, { full = false } = {}) => {
  let s = `${o.street}, д. ${o.house}`;
  if (o.apartment) s += `, кв. ${o.apartment}`;
  if (full) {
    const extra = [o.entrance && `подъезд ${o.entrance}`, o.floor && `этаж ${o.floor}`, o.intercom && `домофон ${o.intercom}`].filter(Boolean);
    if (extra.length) s += ` (${extra.join(', ')})`;
  }
  return s;
};

let toastTimer;
export function toast(message, type = 'ok') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = message;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 3500);
}

/** Выполняет действие с блокировкой кнопки. Ошибку показывает тостом и возвращает undefined. */
export async function action(button, fn, successMessage) {
  if (button) button.disabled = true;
  try {
    const result = await fn();
    if (successMessage) toast(successMessage);
    return result ?? true;
  } catch (e) {
    toast(e.message, 'error');
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

/** Данные формы как объект (пустые строки отбрасываются). */
export function formData(form) {
  const data = {};
  for (const [k, v] of new FormData(form)) if (v !== '') data[k] = v;
  return data;
}

/** Сжимает фото с камеры до maxSize px по длинной стороне и возвращает data URL (JPEG). */
export function resizeImage(file, maxSize = 1280, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('Не удалось прочитать фото'));
    img.src = URL.createObjectURL(file);
  });
}

/** Просит выбрать/сделать фото и возвращает File (или null, если отменили). */
export function pickPhoto() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.onchange = () => resolve(input.files[0] || null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Модальное окно. Возвращает элемент содержимого и функцию закрытия. */
export function modal(html, { onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><button class="modal-close" aria-label="Закрыть">×</button><div class="modal-body">${html}</div></div>`;
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  wrap.addEventListener('click', (e) => (e.target === wrap || e.target.closest('.modal-close')) && close());
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  return { el: wrap.querySelector('.modal-body'), close };
}

/** История статусов заказа. */
export const timeline = (events) =>
  `<ol class="timeline">${events
    .map(
      (e) => `<li><div><b>${esc(STATUS_LABELS[e.status])}</b> <span class="muted">${fmtDateTime(e.created_at)}</span></div>
        ${e.actor_name ? `<div class="muted small">${esc(e.actor_name)}</div>` : ''}
        ${e.note ? `<div class="small">${esc(e.note)}</div>` : ''}</li>`,
    )
    .join('')}</ol>`;

export const photos = (list) =>
  list.length
    ? `<div class="photos">${list
        .map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.url)}" alt="${esc(PHOTO_LABELS[p.kind])}" loading="lazy"><span>${esc(PHOTO_LABELS[p.kind])}</span></a>`)
        .join('')}</div>`
    : '<p class="muted">Фото пока нет</p>';

/** Экран входа (и регистрации — для клиента). */
export function renderLogin(root, { api, role, title, subtitle, demo, allowRegister = false, onLogin }) {
  let mode = 'login';
  const draw = () => {
    root.innerHTML = `
      <div class="auth">
        <div class="auth-card card">
          <div class="logo">🗑️</div>
          <h1>${esc(title)}</h1>
          <p class="muted">${esc(subtitle)}</p>
          <form id="auth-form" class="stack">
            ${mode === 'register' ? '<label>Имя<input name="name" required autocomplete="name"></label>' : ''}
            <label>Телефон<input name="phone" type="tel" required placeholder="+7 900 000-00-00" autocomplete="tel"></label>
            <label>Пароль<input name="password" type="password" required autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}"></label>
            <button class="btn primary" type="submit">${mode === 'register' ? 'Зарегистрироваться' : 'Войти'}</button>
          </form>
          ${allowRegister ? `<button class="btn link" id="switch">${mode === 'register' ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Регистрация'}</button>` : ''}
          ${demo ? `<p class="muted small">Демо: ${esc(demo)}</p>` : ''}
        </div>
      </div>`;
    root.querySelector('#switch')?.addEventListener('click', () => {
      mode = mode === 'login' ? 'register' : 'login';
      draw();
    });
    root.querySelector('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = formData(e.target);
      const res = await action(e.submitter, () => api.post(mode === 'register' ? '/api/auth/register' : '/api/auth/login', { ...body, role }));
      if (!res) return;
      api.token = res.token;
      onLogin(res.user);
    });
  };
  draw();
}

/** Запускает fn каждые ms миллисекунд, пока вкладка видима. Возвращает функцию остановки. */
export function poll(fn, ms) {
  const id = setInterval(() => document.visibilityState === 'visible' && fn(), ms);
  return () => clearInterval(id);
}
