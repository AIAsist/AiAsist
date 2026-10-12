import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tx } from '../db.js';
import { HttpError } from '../http.js';
import { ACTIVE_STATUSES, ORDER_SELECT, REQUIRED_PHOTO, STATUS_LABELS, getOrder, hasPhoto, transition } from '../orders.js';
import { addDays, localDate, now, str } from '../util.js';

const COURIER = ['courier'];
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** Курьер может менять только свои заказы. */
function ownOrder(db, user, id) {
  const order = getOrder(db, Number(id));
  if (order.courier_id !== user.id) throw new HttpError(404, 'Заказ не найден');
  return order;
}

export function registerCourier(router) {
  router.route('POST', '/api/courier/shift/start', COURIER, ({ db, user }) => {
    if (user.on_shift) return { on_shift: true };
    tx(db, () => {
      db.prepare('UPDATE users SET on_shift = 1 WHERE id = ?').run(user.id);
      db.prepare('INSERT INTO shifts (courier_id, started_at) VALUES (?, ?)').run(user.id, now());
    });
    return { on_shift: true };
  });

  router.route('POST', '/api/courier/shift/end', COURIER, ({ db, user }) => {
    const active = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE courier_id = ? AND status IN ('on_way', 'picked_up')").get(user.id).n;
    if (active) throw new HttpError(409, 'Сначала завершите заказы, по которым вы уже выехали');
    tx(db, () => {
      db.prepare('UPDATE users SET on_shift = 0 WHERE id = ?').run(user.id);
      db.prepare('UPDATE shifts SET ended_at = ? WHERE courier_id = ? AND ended_at IS NULL').run(now(), user.id);
    });
    return { on_shift: false };
  });

  // Свободные заказы в районе курьера (или во всех районах, если район не задан).
  router.route('GET', '/api/courier/orders/available', COURIER, ({ db, user }) =>
    db
      .prepare(
        `${ORDER_SELECT} WHERE o.status = 'new' AND (? IS NULL OR o.zone_id = ?) AND o.slot_date <= ?
         ORDER BY o.slot_date, o.slot, o.id`,
      )
      .all(user.zone_id, user.zone_id, addDays(localDate(), 1)),
  );

  // Мои активные заказы + выполненные сегодня.
  router.route('GET', '/api/courier/orders/mine', COURIER, ({ db, user }) =>
    db
      .prepare(
        `${ORDER_SELECT} WHERE o.courier_id = ?
           AND (o.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) OR (o.status = 'done' AND o.slot_date = ?))
         ORDER BY o.status = 'done', o.slot_date, o.slot, o.id`,
      )
      .all(user.id, ...ACTIVE_STATUSES, localDate()),
  );

  router.route('POST', '/api/courier/orders/:id/take', COURIER, ({ db, user, params }) => {
    if (!user.on_shift) throw new HttpError(409, 'Начните смену, чтобы брать заказы');
    const order = getOrder(db, Number(params.id));
    if (order.status !== 'new') throw new HttpError(409, 'Заказ уже забрал другой курьер');
    if (user.zone_id && order.zone_id !== user.zone_id) throw new HttpError(403, 'Заказ не в вашем районе');
    return transition(db, order, 'assigned', { actorId: user.id, courierId: user.id, note: 'Курьер взял заказ' });
  });

  router.route('POST', '/api/courier/orders/:id/release', COURIER, ({ db, user, params, body }) => {
    const order = ownOrder(db, user, params.id);
    if (order.status !== 'assigned') throw new HttpError(409, 'Отказаться можно только до выезда');
    return transition(db, order, 'new', { actorId: user.id, note: str(body.reason, 'Причина', { required: false, max: 300 }) ?? 'Курьер отказался' });
  });

  // Смена статуса курьером: on_way → picked_up (нужно фото у двери) → done (нужно фото у контейнера), либо problem.
  router.route('POST', '/api/courier/orders/:id/status', COURIER, ({ db, user, params, body }) => {
    const order = ownOrder(db, user, params.id);
    const to = body.status;
    if (!['on_way', 'picked_up', 'done', 'problem'].includes(to)) throw new HttpError(400, 'Курьер не может установить этот статус');
    const photoKind = REQUIRED_PHOTO[to];
    if (photoKind && !hasPhoto(db, order.id, photoKind)) {
      throw new HttpError(409, `Для статуса «${STATUS_LABELS[to]}» нужно приложить фото`);
    }
    return transition(db, order, to, { actorId: user.id, note: str(body.note, 'Комментарий', { required: false, max: 500 }) });
  });

  // Фотоотчёт: body = { kind: 'pickup' | 'disposal' | 'problem', data: 'data:image/jpeg;base64,...' }
  router.route('POST', '/api/courier/orders/:id/photos', COURIER, ({ db, user, params, body, uploadsDir }) => {
    const order = ownOrder(db, user, params.id);
    if (!['pickup', 'disposal', 'problem'].includes(body.kind)) throw new HttpError(400, 'Некорректный тип фото');
    const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(String(body.data ?? ''));
    if (!m || !PHOTO_TYPES[m[1]]) throw new HttpError(400, 'Поддерживаются JPEG, PNG и WebP');
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > MAX_PHOTO_BYTES) throw new HttpError(400, 'Фото должно быть не больше 5 МБ');

    const file = `${order.id}-${crypto.randomUUID()}.${PHOTO_TYPES[m[1]]}`;
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, file), buf);
    const id = db
      .prepare('INSERT INTO order_photos (order_id, kind, file, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(order.id, body.kind, file, user.id, now()).lastInsertRowid;
    return { id: Number(id), kind: body.kind, url: '/uploads/' + file };
  });

  // Личная статистика и заработок курьера.
  router.route('GET', '/api/courier/stats', COURIER, ({ db, user }) => {
    const today = localDate();
    const period = (from) =>
      db
        .prepare(
          `SELECT COUNT(*) AS done, COALESCE(SUM(courier_fee), 0) AS earnings, ROUND(AVG(rating), 2) AS rating
           FROM orders WHERE courier_id = ? AND status = 'done' AND slot_date BETWEEN ? AND ?`,
        )
        .get(user.id, from, today);
    return {
      today: period(today),
      week: period(addDays(today, -6)),
      month: period(today.slice(0, 8) + '01'),
      total: db
        .prepare("SELECT COUNT(*) AS done, COALESCE(SUM(courier_fee), 0) AS earnings, ROUND(AVG(rating), 2) AS rating FROM orders WHERE courier_id = ? AND status = 'done'")
        .get(user.id),
      recent: db.prepare(`${ORDER_SELECT} WHERE o.courier_id = ? AND o.status = 'done' ORDER BY o.completed_at DESC LIMIT 20`).all(user.id),
    };
  });
}
