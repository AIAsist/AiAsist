import crypto from 'node:crypto';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(String(password), salt, 32);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, new Date().toISOString());
  return token;
}

/** Пользователь по заголовку Authorization: Bearer <token>, либо null. */
export function authenticate(db, req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const user = db
    .prepare(
      `SELECT u.id, u.role, u.name, u.phone, u.active, u.zone_id, u.on_shift
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    )
    .get(token);
  if (!user || !user.active) return null;
  return { ...user, token };
}

export function publicUser(u) {
  return { id: u.id, role: u.role, name: u.name, phone: u.phone, zone_id: u.zone_id, on_shift: !!u.on_shift };
}
