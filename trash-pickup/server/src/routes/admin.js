import { hashPassword } from '../auth.js';
import { HttpError } from '../http.js';
import { ACTIVE_STATUSES, ORDER_SELECT, STATUS_LABELS, getOrder, transition } from '../orders.js';
import { addDays, int, localDate, normalizePhone, now, str } from '../util.js';

const ADMIN = ['admin'];

function dateParam(value, fallback) {
  if (!value) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, 'Дата должна быть в формате ГГГГ-ММ-ДД');
  return value;
}

/** UPDATE по белому списку полей; пустые/отсутствующие поля не трогаем. */
function patch(db, table, id, fields) {
  const cols = Object.keys(fields).filter((k) => fields[k] !== undefined);
  if (!cols.length) return;
  const r = db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => fields[c]), id);
  if (!r.changes) throw new HttpError(404, 'Запись не найдена');
}

const bool = (v) => (v === undefined ? undefined : v ? 1 : 0);
const optInt = (v, field, opts) => (v === undefined ? undefined : int(v, field, opts));
const optStr = (v, field, opts) => (v === undefined ? undefined : str(v, field, opts));

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function registerAdmin(router) {
  // ——— Дашборд ———
  router.route('GET', '/api/admin/dashboard', ADMIN, ({ db }) => {
    const today = localDate();
    const byStatus = Object.fromEntries(Object.keys(STATUS_LABELS).map((s) => [s, 0]));
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM orders WHERE slot_date = ? GROUP BY status').all(today)) byStatus[r.status] = r.n;
    const ph = ACTIVE_STATUSES.map(() => '?').join(',');
    return {
      date: today,
      today: byStatus,
      revenue_today: db.prepare("SELECT COALESCE(SUM(price), 0) AS v FROM orders WHERE slot_date = ? AND status = 'done'").get(today).v,
      couriers_on_shift: db.prepare("SELECT id, name, zone_id FROM users WHERE role = 'courier' AND active = 1 AND on_shift = 1 ORDER BY name").all(),
      unassigned: db.prepare(`${ORDER_SELECT} WHERE o.status = 'new' AND o.slot_date <= ? ORDER BY o.slot_date, o.slot`).all(addDays(today, 1)),
      problems: db.prepare(`${ORDER_SELECT} WHERE o.status = 'problem' ORDER BY o.slot_date, o.slot`).all(),
      overdue: db
        .prepare(`${ORDER_SELECT} WHERE o.status IN (${ph}) AND o.slot_date < ? ORDER BY o.slot_date, o.slot`)
        .all(...ACTIVE_STATUSES, today),
    };
  });

  // ——— Заказы ———
  router.route('GET', '/api/admin/orders', ADMIN, ({ db, query }) => {
    const where = [];
    const args = [];
    if (query.status === 'active') {
      where.push(`o.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`);
      args.push(...ACTIVE_STATUSES);
    } else if (query.status) {
      where.push('o.status = ?');
      args.push(query.status);
    }
    if (query.date_from) (where.push('o.slot_date >= ?'), args.push(dateParam(query.date_from)));
    if (query.date_to) (where.push('o.slot_date <= ?'), args.push(dateParam(query.date_to)));
    if (query.courier_id) (where.push('o.courier_id = ?'), args.push(Number(query.courier_id)));
    if (query.zone_id) (where.push('o.zone_id = ?'), args.push(Number(query.zone_id)));
    if (query.q) {
      where.push('(c.name LIKE ? OR c.phone LIKE ? OR a.street LIKE ? OR CAST(o.id AS TEXT) = ?)');
      const like = `%${query.q}%`;
      args.push(like, like, like, query.q);
    }
    const sql = `${ORDER_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.slot_date DESC, o.slot DESC, o.id DESC LIMIT 500`;
    return db.prepare(sql).all(...args);
  });

  router.route('POST', '/api/admin/orders/:id/assign', ADMIN, ({ db, user, params, body }) => {
    const order = getOrder(db, Number(params.id));
    const courierId = int(body.courier_id, 'Курьер');
    // Переназначение уже назначенного заказа: возвращаем в пул и сразу назначаем нового.
    if (order.status === 'assigned') {
      if (order.courier_id === courierId) return order;
      const back = transition(db, order, 'new', { actorId: user.id, note: 'Снят администратором' });
      return transition(db, back, 'assigned', { actorId: user.id, courierId, note: 'Назначен администратором' });
    }
    return transition(db, order, 'assigned', { actorId: user.id, courierId, note: 'Назначен администратором' });
  });

  router.route('POST', '/api/admin/orders/:id/status', ADMIN, ({ db, user, params, body }) => {
    const order = getOrder(db, Number(params.id));
    return transition(db, order, body.status, {
      actorId: user.id,
      courierId: body.courier_id ? Number(body.courier_id) : undefined,
      note: str(body.note, 'Комментарий', { required: false, max: 500 }),
    });
  });

  // ——— Курьеры ———
  router.route('GET', '/api/admin/couriers', ADMIN, ({ db }) =>
    db
      .prepare(
        `SELECT u.id, u.name, u.phone, u.active, u.on_shift, u.zone_id, z.name AS zone_name, u.created_at,
                (SELECT COUNT(*) FROM orders o WHERE o.courier_id = u.id AND o.status = 'done') AS done,
                (SELECT COUNT(*) FROM orders o WHERE o.courier_id = u.id AND o.status IN ('assigned', 'on_way', 'picked_up', 'problem')) AS active_orders,
                (SELECT ROUND(AVG(rating), 2) FROM orders o WHERE o.courier_id = u.id AND rating IS NOT NULL) AS rating
         FROM users u LEFT JOIN zones z ON z.id = u.zone_id
         WHERE u.role = 'courier' ORDER BY u.active DESC, u.name`,
      )
      .all(),
  );

  router.route('POST', '/api/admin/couriers', ADMIN, ({ db, body }) => {
    const phone = normalizePhone(body.phone);
    if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) throw new HttpError(409, 'Этот телефон уже зарегистрирован');
    const password = str(body.password, 'Пароль', { max: 100 });
    const id = db
      .prepare("INSERT INTO users (role, name, phone, password_hash, zone_id, created_at) VALUES ('courier', ?, ?, ?, ?, ?)")
      .run(str(body.name, 'Имя', { max: 100 }), phone, hashPassword(password), body.zone_id ? int(body.zone_id, 'Район') : null, now()).lastInsertRowid;
    return { id: Number(id) };
  });

  router.route('PATCH', '/api/admin/couriers/:id', ADMIN, ({ db, params, body }) => {
    const id = Number(params.id);
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'courier'").get(id)) throw new HttpError(404, 'Курьер не найден');
    patch(db, 'users', id, {
      name: optStr(body.name, 'Имя', { max: 100 }),
      zone_id: body.zone_id === undefined ? undefined : body.zone_id ? int(body.zone_id, 'Район') : null,
      active: bool(body.active),
      password_hash: body.password ? hashPassword(body.password) : undefined,
    });
    if (body.active === false) {
      db.prepare('UPDATE users SET on_shift = 0 WHERE id = ?').run(id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    return { ok: true };
  });

  // ——— Клиенты ———
  router.route('GET', '/api/admin/clients', ADMIN, ({ db, query }) => {
    const like = `%${query.q ?? ''}%`;
    return db
      .prepare(
        `SELECT u.id, u.name, u.phone, u.active, u.created_at,
                COUNT(o.id) AS orders,
                COALESCE(SUM(CASE WHEN o.status = 'done' THEN o.price END), 0) AS spent,
                MAX(o.slot_date) AS last_order
         FROM users u LEFT JOIN orders o ON o.client_id = u.id
         WHERE u.role = 'client' AND (u.name LIKE ? OR u.phone LIKE ?)
         GROUP BY u.id ORDER BY u.id DESC LIMIT 500`,
      )
      .all(like, like);
  });

  router.route('PATCH', '/api/admin/clients/:id', ADMIN, ({ db, params, body }) => {
    const id = Number(params.id);
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'client'").get(id)) throw new HttpError(404, 'Клиент не найден');
    patch(db, 'users', id, { active: bool(body.active) });
    if (body.active === false) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return { ok: true };
  });

  // ——— Тарифы ———
  router.route('GET', '/api/admin/tariffs', ADMIN, ({ db }) => db.prepare('SELECT * FROM tariffs ORDER BY active DESC, price').all());

  // required = true при создании (все поля обязательны), false при редактировании (только переданные).
  const tariffFields = (body, required) => {
    const num = (v, f) => (required ? int(v, f, { min: 0 }) : optInt(v, f, { min: 0 }));
    return {
      name: required ? str(body.name, 'Название', { max: 100 }) : optStr(body.name, 'Название', { max: 100 }),
      description: body.description === undefined ? undefined : str(body.description, 'Описание', { required: false, max: 500 }),
      price: num(body.price, 'Цена'),
      included_bags: num(body.included_bags, 'Пакетов включено'),
      extra_bag_price: num(body.extra_bag_price, 'Цена доп. пакета'),
      courier_fee: num(body.courier_fee, 'Выплата курьеру'),
      extra_bag_fee: num(required ? (body.extra_bag_fee ?? 0) : body.extra_bag_fee, 'Выплата за доп. пакет'),
      active: bool(body.active),
    };
  };

  router.route('POST', '/api/admin/tariffs', ADMIN, ({ db, body }) => {
    const f = tariffFields(body, true);
    const id = db
      .prepare('INSERT INTO tariffs (name, description, price, included_bags, extra_bag_price, courier_fee, extra_bag_fee) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(f.name, f.description ?? null, f.price, f.included_bags, f.extra_bag_price, f.courier_fee, f.extra_bag_fee).lastInsertRowid;
    return { id: Number(id) };
  });

  router.route('PATCH', '/api/admin/tariffs/:id', ADMIN, ({ db, params, body }) => {
    patch(db, 'tariffs', Number(params.id), tariffFields(body, false));
    return { ok: true };
  });

  // ——— Районы ———
  router.route('GET', '/api/admin/zones', ADMIN, ({ db }) =>
    db
      .prepare(
        `SELECT z.*, (SELECT COUNT(*) FROM users u WHERE u.zone_id = z.id AND u.role = 'courier' AND u.active = 1) AS couriers
         FROM zones z ORDER BY z.active DESC, z.name`,
      )
      .all(),
  );

  router.route('POST', '/api/admin/zones', ADMIN, ({ db, body }) => {
    const name = str(body.name, 'Название', { max: 100 });
    if (db.prepare('SELECT 1 FROM zones WHERE name = ?').get(name)) throw new HttpError(409, 'Такой район уже есть');
    return { id: Number(db.prepare('INSERT INTO zones (name) VALUES (?)').run(name).lastInsertRowid) };
  });

  router.route('PATCH', '/api/admin/zones/:id', ADMIN, ({ db, params, body }) => {
    patch(db, 'zones', Number(params.id), { name: optStr(body.name, 'Название', { max: 100 }), active: bool(body.active) });
    return { ok: true };
  });

  // ——— Отчёты ———
  router.route('GET', '/api/admin/reports', ADMIN, ({ db, query }) => {
    const to = dateParam(query.to, localDate());
    const from = dateParam(query.from, addDays(to, -29));
    const range = [from, to];

    const summary = db
      .prepare(
        `SELECT COUNT(*) AS orders,
                SUM(status = 'done') AS done,
                SUM(status = 'cancelled') AS cancelled,
                SUM(status = 'problem') AS problems,
                SUM(status IN ('new', 'assigned', 'on_way', 'picked_up')) AS in_progress,
                COALESCE(SUM(CASE WHEN status = 'done' THEN price END), 0) AS revenue,
                COALESCE(SUM(CASE WHEN status = 'done' THEN courier_fee END), 0) AS courier_payouts,
                COALESCE(SUM(CASE WHEN status = 'done' THEN bags END), 0) AS bags,
                ROUND(AVG(rating), 2) AS avg_rating,
                COUNT(DISTINCT client_id) AS clients
         FROM orders WHERE slot_date BETWEEN ? AND ?`,
      )
      .get(...range);
    summary.margin = summary.revenue - summary.courier_payouts;
    // Среднее время от взятия заказа до выноса (минуты).
    summary.avg_minutes = db
      .prepare(
        `SELECT ROUND(AVG((julianday(completed_at) - julianday(assigned_at)) * 24 * 60)) AS v
         FROM orders WHERE status = 'done' AND assigned_at IS NOT NULL AND slot_date BETWEEN ? AND ?`,
      )
      .get(...range).v;

    return {
      from,
      to,
      summary,
      daily: db
        .prepare(
          `SELECT slot_date AS date, COUNT(*) AS orders, SUM(status = 'done') AS done, SUM(status = 'cancelled') AS cancelled,
                  COALESCE(SUM(CASE WHEN status = 'done' THEN price END), 0) AS revenue
           FROM orders WHERE slot_date BETWEEN ? AND ? GROUP BY slot_date ORDER BY slot_date`,
        )
        .all(...range),
      couriers: db
        .prepare(
          `SELECT u.id, u.name, COUNT(o.id) AS orders, SUM(o.status = 'done') AS done, SUM(o.status = 'problem') AS problems,
                  COALESCE(SUM(CASE WHEN o.status = 'done' THEN o.courier_fee END), 0) AS earnings,
                  ROUND(AVG(o.rating), 2) AS rating
           FROM users u JOIN orders o ON o.courier_id = u.id AND o.slot_date BETWEEN ? AND ?
           WHERE u.role = 'courier' GROUP BY u.id ORDER BY done DESC`,
        )
        .all(...range),
      zones: db
        .prepare(
          `SELECT z.name, COUNT(o.id) AS orders, SUM(o.status = 'done') AS done,
                  COALESCE(SUM(CASE WHEN o.status = 'done' THEN o.price END), 0) AS revenue
           FROM zones z JOIN orders o ON o.zone_id = z.id AND o.slot_date BETWEEN ? AND ?
           GROUP BY z.id ORDER BY orders DESC`,
        )
        .all(...range),
      tariffs: db
        .prepare(
          `SELECT t.name, COUNT(o.id) AS orders, COALESCE(SUM(CASE WHEN o.status = 'done' THEN o.price END), 0) AS revenue
           FROM tariffs t JOIN orders o ON o.tariff_id = t.id AND o.slot_date BETWEEN ? AND ?
           GROUP BY t.id ORDER BY orders DESC`,
        )
        .all(...range),
    };
  });

  // Выгрузка заказов за период в CSV (разделитель «;» — открывается в Excel).
  router.route('GET', '/api/admin/reports/orders.csv', ADMIN, ({ db, query, res }) => {
    const to = dateParam(query.to, localDate());
    const from = dateParam(query.from, addDays(to, -29));
    const rows = db.prepare(`${ORDER_SELECT} WHERE o.slot_date BETWEEN ? AND ? ORDER BY o.slot_date, o.slot, o.id`).all(from, to);
    const header = ['№', 'Дата', 'Время', 'Статус', 'Клиент', 'Телефон', 'Район', 'Адрес', 'Тариф', 'Пакетов', 'Цена', 'Курьер', 'Выплата курьеру', 'Оценка', 'Отзыв', 'Причина отмены / проблема'];
    const lines = rows.map((o) =>
      [
        o.id,
        o.slot_date,
        o.slot,
        STATUS_LABELS[o.status],
        o.client_name,
        o.client_phone,
        o.zone_name,
        `${o.street}, ${o.house}${o.apartment ? ', кв. ' + o.apartment : ''}`,
        o.tariff_name,
        o.bags,
        o.price,
        o.courier_name,
        o.status === 'done' ? o.courier_fee : '',
        o.rating,
        o.review,
        o.cancel_reason || o.problem_note,
      ]
        .map(csvCell)
        .join(';'),
    );
    const body = '﻿' + [header.join(';'), ...lines].join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="orders_${from}_${to}.csv"`,
    });
    res.end(body);
  });
}
