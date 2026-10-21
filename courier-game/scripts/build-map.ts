// Downloads OpenStreetMap data for the town from Overpass and builds public/data/<id>.json.
//
//   npm run map                        — download (or reuse the cache in data-raw/) and convert
//   npm run map -- --refresh           — ignore the cache and download again
//   npm run map -- --bbox=S,W,N,E      — use an explicit bounding box
//   npm run map -- --input=file.json   — convert a saved Overpass response (e.g. from overpass-turbo.eu)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertOsm } from '../src/osm/convert';
import {
  OVERPASS_ENDPOINTS,
  bboxAround,
  boundaryQuery,
  capBBox,
  checkOverpassResponse,
  mapQuery,
  parseBoundary,
} from '../src/osm/overpass';
import type { BBox, OverpassResponse } from '../src/osm/types';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(resolve(root, 'map.config.json'), 'utf8')) as {
  id: string;
  name: string;
  boundaryName: string;
  center: { lat: number; lon: number };
  maxSpanKm: number;
  fallbackHalfSizeKm: number;
};

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || 'true'] as const;
  }),
);

const USER_AGENT = 'courier-sestroretsk-game/0.1 (+https://github.com/AIAsist/AiAsist)';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function overpass(query: string, label: string): Promise<OverpassResponse> {
  const errors: string[] = [];
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      try {
        console.log(`[overpass] ${label}: ${endpoint} (attempt ${attempt})`);
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
          body: new URLSearchParams({ data: query }).toString(),
          signal: AbortSignal.timeout(11 * 60 * 1000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const json = checkOverpassResponse(await res.json());
        console.log(`[overpass] ${label}: ${json.elements.length} elements in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        return json;
      } catch (e) {
        const msg = `${endpoint}: ${(e as Error).message}`;
        console.warn(`[overpass] ${label} failed — ${msg}`);
        errors.push(msg);
        await sleep(attempt * 5000);
      }
    }
  }
  throw new Error(`All Overpass endpoints failed for ${label}:\n  ${errors.join('\n  ')}`);
}

async function resolveBBox(): Promise<BBox> {
  const explicit = args.get('bbox');
  if (explicit) {
    const [south, west, north, east] = explicit.split(',').map(Number);
    if ([south, west, north, east].some((v) => !Number.isFinite(v))) throw new Error(`Bad --bbox: ${explicit}`);
    return { south, west, north, east };
  }
  try {
    const info = parseBoundary(await overpass(boundaryQuery(config.boundaryName), 'boundary'));
    const center = info.center ?? config.center;
    if (info.bbox) {
      const capped = capBBox(info.bbox, config.maxSpanKm, center);
      console.log(`[map] town boundary found, bbox ${fmt(info.bbox)} → capped to ${fmt(capped)}`);
      return capped;
    }
    console.warn('[map] town boundary not found, using a square around the centre');
    return bboxAround(center.lat, center.lon, config.fallbackHalfSizeKm);
  } catch (e) {
    console.warn(`[map] boundary lookup failed (${(e as Error).message}), using a square around the centre`);
    return bboxAround(config.center.lat, config.center.lon, config.fallbackHalfSizeKm);
  }
}

const fmt = (b: BBox) => [b.south, b.west, b.north, b.east].map((v) => v.toFixed(4)).join(',');

async function main() {
  let data: OverpassResponse;
  let bbox: BBox;
  const input = args.get('input');
  if (input) {
    data = checkOverpassResponse(JSON.parse(readFileSync(resolve(input), 'utf8')));
    const explicit = args.get('bbox');
    bbox = explicit ? await resolveBBox() : bboxOfElements(data);
    console.log(`[map] converting ${input} (${data.elements.length} elements), bbox ${fmt(bbox)}`);
  } else {
    bbox = await resolveBBox();
    const query = mapQuery(bbox);
    const hash = createHash('sha1').update(query).digest('hex').slice(0, 10);
    const cacheFile = resolve(root, 'data-raw', `${config.id}-${hash}.json`);
    if (existsSync(cacheFile) && !args.has('refresh')) {
      console.log(`[map] using cached ${cacheFile}`);
      data = checkOverpassResponse(JSON.parse(readFileSync(cacheFile, 'utf8')));
    } else {
      data = await overpass(query, 'map data');
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(data));
    }
  }

  const { map, stats, warnings } = convertOsm(data.elements, { name: config.name, bbox });
  const outFile = resolve(root, args.get('out') ?? `public/data/${config.id}.json`);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(map));

  const w = (map.bounds.maxX - map.bounds.minX) / 1000;
  const h = (map.bounds.maxY - map.bounds.minY) / 1000;
  console.log(`[map] ${config.name}: ${w.toFixed(1)} × ${h.toFixed(1)} km, spawn (${map.spawn.x}, ${map.spawn.y})`);
  console.table(stats);
  for (const warning of warnings.slice(0, 30)) console.warn(`[map] warning: ${warning}`);
  if (warnings.length > 30) console.warn(`[map] … and ${warnings.length - 30} more warnings`);
  console.log(`[map] wrote ${outFile} (${(statSync(outFile).size / 1e6).toFixed(2)} MB)`);

  // A map without streets or buildings means the download was incomplete: fail loudly.
  if (stats.roads < 100 || stats.buildings < 100 || stats.pois < 3) {
    throw new Error('The map looks incomplete (too few roads/buildings/pickup points) — not shipping it.');
  }
  if (stats.addresses < 20) console.warn('[map] few addresses in OSM: the game will deliver to buildings by street name');
}

function bboxOfElements(data: OverpassResponse): BBox {
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  const add = (lat: number, lon: number) => {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lon);
    east = Math.max(east, lon);
  };
  for (const el of data.elements) {
    if (el.type === 'node') add(el.lat, el.lon);
    else if (el.type === 'way' && el.tags?.highway) for (const g of el.geometry ?? []) if (g) add(g.lat, g.lon);
  }
  if (!Number.isFinite(south)) throw new Error('Cannot infer bbox from input: pass --bbox=S,W,N,E');
  return { south, west, north, east };
}

main().catch((e) => {
  console.error(`[map] ${(e as Error).message}`);
  process.exit(1);
});
