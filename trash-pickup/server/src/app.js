import { authenticate } from './auth.js';
import { HttpError, readJson, sendJson, serveFile } from './http.js';
import { Router } from './router.js';
import { registerAdmin } from './routes/admin.js';
import { registerClient } from './routes/client.js';
import { registerCommon } from './routes/common.js';
import { registerCourier } from './routes/courier.js';

/** Обработчик HTTP-запросов: /api/* — API, /uploads/* — фотоотчёты, остальное — статика веб-приложений. */
export function createApp({ db, uploadsDir, webDir }) {
  const router = new Router();
  registerCommon(router);
  registerClient(router);
  registerCourier(router);
  registerAdmin(router);

  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const { pathname } = url;

      if (pathname.startsWith('/api/')) {
        const match = router.match(req.method, pathname);
        if (!match) throw new HttpError(404, 'Метод API не найден');
        const { route, params } = match;
        const user = authenticate(db, req);
        if (route.roles) {
          if (!user) throw new HttpError(401, 'Требуется вход');
          if (route.roles.length && !route.roles.includes(user.role)) throw new HttpError(403, 'Недостаточно прав');
        }
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
        const result = await route.handler({ db, user, params, body, query: Object.fromEntries(url.searchParams), uploadsDir, req, res });
        if (result !== undefined) sendJson(res, 200, result);
        return;
      }

      if (pathname.startsWith('/uploads/')) return serveFile(res, uploadsDir, pathname.slice('/uploads/'.length));
      return serveFile(res, webDir, pathname);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      if (res.headersSent) return res.end();
      const status = err instanceof HttpError ? err.status : 500;
      sendJson(res, status, { error: err instanceof HttpError ? err.message : 'Внутренняя ошибка сервера' });
    }
  };
}
