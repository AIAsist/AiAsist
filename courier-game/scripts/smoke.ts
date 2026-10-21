// End-to-end smoke test of the built site (run after `vite build`): opens the game in headless
// Chromium, takes an order and lets an autopilot follow the navigation route on the real map until
// the order is delivered. Fails on page errors, missing orders or a courier that gets stuck.
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

interface SmokeResult {
  map: string;
  pickups: number;
  drops: number;
  offers: number;
  routeAtStart: number;
  delivered: boolean;
  pickedUp: boolean;
  simSeconds: number;
  onRoadShare: number;
  remaining: number | null;
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
    await page.goto(`${base}?map=${mapId}`);
    await page.waitForFunction(() => (window as any).courierGame, null, { timeout: 60_000 });
    await page.evaluate(() => (window as any).courierGame.hud.closeModal());
    await page.waitForFunction(() => (window as any).courierGame.game.board.offers.length > 0, null, { timeout: 20_000 });
    mkdirSync(outDir, { recursive: true });
    await page.screenshot({ path: resolve(outDir, `${mapId}-start.png`) });

    const result: SmokeResult = await page.evaluate((map) => {
      const { game } = (window as any).courierGame;
      const offers = game.board.offers.length;
      game.accept(game.board.offers[0].id);
      const routeAtStart = game.route()?.length ?? 0;
      let pickedUp = false;
      let onRoad = 0;
      let steps = 0;
      const c = game.courier;
      // Autopilot: steer towards a point ~6 m ahead along the navigation route.
      for (; steps < 60 * 600 && game.active; steps++) {
        const r = game.route();
        if (!r) break;
        const p = r.points as number[];
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
        const dx = tx - c.x;
        const dy = ty - c.y;
        const m = Math.hypot(dx, dy) || 1;
        game.update(1 / 60, { x: dx / m, y: dy / m });
        if (c.onRoad) onRoad++;
        if (game.active?.stage === 'toDrop') pickedUp = true;
      }
      return {
        map,
        pickups: game.board.pickups.length,
        drops: game.board.drops.length,
        offers,
        routeAtStart: Math.round(routeAtStart),
        delivered: !game.active,
        pickedUp: pickedUp || !game.active,
        simSeconds: Math.round(steps / 60),
        onRoadShare: Math.round((onRoad / Math.max(1, steps)) * 100) / 100,
        remaining: game.active ? Math.round(game.route()?.length ?? -1) : null,
        money: game.profile.money,
      };
    }, mapId);

    await page.waitForTimeout(1500);
    await page.screenshot({ path: resolve(outDir, `${mapId}-delivered.png`) });
    await page.keyboard.press('KeyV');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: resolve(outDir, `${mapId}-3d.png`) });

    console.log(JSON.stringify(result, null, 2));
    const problems: string[] = [];
    if (errors.length) problems.push(`page errors: ${errors.join(' | ')}`);
    if (result.pickups < 3) problems.push('too few pickup points');
    if (!result.offers) problems.push('no orders offered');
    if (!result.delivered) problems.push(`autopilot did not deliver (${result.remaining} m left after ${result.simSeconds} s)`);
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
