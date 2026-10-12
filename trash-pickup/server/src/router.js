/**
 * Минимальный роутер: route('GET', '/api/orders/:id', ['admin'], handler).
 * roles = null — публичный маршрут, [] — любой авторизованный пользователь.
 */
export class Router {
  constructor() {
    this.routes = [];
  }

  route(method, pattern, roles, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern.replace(/\/:([a-zA-Z_]+)/g, (_, key) => {
          keys.push(key);
          return '/([^/]+)';
        }) +
        '$',
    );
    this.routes.push({ method, regex, keys, roles, handler });
  }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return null;
  }
}
