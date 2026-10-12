import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { openDb, seedIfEmpty } from '../src/db.js';
import { addDays, localDate } from '../src/util.js';

const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server;
let base;
let uploadsDir;

before(async () => {
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trash-uploads-'));
  const db = openDb(':memory:');
  seedIfEmpty(db);
  server = http.createServer(createApp({ db, uploadsDir, webDir: path.resolve(import.meta.dirname, '../../web') }));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

async function call(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}

const login = async (phone, password, role) => (await call('POST', '/api/auth/login', { body: { phone, password, role } })).data.token;

test('полный цикл заказа: клиент → курьер с фотоотчётом → оценка → отчёт админа', async () => {
  const reg = await call('POST', '/api/auth/register', { body: { phone: '8 (900) 123-45-67', name: 'Тест', password: 'secret' } });
  assert.equal(reg.status, 200);
  assert.equal(reg.data.user.phone, '+79001234567');
  const client = reg.data.token;

  const meta = (await call('GET', '/api/meta')).data;
  const zone = meta.zones.find((z) => z.name === 'Центральный');
  const tariff = meta.tariffs.find((t) => t.name === 'Разовый');

  const address = await call('POST', '/api/client/addresses', { token: client, body: { zone_id: zone.id, street: 'Тестовая', house: '1', apartment: '5' } });
  assert.equal(address.status, 200);

  // 4 пакета при 2 включённых: 149 + 2 × 50
  const created = await call('POST', '/api/client/orders', {
    token: client,
    body: { address_id: address.data.id, tariff_id: tariff.id, bags: 4, slot_date: addDays(localDate(), 1), slot: '18:00-20:00' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.status, 'new');
  assert.equal(created.data.price, 249);
  assert.equal(created.data.courier_fee, 130);
  const id = created.data.id;

  const courier = await login('+70000000001', 'courier', 'courier');

  // Без смены брать заказы нельзя
  assert.equal((await call('POST', `/api/courier/orders/${id}/take`, { token: courier })).status, 409);
  await call('POST', '/api/courier/shift/start', { token: courier });

  const available = (await call('GET', '/api/courier/orders/available', { token: courier })).data;
  assert.ok(available.some((o) => o.id === id));

  // Курьер из другого района заказ не видит и взять не может
  const north = await login('+70000000003', 'courier', 'courier');
  await call('POST', '/api/courier/shift/start', { token: north });
  assert.ok(!(await call('GET', '/api/courier/orders/available', { token: north })).data.some((o) => o.id === id));
  assert.equal((await call('POST', `/api/courier/orders/${id}/take`, { token: north })).status, 403);

  assert.equal((await call('POST', `/api/courier/orders/${id}/take`, { token: courier })).data.status, 'assigned');
  assert.equal((await call('POST', `/api/courier/orders/${id}/status`, { token: courier, body: { status: 'on_way' } })).data.status, 'on_way');

  // Без фото у двери нельзя отметить «Забран»
  assert.equal((await call('POST', `/api/courier/orders/${id}/status`, { token: courier, body: { status: 'picked_up' } })).status, 409);
  const photo = await call('POST', `/api/courier/orders/${id}/photos`, { token: courier, body: { kind: 'pickup', data: PHOTO } });
  assert.equal(photo.status, 200);
  assert.equal((await fetch(base + photo.data.url)).status, 200);
  assert.equal((await call('POST', `/api/courier/orders/${id}/status`, { token: courier, body: { status: 'picked_up' } })).data.status, 'picked_up');

  // Клиент не может отменить заказ, когда мусор уже забран
  assert.equal((await call('POST', `/api/client/orders/${id}/cancel`, { token: client })).status, 409);

  await call('POST', `/api/courier/orders/${id}/photos`, { token: courier, body: { kind: 'disposal', data: PHOTO } });
  assert.equal((await call('POST', `/api/courier/orders/${id}/status`, { token: courier, body: { status: 'done' } })).data.status, 'done');

  const rated = await call('POST', `/api/client/orders/${id}/rate`, { token: client, body: { rating: 5, review: 'Супер' } });
  assert.equal(rated.data.rating, 5);

  const detail = (await call('GET', `/api/orders/${id}`, { token: client })).data;
  assert.deepEqual(
    detail.events.map((e) => e.status),
    ['new', 'assigned', 'on_way', 'picked_up', 'done'],
  );
  assert.equal(detail.photos.length, 2);

  const admin = await login('+70000000000', 'admin', 'admin');
  const report = (await call('GET', `/api/admin/reports?from=${localDate()}&to=${addDays(localDate(), 1)}`, { token: admin })).data;
  assert.equal(report.summary.done, 1);
  assert.equal(report.summary.revenue, 249);
  assert.equal(report.summary.courier_payouts, 130);
  assert.equal(report.summary.margin, 119);

  const csv = await call('GET', `/api/admin/reports/orders.csv?from=${localDate()}&to=${addDays(localDate(), 1)}`, { token: admin });
  assert.equal(csv.status, 200);
  assert.match(csv.data, new RegExp(`^${id};.*Выполнен`, 'm'));
});

test('права доступа по ролям', async () => {
  const client = await login('+70000000002', 'client', 'client');
  assert.equal((await call('GET', '/api/admin/dashboard')).status, 401);
  assert.equal((await call('GET', '/api/admin/dashboard', { token: client })).status, 403);
  assert.equal((await call('GET', '/api/courier/orders/mine', { token: client })).status, 403);
  // Курьер не может войти в клиентское приложение
  assert.equal((await call('POST', '/api/auth/login', { body: { phone: '+70000000001', password: 'courier', role: 'client' } })).status, 403);
});

test('админ назначает и переназначает курьера, курьер сообщает о проблеме', async () => {
  const admin = await login('+70000000000', 'admin', 'admin');
  const couriers = (await call('GET', '/api/admin/couriers', { token: admin })).data;
  const [ivan, petr] = couriers;
  const order = (await call('GET', '/api/admin/orders?status=new', { token: admin })).data[0];

  assert.equal((await call('POST', `/api/admin/orders/${order.id}/assign`, { token: admin, body: { courier_id: ivan.id } })).data.courier_id, ivan.id);
  assert.equal((await call('POST', `/api/admin/orders/${order.id}/assign`, { token: admin, body: { courier_id: petr.id } })).data.courier_id, petr.id);

  const petrToken = await login(petr.phone, 'courier', 'courier');
  await call('POST', `/api/courier/orders/${order.id}/status`, { token: petrToken, body: { status: 'on_way' } });
  assert.equal((await call('POST', `/api/courier/orders/${order.id}/status`, { token: petrToken, body: { status: 'problem' } })).status, 400);
  const problem = await call('POST', `/api/courier/orders/${order.id}/status`, { token: petrToken, body: { status: 'problem', note: 'Пакета нет у двери' } });
  assert.equal(problem.data.status, 'problem');

  const dash = (await call('GET', '/api/admin/dashboard', { token: admin })).data;
  assert.ok(dash.problems.some((o) => o.id === order.id));

  // Недопустимый переход
  assert.equal((await call('POST', `/api/admin/orders/${order.id}/status`, { token: admin, body: { status: 'picked_up' } })).status, 409);
  assert.equal((await call('POST', `/api/admin/orders/${order.id}/status`, { token: admin, body: { status: 'cancelled', note: 'Клиент не выставил' } })).data.status, 'cancelled');
});

test('статика и защита от выхода за пределы каталога', async () => {
  assert.equal((await fetch(base + '/admin/')).status, 200);
  assert.equal((await fetch(base + '/uploads/..%2f..%2fpackage.json')).status, 404);
});
