// DOM overlay: money, orders, timer, garage, help, toasts, off-screen target arrow, minimap.

import type { Renderer } from '../render/renderer';
import type { ActiveOrder, Game } from '../world/game';
import type { Offer } from '../world/orders';
import { rating } from '../world/save';
import { VEHICLES } from '../world/vehicles';
import type { Minimap } from './minimap';
import type { Sound } from './sound';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

export function fmtDist(m: number): string {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} м`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} км`;
}

export function fmtTime(s: number): string {
  const neg = s < 0;
  const t = Math.abs(Math.round(s));
  return `${neg ? '−' : ''}${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);

export class Hud {
  private readonly $: Record<string, HTMLElement> = {};
  private textTimer = 0;
  private cancelArmed = 0;
  paused = false;

  constructor(
    root: HTMLElement,
    private readonly game: Game,
    private readonly renderer: Renderer,
    private readonly sound: Sound,
    private readonly minimap: Minimap,
  ) {
    root.innerHTML = `
      <div class="topbar">
        <div class="stats">
          <span class="chip money" data-el="money"></span>
          <span class="chip" title="Рейтинг (последние 20 доставок)" data-el="rating"></span>
          <span class="chip" title="Доставлено заказов" data-el="deliveries"></span>
          <span class="chip streak" title="Серия доставок вовремя: бонус к оплате" data-el="streak"></span>
        </div>
        <div class="buttons">
          <button class="btn" data-act="shop" title="Гараж (G)"><span data-el="vehIcon"></span><span class="lbl">Гараж</span></button>
          <button class="btn" data-act="view" title="Вид 2D/3D (V)" data-el="viewBtn">3D</button>
          <button class="btn" data-act="sound" title="Звук (M)" data-el="soundBtn">🔊</button>
          <button class="btn" data-act="help" title="Как играть (H)">?</button>
        </div>
      </div>
      <div class="panel" data-el="panel"></div>
      <div class="bottom-left">
        <div class="speed" data-el="speed"></div>
        <div class="street" data-el="street"></div>
        <div class="attribution">Карта: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© участники OpenStreetMap</a></div>
      </div>
      <div class="minimap-wrap" data-el="minimapWrap"></div>
      <div class="toasts" data-el="toasts"></div>
      <div class="target-arrow" data-el="arrow"><div class="arrow-head">➤</div><div class="arrow-dist" data-el="arrowDist"></div></div>
      <div class="modal-back" data-el="modal"><div class="modal" data-el="modalBody"></div></div>
    `;
    root.querySelectorAll<HTMLElement>('[data-el]').forEach((el) => (this.$[el.dataset.el!] = el));
    this.$.minimapWrap.appendChild(minimap.canvas);

    root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!btn) return;
      this.sound.unlock();
      this.action(btn.dataset.act!, btn.dataset.arg);
    });
    this.$.modal.addEventListener('click', (e) => {
      if (e.target === this.$.modal) this.closeModal();
    });

    game.on((e) => {
      switch (e.type) {
        case 'offers':
          this.renderPanel();
          break;
        case 'accepted':
          this.sound.accept();
          this.toast(`Заказ принят: ${esc(e.order.cargo)}. Забери в «${esc(e.order.pickup.title)}»`);
          this.renderPanel();
          break;
        case 'pickedUp':
          this.sound.pickup();
          this.toast(`📦 Забрал! Теперь к клиенту: ${esc(e.order.drop.title)}`, 'good');
          this.renderPanel();
          break;
        case 'delivered': {
          const r = e.result;
          if (r.late) this.sound.fail();
          else this.sound.deliver();
          const parts = [`<b>+${rub(r.base + r.tip + r.bonus)}</b>`];
          if (r.tip) parts.push(`чаевые ${rub(r.tip)}`);
          if (r.bonus) parts.push(`серия ×${e.streak}: ${rub(r.bonus)}`);
          if (r.late) parts.push('опоздание');
          this.toast(`${parts.join(' · ')}<br><span class="stars">${stars(r.stars)}</span>`, r.late ? 'bad' : 'good');
          this.renderPanel();
          this.updateTexts();
          break;
        }
        case 'cancelled':
          this.sound.fail();
          this.toast('Заказ отменён. Рейтинг ★☆☆☆☆', 'bad');
          this.renderPanel();
          break;
        case 'vehicle':
          this.toast(e.bought ? `Куплено: ${e.vehicle.icon} ${e.vehicle.name}!` : `Транспорт: ${e.vehicle.icon} ${e.vehicle.name}`, 'good');
          this.updateTexts();
          this.renderPanel();
          if (this.$.modal.classList.contains('open')) this.openShop();
          break;
      }
    });

    this.renderPanel();
    this.updateTexts();
  }

  /** Keyboard shortcuts. */
  key(code: string): void {
    if (code === 'Escape') return this.closeModal();
    if (this.paused) return;
    const digit = /^Digit([1-9])$/.exec(code);
    if (digit && !this.game.active) {
      const offer = this.game.board.offers[Number(digit[1]) - 1];
      if (offer) this.game.accept(offer.id);
      return;
    }
    const map: Record<string, string> = { KeyG: 'shop', KeyV: 'view', KeyM: 'sound', KeyH: 'help', KeyR: 'unstuck' };
    if (map[code]) this.action(map[code]);
  }

  private action(act: string, arg?: string): void {
    const g = this.game;
    switch (act) {
      case 'accept':
        g.accept(Number(arg));
        break;
      case 'cancel':
        if (this.cancelArmed > g.time) {
          g.cancel();
          this.cancelArmed = 0;
        } else {
          this.cancelArmed = g.time + 3;
          this.renderPanel();
        }
        break;
      case 'shop':
        this.openShop();
        break;
      case 'buy':
        if (!g.chooseVehicle(arg as never)) this.toast('Не хватает денег — доставь ещё пару заказов', 'bad');
        break;
      case 'view':
        this.renderer.setViewMode(this.renderer.viewMode === '2d' ? '3d' : '2d');
        this.$.viewBtn.textContent = this.renderer.viewMode === '2d' ? '3D' : '2D';
        if (this.renderer.viewMode === '3d') this.toast('3D-вид (бета): та же карта, камера сзади-сверху');
        break;
      case 'sound':
        this.sound.muted = !this.sound.muted;
        this.$.soundBtn.textContent = this.sound.muted ? '🔇' : '🔊';
        break;
      case 'help':
        this.openHelp();
        break;
      case 'unstuck':
        g.unstuck();
        this.closeModal();
        this.toast('Вернулись на дорогу');
        break;
      case 'close':
        this.closeModal();
        break;
    }
  }

  private renderPanel(): void {
    const g = this.game;
    const order = g.active;
    if (order) {
      this.$.panel.innerHTML = this.activeHtml(order);
      this.updateTimer();
      return;
    }
    const offers = g.board.offers;
    if (!g.board.pickups.length) {
      this.$.panel.innerHTML = `<div class="panel-title">Заказов нет</div><div class="muted">На этой карте не нашлось кафе и магазинов.</div>`;
      return;
    }
    this.$.panel.innerHTML = `
      <div class="panel-title">Заказы рядом <span class="muted">${esc(g.vehicle.icon)} ${esc(g.vehicle.name)}</span></div>
      ${offers.length ? offers.map((o, i) => this.offerHtml(o, i)).join('') : '<div class="muted searching">Ищем заказы…</div>'}
    `;
  }

  private offerHtml(o: Offer, i: number): string {
    const c = this.game.courier;
    const toPickup = Math.hypot(o.pickup.x - c.x, o.pickup.y - c.y);
    return `
      <button class="offer" data-act="accept" data-arg="${o.id}">
        <div class="offer-head"><span class="pay">+${rub(o.pay)}</span><span class="cargo">${esc(o.cargo)}</span><kbd>${i + 1}</kbd></div>
        <div class="offer-row"><span class="pin pickup">${o.pickup.icon}</span><span><b>${esc(o.pickup.title)}</b>${o.pickup.subtitle ? ` <small>${esc(o.pickup.subtitle)}</small>` : ''}</span></div>
        <div class="offer-row"><span class="pin drop">🏠</span><span>${esc(o.drop.title)}</span></div>
        <div class="offer-meta">до точки ~${fmtDist(toPickup)} · маршрут ${fmtDist(o.routeLength)}</div>
      </button>`;
  }

  private activeHtml(o: ActiveOrder): string {
    const pickup = o.stage === 'toPickup';
    const place = pickup ? o.pickup : o.drop;
    const armed = this.cancelArmed > this.game.time;
    return `
      <div class="active ${pickup ? 'is-pickup' : 'is-drop'}">
        <div class="stage">${pickup ? '① Забери заказ' : '② Доставь клиенту'} <span class="muted">${esc(o.cargo)}</span></div>
        <div class="offer-row"><span class="pin ${pickup ? 'pickup' : 'drop'}">${place.icon}</span><span><b>${esc(place.title)}</b>${place.subtitle && pickup ? ` <small>${esc(place.subtitle)}</small>` : ''}</span></div>
        <div class="timer"><div class="bar" data-el="timerBar"></div><span class="time" data-el="timerText"></span></div>
        <div class="active-foot"><span class="muted" data-el="remaining"></span><span class="pay">+${rub(o.pay)}</span>
          <button class="btn small ${armed ? 'danger' : ''}" data-act="cancel">${armed ? 'Точно отменить?' : 'Отменить'}</button></div>
      </div>`;
  }

  private updateTimer(): void {
    const o = this.game.active;
    if (!o) return;
    const bar = this.$.panel.querySelector<HTMLElement>('[data-el="timerBar"]');
    const text = this.$.panel.querySelector<HTMLElement>('[data-el="timerText"]');
    const rem = this.$.panel.querySelector<HTMLElement>('[data-el="remaining"]');
    const share = Math.max(0, o.timeLeft / o.timeLimit);
    if (bar) {
      bar.style.width = `${share * 100}%`;
      bar.className = `bar ${o.timeLeft < 0 ? 'late' : share < 0.25 ? 'warn' : ''}`;
    }
    if (text) text.textContent = o.timeLeft < 0 ? `опаздываешь ${fmtTime(-o.timeLeft)}` : fmtTime(o.timeLeft);
    const route = this.game.route();
    if (rem && route) rem.textContent = `ещё ${fmtDist(route.length)}`;
  }

  private updateTexts(): void {
    const g = this.game;
    const p = g.profile;
    const r = rating(p);
    this.$.money.textContent = `💰 ${rub(p.money)}`;
    this.$.rating.textContent = `★ ${r === null ? '—' : r.toFixed(1).replace('.', ',')}`;
    this.$.deliveries.textContent = `📦 ${p.deliveries}`;
    this.$.streak.textContent = g.streak > 1 ? `🔥 ×${g.streak}` : '';
    this.$.streak.style.display = g.streak > 1 ? '' : 'none';
    this.$.vehIcon.textContent = g.vehicle.icon;
    const c = g.courier;
    const kmh = Math.round(Math.hypot(c.vx, c.vy) * 3.6);
    this.$.speed.textContent = `${g.vehicle.icon} ${kmh} км/ч${c.onRoad ? '' : ' · бездорожье'}`;
    const street = g.world.streetNameAt(c.x, c.y);
    this.$.street.textContent = street ?? '';
    this.$.street.style.display = street ? '' : 'none';
    // Offer distances change as the courier moves.
    if (!g.active && g.board.offers.length) {
      this.$.panel.querySelectorAll<HTMLElement>('.offer').forEach((el, i) => {
        const o = g.board.offers[i];
        const meta = el.querySelector('.offer-meta');
        if (o && meta) meta.textContent = `до точки ~${fmtDist(Math.hypot(o.pickup.x - c.x, o.pickup.y - c.y))} · маршрут ${fmtDist(o.routeLength)}`;
      });
    }
    if (this.cancelArmed && this.cancelArmed <= g.time) {
      this.cancelArmed = 0;
      this.renderPanel();
    }
  }

  /** Called every frame. */
  frame(dt: number): void {
    this.textTimer -= dt;
    if (this.textTimer <= 0) {
      this.textTimer = 0.2;
      this.updateTexts();
      this.updateTimer();
    }
    this.updateArrow();
    const g = this.game;
    const t = g.target();
    const route = g.route();
    this.minimap.draw(g.courier, t ? { x: t.x, y: t.y, color: g.active?.stage === 'toPickup' ? '#f97316' : '#16a34a' } : null, route?.points ?? null);
  }

  private updateArrow(): void {
    const arrow = this.$.arrow;
    const t = this.game.target();
    if (!t) {
      arrow.style.display = 'none';
      return;
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    const p = this.renderer.project(t.x, t.y, 0);
    const margin = 46;
    const onScreen = p.visible && p.x > margin && p.x < w - margin && p.y > margin && p.y < h - margin;
    if (onScreen) {
      arrow.style.display = 'none';
      return;
    }
    // Direction from the courier's screen position towards the target.
    const c = this.game.courier;
    const cp = this.renderer.project(c.x, c.y, 0);
    let dx = p.x - cp.x;
    let dy = p.y - cp.y;
    if (!p.visible) {
      dx = -dx;
      dy = -dy;
    }
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    // Intersect the ray from the screen centre with the inset screen rectangle.
    const cx = w / 2;
    const cy = h / 2;
    const kx = dx !== 0 ? (w / 2 - margin) / Math.abs(dx) : Infinity;
    const ky = dy !== 0 ? (h / 2 - margin) / Math.abs(dy) : Infinity;
    const k = Math.min(kx, ky);
    arrow.style.display = 'flex';
    arrow.style.left = `${cx + dx * k}px`;
    arrow.style.top = `${cy + dy * k}px`;
    (arrow.firstElementChild as HTMLElement).style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    arrow.className = `target-arrow ${this.game.active?.stage === 'toPickup' ? 'pickup' : 'drop'}`;
    this.$.arrowDist.textContent = fmtDist(Math.hypot(t.x - c.x, t.y - c.y));
  }

  toast(html: string, kind: 'info' | 'good' | 'bad' = 'info'): void {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = html;
    this.$.toasts.appendChild(el);
    while (this.$.toasts.children.length > 3) this.$.toasts.firstElementChild!.remove();
    setTimeout(() => el.classList.add('hide'), 2800);
    setTimeout(() => el.remove(), 3300);
  }

  private openModal(html: string): void {
    this.$.modalBody.innerHTML = html;
    this.$.modal.classList.add('open');
    this.paused = true;
  }

  closeModal(): void {
    this.$.modal.classList.remove('open');
    this.paused = false;
  }

  openShop(): void {
    const p = this.game.profile;
    const cards = VEHICLES.map((v) => {
      const owned = p.owned.includes(v.id);
      const current = p.vehicle === v.id;
      const affordable = p.money >= v.price;
      const button = current
        ? '<span class="tag">Выбран</span>'
        : owned
          ? `<button class="btn" data-act="buy" data-arg="${v.id}">Выбрать</button>`
          : `<button class="btn primary" data-act="buy" data-arg="${v.id}" ${affordable ? '' : 'disabled'}>Купить за ${rub(v.price)}</button>`;
      return `
        <div class="vehicle ${current ? 'current' : ''}">
          <div class="veh-icon">${v.icon}</div>
          <div class="veh-info">
            <b>${esc(v.name)}</b>
            <small>${esc(v.description)}</small>
            <small class="muted">до ${Math.round(v.maxSpeed * 3.6)} км/ч · заказы ${fmtDist(v.orderRange[0])}–${fmtDist(v.orderRange[1])}</small>
          </div>
          <div class="veh-buy">${button}</div>
        </div>`;
    }).join('');
    this.openModal(`
      <div class="modal-head"><h2>Гараж</h2><span class="chip money">💰 ${rub(p.money)}</span></div>
      ${this.game.active ? '<p class="muted">Транспорт можно сменить и во время заказа, таймер на паузе.</p>' : ''}
      <div class="vehicles">${cards}</div>
      <div class="modal-foot"><button class="btn" data-act="close">Закрыть</button></div>
    `);
  }

  openHelp(): void {
    const p = this.game.profile;
    const map = this.game.map;
    this.openModal(`
      <div class="modal-head"><h2>Курьер: ${esc(map.name)}</h2></div>
      <p>Ты — курьер. Бери заказы в настоящих кафе и магазинах города и вези их по настоящим адресам.</p>
      <ul class="help">
        <li><b>Движение:</b> WASD / стрелки, или зажми палец (мышь) и тяни — как джойстик.</li>
        <li><b>Заказ:</b> нажми карточку справа (или 1, 2, 3). Оранжевый круг — забрать, зелёный — отдать.</li>
        <li><b>Навигатор:</b> синяя линия ведёт по улицам, стрелка у края экрана — к цели.</li>
        <li><b>Деньги:</b> быстрее — больше чаевых; доставки вовремя подряд дают бонус серии.</li>
        <li><b>Гараж:</b> велосипед, самокат, мопед — быстрее и дальние заказы.</li>
        <li><b>Масштаб:</b> колесо мыши или щипок двумя пальцами. <b>V</b> — 3D-вид (бета).</li>
      </ul>
      <p class="muted">Статистика: доставлено ${p.deliveries}, заработано ${rub(p.earned)}, проехано ${fmtDist(p.distance)}, лучшая серия ${p.bestStreak}.</p>
      <p class="muted small">Карта собрана из данных OpenStreetMap (© участники OpenStreetMap, ODbL) — ${esc(new Date(map.generatedAt).toLocaleDateString('ru-RU'))}.</p>
      <div class="modal-foot">
        <button class="btn" data-act="unstuck" title="R">Застрял? На дорогу</button>
        <button class="btn primary" data-act="close">Играть</button>
      </div>
    `);
  }
}
