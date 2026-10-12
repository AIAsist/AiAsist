import { createSession, hashPassword, publicUser, verifyPassword } from '../auth.js';
import { HttpError } from '../http.js';
import { getOrderDetail } from '../orders.js';
import { BOOKING_DAYS, SLOTS, normalizePhone, now, str } from '../util.js';

export function registerCommon(router) {
  // Справочники для форм: районы, тарифы, временные окна.
  router.route('GET', '/api/meta', null, ({ db }) => ({
    zones: db.prepare('SELECT id, name FROM zones WHERE active = 1 ORDER BY name').all(),
    tariffs: db.prepare('SELECT * FROM tariffs WHERE active = 1 ORDER BY price').all(),
    slots: SLOTS,
    booking_days: BOOKING_DAYS,
  }));

  // Регистрация доступна только клиентам; курьеров и админов заводит администратор.
  router.route('POST', '/api/auth/register', null, ({ db, body }) => {
    const phone = normalizePhone(body.phone);
    const name = str(body.name, 'Имя', { max: 100 });
    const password = str(body.password, 'Пароль', { max: 100 });
    if (password.length < 4) throw new HttpError(400, 'Пароль должен быть не короче 4 символов');
    if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) throw new HttpError(409, 'Этот телефон уже зарегистрирован');
    const id = Number(
      db
        .prepare("INSERT INTO users (role, name, phone, password_hash, created_at) VALUES ('client', ?, ?, ?, ?)")
        .run(name, phone, hashPassword(password), now()).lastInsertRowid,
    );
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return { token: createSession(db, id), user: publicUser(user) };
  });

  router.route('POST', '/api/auth/login', null, ({ db, body }) => {
    const phone = normalizePhone(body.phone);
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user || !verifyPassword(body.password ?? '', user.password_hash)) throw new HttpError(401, 'Неверный телефон или пароль');
    if (!user.active) throw new HttpError(403, 'Аккаунт заблокирован');
    if (body.role && body.role !== user.role) throw new HttpError(403, 'Этот аккаунт не предназначен для этого приложения');
    return { token: createSession(db, user.id), user: publicUser(user) };
  });

  router.route('POST', '/api/auth/logout', [], ({ db, user }) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(user.token);
    return { ok: true };
  });

  router.route('GET', '/api/me', [], ({ user }) => publicUser(user));

  // Карточка заказа с историей и фото — для всех ролей (с проверкой доступа).
  router.route('GET', '/api/orders/:id', [], ({ db, user, params }) => getOrderDetail(db, Number(params.id), user));
}
