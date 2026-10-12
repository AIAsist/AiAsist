import { tx } from '../db.js';
import { HttpError } from '../http.js';
import { ORDER_SELECT, getOrder, transition } from '../orders.js';
import { BOOKING_DAYS, SLOTS, addDays, calcPrice, int, localDate, now, str } from '../util.js';

const CLIENT = ['client'];

export function registerClient(router) {
  router.route('GET', '/api/client/addresses', CLIENT, ({ db, user }) =>
    db
      .prepare(
        `SELECT a.*, z.name AS zone_name FROM addresses a JOIN zones z ON z.id = a.zone_id
         WHERE a.user_id = ? AND a.deleted = 0 ORDER BY a.id DESC`,
      )
      .all(user.id),
  );

  router.route('POST', '/api/client/addresses', CLIENT, ({ db, user, body }) => {
    const zoneId = int(body.zone_id, 'Район');
    if (!db.prepare('SELECT 1 FROM zones WHERE id = ? AND active = 1').get(zoneId)) throw new HttpError(400, 'В этом районе мы пока не работаем');
    const opt = { required: false, max: 50 };
    const id = db
      .prepare(
        `INSERT INTO addresses (user_id, zone_id, street, house, entrance, floor, apartment, intercom, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id,
        zoneId,
        str(body.street, 'Улица'),
        str(body.house, 'Дом', { max: 20 }),
        str(body.entrance, 'Подъезд', opt),
        str(body.floor, 'Этаж', opt),
        str(body.apartment, 'Квартира', opt),
        str(body.intercom, 'Домофон', opt),
        str(body.comment, 'Комментарий', { required: false, max: 500 }),
        now(),
      ).lastInsertRowid;
    return db.prepare('SELECT * FROM addresses WHERE id = ?').get(id);
  });

  router.route('DELETE', '/api/client/addresses/:id', CLIENT, ({ db, user, params }) => {
    const r = db.prepare('UPDATE addresses SET deleted = 1 WHERE id = ? AND user_id = ?').run(Number(params.id), user.id);
    if (!r.changes) throw new HttpError(404, 'Адрес не найден');
    return { ok: true };
  });

  router.route('GET', '/api/client/orders', CLIENT, ({ db, user }) =>
    db.prepare(`${ORDER_SELECT} WHERE o.client_id = ? ORDER BY o.slot_date DESC, o.slot DESC, o.id DESC LIMIT 100`).all(user.id),
  );

  router.route('POST', '/api/client/orders', CLIENT, ({ db, user, body }) => {
    const address = db.prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ? AND deleted = 0').get(int(body.address_id, 'Адрес'), user.id);
    if (!address) throw new HttpError(400, 'Адрес не найден');
    const tariff = db.prepare('SELECT * FROM tariffs WHERE id = ? AND active = 1').get(int(body.tariff_id, 'Тариф'));
    if (!tariff) throw new HttpError(400, 'Тариф недоступен');
    const bags = int(body.bags, 'Количество пакетов', { min: 1, max: 20 });

    const slotDate = str(body.slot_date, 'Дата', { max: 10 });
    const slot = str(body.slot, 'Время', { max: 11 });
    const today = localDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate) || slotDate < today || slotDate > addDays(today, BOOKING_DAYS)) {
      throw new HttpError(400, `Дату можно выбрать на ${BOOKING_DAYS} дней вперёд`);
    }
    if (!SLOTS.includes(slot)) throw new HttpError(400, 'Некорректное время');
    if (slotDate === today && Number(slot.slice(6, 8)) <= new Date().getHours()) throw new HttpError(400, 'Это время уже прошло');

    const { price, courier_fee } = calcPrice(tariff, bags);
    const id = tx(db, () => {
      const orderId = Number(
        db
          .prepare(
            `INSERT INTO orders (client_id, address_id, zone_id, tariff_id, bags, slot_date, slot, comment, status, price, courier_fee, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
          )
          .run(user.id, address.id, address.zone_id, tariff.id, bags, slotDate, slot, str(body.comment, 'Комментарий', { required: false, max: 500 }), price, courier_fee, now())
          .lastInsertRowid,
      );
      db.prepare("INSERT INTO order_events (order_id, status, actor_id, created_at) VALUES (?, 'new', ?, ?)").run(orderId, user.id, now());
      return orderId;
    });
    return getOrder(db, id);
  });

  router.route('POST', '/api/client/orders/:id/cancel', CLIENT, ({ db, user, params, body }) => {
    const order = getOrder(db, Number(params.id));
    if (order.client_id !== user.id) throw new HttpError(404, 'Заказ не найден');
    if (!['new', 'assigned'].includes(order.status)) throw new HttpError(409, 'Курьер уже выехал — отменить заказ можно через поддержку');
    return transition(db, order, 'cancelled', { actorId: user.id, note: str(body.reason, 'Причина', { required: false, max: 300 }) ?? 'Отменён клиентом' });
  });

  router.route('POST', '/api/client/orders/:id/rate', CLIENT, ({ db, user, params, body }) => {
    const order = getOrder(db, Number(params.id));
    if (order.client_id !== user.id) throw new HttpError(404, 'Заказ не найден');
    if (order.status !== 'done') throw new HttpError(409, 'Оценить можно только выполненный заказ');
    if (order.rating) throw new HttpError(409, 'Заказ уже оценён');
    db.prepare('UPDATE orders SET rating = ?, review = ? WHERE id = ?').run(
      int(body.rating, 'Оценка', { min: 1, max: 5 }),
      str(body.review, 'Отзыв', { required: false, max: 1000 }),
      order.id,
    );
    return getOrder(db, order.id);
  });
}
