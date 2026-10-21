import './ui/styles.css';
import type { GameMapData } from './data/mapFormat';
import { Renderer } from './render/renderer';
import { Hud } from './ui/hud';
import { Input } from './ui/input';
import { Minimap } from './ui/minimap';
import { Sound } from './ui/sound';
import { Game } from './world/game';

const DEFAULT_MAP = 'sestroretsk';
const STEP = 1 / 60;

const $ = (id: string) => document.getElementById(id)!;

function setStatus(text: string, progress?: number): void {
  $('splash-status').textContent = text;
  if (progress !== undefined) $('splash-bar').style.width = `${Math.round(progress * 100)}%`;
}

async function loadMap(id: string): Promise<GameMapData> {
  const res = await fetch(`data/${id}.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return (await res.json()) as GameMapData;
  // Stream with a progress bar (the town map is a few megabytes).
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    setStatus(`Загружаем карту… ${(received / 1e6).toFixed(1)} МБ`, 0.05 + 0.7 * Math.min(1, received / total));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as GameMapData;
}

function showError(mapId: string, err: unknown): void {
  $('splash-status').innerHTML = `
    Не удалось загрузить карту <b>${mapId}</b> (${String((err as Error)?.message ?? err)}).<br><br>
    Карту нужно один раз собрать из OpenStreetMap:
    <pre>cd courier-game\nnpm install\nnpm run map</pre>
    Без интернета можно поиграть на тестовой карте: <code>npm run map:test</code> и открыть <code>?map=test-town</code>.`;
  $('splash-bar').style.background = '#dc2626';
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function start(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const mapId = (params.get('map') ?? DEFAULT_MAP).replace(/[^a-z0-9-]/gi, '') || DEFAULT_MAP;
  let map: GameMapData;
  try {
    setStatus('Загружаем карту…', 0.05);
    map = await loadMap(mapId);
  } catch (e) {
    showError(mapId, e);
    return;
  }
  $('splash-town').textContent = map.name;
  document.title = `Курьер: ${map.name}`;

  setStatus('Строим город…', 0.8);
  await nextFrame();
  const game = new Game(map, mapId);
  const renderer = new Renderer($('game'), map, game);
  setStatus('Готово!', 1);
  await nextFrame();

  const sound = new Sound();
  const minimap = new Minimap(document.createElement('canvas'), map, window.innerWidth < 720 ? 120 : 190);
  const hud = new Hud($('hud'), game, renderer, sound, minimap);
  const input = new Input($('game'), $('stick'));
  input.onZoom = (f) => renderer.zoomBy(f);
  input.onKey = (code) => {
    sound.unlock();
    hud.key(code);
  };
  $('game').addEventListener('pointerdown', () => sound.unlock());

  $('splash').classList.add('hidden');
  setTimeout(() => $('splash').remove(), 500);
  if (game.profile.deliveries === 0) hud.openHelp();

  // Debug handle (handy in the browser console).
  (window as unknown as Record<string, unknown>).courierGame = { game, renderer, hud };

  let last = performance.now();
  let acc = 0;
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!hud.paused) {
      acc += dt;
      let steps = 0;
      while (acc >= STEP && steps < 6) {
        game.update(STEP, input.move);
        acc -= STEP;
        steps++;
      }
      if (steps === 6) acc = 0;
    }
    renderer.update(dt);
    hud.frame(dt);
    renderer.render();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

void start();
