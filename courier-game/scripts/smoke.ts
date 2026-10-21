// End-to-end smoke test of the built site (run after `vite build`): opens the game in headless
// Chromium and plays several orders with an autopilot that follows the navigation route on the real
// map. Fails on page errors, missing orders or a courier that gets stuck (and logs where and why).
//
//   npm run smoke                     — map "sestroretsk"
//   npm run smoke -- --map=test-town  — another map from public/data
//   CHROMIUM_PATH=/path/to/chrome npm run smoke

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { preview } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mapId = process.argv.find((a) => a.startsWith('--map='))?.slice(6) ?? 'sestroretsk';
const outDir = resolve(root, 'smoke');

const ORDERS = 5;

interface OrderRun {
  pickup: string;
  drop: string;
  route: number;
  delivered: boolean;
  seconds: number;
  onRoadShare: number;
  /** When stuck: where and why, for a human to look up on openstreetmap.org. */
  stuck?: Record<string, unknown>;
}

interface SmokeResult {
  map: string;
  pickups: number;
  drops: number;
  orders: OrderRun[];
  money: number;
}

async function main() {
  const server = await preview({ root, logLevel: 'warn', preview: { port: 4174, strictPort: false } });
  const base = server.resolvedUrls?.local[0];
  if (!base) throw new Error('vite preview did not start');
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    // tsx (esbuild keepNames) wraps named functions in the evaluated code with a `__name` helper.
    await page.addInitScript('window.__name = (f) => f');
    await page.goto(`${base}?map=${mapId}`);
    await page.waitForFunction(() => (window as any).courierGame, null, { timeout: 60_000 });
    await page.evaluate(() => (window as any).courierGame.hud.closeModal());
    await page.waitForFunction(() => (window as any).courierGame.game.board.offers.length > 0, null, { timeout: 20_000 });
    mkdirSync(outDir, { recursive: true });
    await page.screenshot({ path: resolve(outDir, `${mapId}-start.png`) });

    const result: SmokeResult = await page.evaluate(
      ({ map, orders }) => {
        const { game } = (window as any).courierGame;
        const world = game.world;
        const c = game.courier;
        const o = world.map.origin;
        const R = 6378137;
        const latLon = (x: number, y: number) =>
          `${(o.lat + (y / R) * (180 / Math.PI)).toFixed(6)},${(o.lon + (x / (R * Math.cos((o.lat * Math.PI) / 180))) * (180 / Math.PI)).toFixed(6)}`;
        /** Autopilot: steer towards a point ~6 m ahead along the navigation route. */
        const steer = () => {
          const p = game.route()!.points as number[];
          let tx = p[p.length - 2];
          let ty = p[p.length - 1];
          let along = 0;
          for (let i = 2; i < p.length; i += 2) {
            along += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
            if (along > 6) {
              tx = p[i];
              ty = p[i + 1];
              break;
            }
          }
          return { tx, ty };
        };
        const runs: OrderRun[] = [];
        for (let k = 0; k < orders; k++) {
          for (let wait = 0; wait < 600 && !game.board.offers.length; wait++) game.update(1 / 60, { x: 0, y: 0 });
          const offer = game.board.offers[0];
          if (!offer) break;
          game.accept(offer.id);
          const run: OrderRun = { pickup: offer.pickup.title, drop: offer.drop.title, route: Math.round(game.route()?.length ?? 0), delivered: false, seconds: 0, onRoadShare: 0 };
          const trail: string[] = [];
          let onRoad = 0;
          let steps = 0;
          for (; steps < 60 * 600 && game.active; steps++) {
            const { tx, ty } = steer();
            const m = Math.hypot(tx - c.x, ty - c.y) || 1;
            game.update(1 / 60, { x: (tx - c.x) / m, y: (ty - c.y) / m });
            if (c.onRoad) onRoad++;
            if (steps % (60 * 60) === 0) trail.push(latLon(c.x, c.y));
          }
          run.seconds = Math.round(steps / 60);
          run.onRoadShare = Math.round((onRoad / Math.max(1, steps)) * 100) / 100;
          run.delivered = !game.active;
          if (game.active) {
            const { tx, ty } = steer();
            const d = Math.hypot(tx - c.x, ty - c.y);
            let blockedBy = 'nothing';
            for (let t = 0.5; t <= d; t += 0.5) {
              const px = c.x + ((tx - c.x) * t) / d;
              const py = c.y + ((ty - c.y) * t) / d;
              if (world.isBlocked(px, py, 0.9)) {
                blockedBy = !world.insideBounds(px, py, 0.9) ? 'map edge' : world.inWater(px, py) ? 'water' : 'building';
                blockedBy += ` at ${latLon(px, py)} (${t.toFixed(1)} m ahead)`;
                break;
              }
            }
            const target = game.target();
            run.stuck = {
              stage: game.active.stage,
              at: latLon(c.x, c.y),
              street: world.streetNameAt(c.x, c.y, 50),
              steeringTo: latLon(tx, ty),
              blockedBy,
              target: `${target.title} @ ${latLon(target.x, target.y)}`,
              remaining: Math.round(game.route()?.length ?? -1),
              trail,
            };
            game.cancel();
          }
          runs.push(run);
        }
        return { map, pickups: game.board.pickups.length, drops: game.board.drops.length, orders: runs, money: game.profile.money };
      },
      { map: mapId, orders: ORDERS },
    );

    await page.waitForTimeout(1500);
    await page.screenshot({ path: resolve(outDir, `${mapId}-after-orders.png`) });
    await page.keyboard.press('KeyV');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: resolve(outDir, `${mapId}-3d.png`) });

    console.log(JSON.stringify(result, null, 2));
    const problems: string[] = [];
    if (errors.length) problems.push(`page errors: ${errors.join(' | ')}`);
    if (result.pickups < 3) problems.push('too few pickup points');
    if (result.orders.length < ORDERS) problems.push(`only ${result.orders.length} of ${ORDERS} orders were offered`);
    const stuck = result.orders.filter((r) => !r.delivered).length;
    if (stuck) problems.push(`autopilot got stuck in ${stuck} of ${result.orders.length} orders (see "stuck" above)`);
    if (problems.length) throw new Error(problems.join('\n'));
    console.log(`[smoke] OK — screenshots in ${outDir}`);
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.httpServer.close(() => r()));
  }
}

main().catch((e) => {
  console.error(`[smoke] FAILED: ${(e as Error).message}`);
  process.exit(1);
});
