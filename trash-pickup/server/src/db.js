import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './auth.js';
import { localDate, now } from './util.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('client', 'courier', 'admin')),
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  zone_id INTEGER REFERENCES zones(id),      -- для курьера: район работы (NULL = все районы)
  on_shift INTEGER NOT NULL DEFAULT 0,       -- для курьера: на смене или нет
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  street TEXT NOT NULL,
  house TEXT NOT NULL,
  entrance TEXT,
  floor TEXT,
  apartment TEXT,
  intercom TEXT,
  comment TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tariffs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,            -- ₽ за вынос
  included_bags INTEGER NOT NULL,    -- пакетов включено в цену
  extra_bag_price INTEGER NOT NULL,  -- ₽ за каждый пакет сверх включённых
  courier_fee INTEGER NOT NULL,      -- ₽ курьеру за заказ
  extra_bag_fee INTEGER NOT NULL DEFAULT 0, -- ₽ курьеру за доп. пакет
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES users(id),
  address_id INTEGER NOT NULL REFERENCES addresses(id),
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  tariff_id INTEGER NOT NULL REFERENCES tariffs(id),
  courier_id INTEGER REFERENCES users(id),
  bags INTEGER NOT NULL,
  slot_date TEXT NOT NULL,           -- YYYY-MM-DD
  slot TEXT NOT NULL,                -- '18:00-20:00'
  comment TEXT,
  status TEXT NOT NULL,
  price INTEGER NOT NULL,
  courier_fee INTEGER NOT NULL,
  cancel_reason TEXT,
  problem_note TEXT,
  rating INTEGER,
  review TEXT,
  created_at TEXT NOT NULL,
  assigned_at TEXT,
  started_at TEXT,
  picked_up_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS orders_slot_date ON orders(slot_date);
CREATE INDEX IF NOT EXISTS orders_courier ON orders(courier_id);
CREATE INDEX IF NOT EXISTS orders_client ON orders(client_id);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  status TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_photos (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('pickup', 'disposal', 'problem')),
  file TEXT NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  courier_id INTEGER NOT NULL REFERENCES users(id),
  started_at TEXT NOT NULL,
  ended_at TEXT
);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

/** Выполняет fn в транзакции. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Демо-данные: по одному пользователю каждой роли, районы, тарифы, пара заказов. */
export function seedIfEmpty(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return false;

  tx(db, () => {
    const zone = db.prepare('INSERT INTO zones (name) VALUES (?)');
    const zones = ['Центральный', 'Северный', 'Южный'].map((n) => Number(zone.run(n).lastInsertRowid));

    const tariff = db.prepare(
      `INSERT INTO tariffs (name, description, price, included_bags, extra_bag_price, courier_fee, extra_bag_fee)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const basic = Number(tariff.run('Разовый', 'До 2 пакетов до 7 кг, вынос в ближайший контейнер', 149, 2, 50, 80, 25).lastInsertRowid);
    tariff.run('Большой', 'До 5 пакетов или коробки', 299, 5, 40, 160, 20);
    tariff.run('Крупногабарит', 'Мебель, техника, строительный мусор (по согласованию)', 990, 1, 300, 600, 150);

    const user = db.prepare(
      'INSERT INTO users (role, name, phone, password_hash, zone_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    user.run('admin', 'Администратор', '+70000000000', hashPassword('admin'), null, now());
    const courier = Number(user.run('courier', 'Иван Курьеров', '+70000000001', hashPassword('courier'), zones[0], now()).lastInsertRowid);
    user.run('courier', 'Пётр Северный', '+70000000003', hashPassword('courier'), zones[1], now());
    const client = Number(user.run('client', 'Анна Клиентова', '+70000000002', hashPassword('client'), null, now()).lastInsertRowid);

    const address = Number(
      db
        .prepare(
          `INSERT INTO addresses (user_id, zone_id, street, house, entrance, floor, apartment, intercom, comment, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(client, zones[0], 'ул. Ленина', '10', '2', '5', '57', '57В', 'Пакеты справа от двери', now()).lastInsertRowid,
    );

    const order = db.prepare(
      `INSERT INTO orders (client_id, address_id, zone_id, tariff_id, courier_id, bags, slot_date, slot, status, price, courier_fee, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const event = db.prepare('INSERT INTO order_events (order_id, status, actor_id, note, created_at) VALUES (?, ?, ?, ?, ?)');
    const today = localDate();
    const o1 = order.run(client, address, zones[0], basic, null, 2, today, '20:00-22:00', 'new', 149, 80, now()).lastInsertRowid;
    event.run(o1, 'new', client, null, now());
    const o2 = order.run(client, address, zones[0], basic, courier, 3, today, '20:00-22:00', 'assigned', 199, 105, now()).lastInsertRowid;
    event.run(o2, 'new', client, null, now());
    event.run(o2, 'assigned', courier, null, now());
    db.prepare('UPDATE orders SET assigned_at = ? WHERE id = ?').run(now(), o2);
  });
  return true;
}
