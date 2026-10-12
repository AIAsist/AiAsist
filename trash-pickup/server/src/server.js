import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDb, seedIfEmpty } from './db.js';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;

const db = openDb(process.env.DB_FILE || path.join(serverDir, 'data', 'app.db'));
if (seedIfEmpty(db)) console.log('База создана, добавлены демо-данные.');

const app = createApp({
  db,
  uploadsDir: process.env.UPLOADS_DIR || path.join(serverDir, 'uploads'),
  webDir: path.resolve(serverDir, '..', 'web'),
});

http.createServer(app).listen(PORT, () => {
  console.log(`
Сервер запущен: http://localhost:${PORT}

  Клиент:   http://localhost:${PORT}/client/   +70000000002 / client
  Курьер:   http://localhost:${PORT}/courier/  +70000000001 / courier
  Админка:  http://localhost:${PORT}/admin/    +70000000000 / admin
`);
});
