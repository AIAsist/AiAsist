import { HttpError } from './http.js';
import { now } from './util.js';

export const STATUS_LABELS = {
  new: 'Новый',
  assigned: 'Курьер назначен',
  on_way: 'Курьер в пути',
  picked_up: 'Мусор забран',
  done: 'Выполнен',
  problem: 'Проблема',
  cancelled: 'Отменён',
};

/** Допустимые переходы статусов заказа. */
export const TRANSITIONS = {
  new: ['assigned', 'cancelled'],
  assigned: ['new', 'on_way', 'problem', 'cancelled'],
  on_way: ['picked_up', 'problem', 'cancelled'],
  picked_up: ['done', 'problem'],
  problem: ['new', 'assigned', 'done', 'cancelled'],
  done: [],
  cancelled: [],
};

/** Активные (незавершённые) статусы. */
export const ACTIVE_STATUSES = ['new', 'assigned', 'on_way', 'picked_up', 'problem'];

const TIMESTAMP = {
  assigned: 'assigned_at',
  on_way: 'started_at',
  picked_up: 'picked_up_at',
  done: 'completed_at',
  cancelled: 'cancelled_at',
};

/** Фото, без которых курьер не может перевести заказ в статус. */
export const REQUIRED_PHOTO = { picked_up: 'pickup', done: 'disposal' };

export const ORDER_SELECT = `
  SELECT o.*,
         c.name AS client_name, c.phone AS client_phone,
         k.name AS courier_name, k.phone AS courier_phone,
         t.name AS tariff_name, z.name AS zone_name,
         a.street, a.house, a.entrance, a.floor, a.apartment, a.intercom, a.comment AS address_comment
  FROM orders o
  JOIN users c ON c.id = o.client_id
  LEFT JOIN users k ON k.id = o.courier_id
  JOIN tariffs t ON t.id = o.tariff_id
  JOIN zones z ON z.id = o.zone_id
  JOIN addresses a ON a.id = o.address_id`;

export function getOrder(db, id) {
  const order = db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id);
  if (!order) throw new HttpError(404, 'Заказ не найден');
  return order;
}

/** Заказ с историей и фотоотчётом. Проверяет, что пользователь имеет к нему доступ. */
export function getOrderDetail(db, id, user) {
  const order = getOrder(db, id);
  const allowed =
    user.role === 'admin' ||
    (user.role === 'client' && order.client_id === user.id) ||
    (user.role === 'courier' && (order.courier_id === user.id || order.status === 'new'));
  if (!allowed) throw new HttpError(404, 'Заказ не найден');
  order.events = db
    .prepare(
      `SELECT e.status, e.note, e.created_at, u.name AS actor_name, u.role AS actor_role
       FROM order_events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.order_id = ? ORDER BY e.id`,
    )
    .all(id);
  order.photos = db
    .prepare('SELECT id, kind, file, created_at FROM order_photos WHERE order_id = ? ORDER BY id')
    .all(id)
    .map((p) => ({ ...p, url: '/uploads/' + p.file }));
  return order;
}

export function hasPhoto(db, orderId, kind) {
  return !!db.prepare('SELECT 1 FROM order_photos WHERE order_id = ? AND kind = ? LIMIT 1').get(orderId, kind);
}

/**
 * Переводит заказ в новый статус с проверкой допустимости перехода и пишет событие в историю.
 * opts.courierId — для перехода в assigned; opts.note — причина отмены / описание проблемы / комментарий.
 */
export function transition(db, order, to, { actorId, note = null, courierId } = {}) {
  if (!STATUS_LABELS[to]) throw new HttpError(400, 'Неизвестный статус');
  if (!TRANSITIONS[order.status].includes(to)) {
    throw new HttpError(409, `Нельзя перевести заказ из «${STATUS_LABELS[order.status]}» в «${STATUS_LABELS[to]}»`);
  }
  const sets = { status: to };
  if (TIMESTAMP[to]) sets[TIMESTAMP[to]] = now();

  if (to === 'assigned') {
    const id = courierId ?? order.courier_id;
    if (!id) throw new HttpError(400, 'Не указан курьер');
    const courier = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'courier' AND active = 1").get(id);
    if (!courier) throw new HttpError(400, 'Курьер не найден или заблокирован');
    sets.courier_id = id;
  }
  if (to === 'new') {
    Object.assign(sets, { courier_id: null, assigned_at: null, started_at: null, problem_note: null });
  }
  if (to === 'cancelled') sets.cancel_reason = note;
  if (to === 'problem') {
    if (!note) throw new HttpError(400, 'Опишите проблему');
    sets.problem_note = note;
  }

  const cols = Object.keys(sets);
  db.prepare(`UPDATE orders SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => sets[c]), order.id);
  db.prepare('INSERT INTO order_events (order_id, status, actor_id, note, created_at) VALUES (?, ?, ?, ?, ?)').run(
    order.id,
    to,
    actorId ?? null,
    note,
    now(),
  );
  return getOrder(db, order.id);
}
