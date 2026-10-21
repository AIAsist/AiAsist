// Downloads OpenStreetMap data for the town from Overpass and builds public/data/<id>.json.
//
//   npm run map                        — download (or reuse the cache in data-raw/) and convert
//   npm run map -- --refresh           — ignore the cache and download again
//   npm run map -- --bbox=S,W,N,E      — use an explicit bounding box (default: "bbox" in map.config.json)
//   npm run map -- --boundary          — look the town boundary up in OSM instead of the configured bbox
//   npm run map -- --input=file.json   — convert a saved Overpass response (e.g. from overpass-turbo.eu)
//   npm run map -- --source=geofabrik  — cut the town out of the Geofabrik region extract with osmium
//                                         (needs `osmium` in PATH); --source=overpass — only Overpass;
//                                         default (auto): Geofabrik if osmium is installed, else Overpass

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { convertOsm } from '../src/osm/convert';
import { parseOsmXml } from '../src/osm/osmXml';
import {
  OVERPASS_ENDPOINTS,
  bboxAround,
  boundaryQuery,
  capBBox,
  checkOverpassResponse,
  mapQuery,
  mergeResponses,
  parseBoundary,
  splitBBox,
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
  tileKm: number;
  /** The town's bbox, found once from its OSM boundary (`--boundary`) and stored to skip the lookup. */
  bbox?: BBox;
  /** Geofabrik region extract (.osm.pbf) that contains the town. */
  geofabrik: string;
};

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || 'true'] as const;
  }),
);

const USER_AGENT = 'courier-sestroretsk-game/0.1 (+https://github.com/AIAsist/AiAsist)';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function overpass(query: string, label: string, rounds = 3): Promise<OverpassResponse> {
  const errors: string[] = [];
  // Rounds over all mirrors: a busy server is skipped quickly instead of retried in place, and when
  // every server is down at once we pause before the next round.
  for (let attempt = 1; attempt <= rounds; attempt++) {
    if (attempt > 1) {
      console.log(`[overpass] ${label}: all servers failed, retrying in ${30 * (attempt - 1)} s`);
      await sleep(30_000 * (attempt - 1));
    }
    for (const endpoint of OVERPASS_ENDPOINTS) {
      const started = Date.now();
      try {
        console.log(`[overpass] ${label}: ${endpoint} (round ${attempt})`);
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
          body: new URLSearchParams({ data: query }).toString(),
          signal: AbortSignal.timeout(3.5 * 60 * 1000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const json = checkOverpassResponse(await res.json());
        console.log(`[overpass] ${label}: ${json.elements.length} elements in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        return json;
      } catch (e) {
        const msg = `${endpoint}: ${(e as Error).message} after ${((Date.now() - started) / 1000).toFixed(0)} s`;
        console.warn(`[overpass] ${label} failed — ${msg}`);
        errors.push(msg);
        await sleep(3000);
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
  if (config.bbox && !args.has('boundary')) {
    console.log(`[map] bbox from map.config.json: ${fmt(config.bbox)}`);
    return config.bbox;
  }
  try {
    const info = parseBoundary(await overpass(boundaryQuery(config.boundaryName), 'boundary', 1));
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

/** Downloads the bbox tile by tile; each tile is cached in data-raw/ so a rerun resumes where it failed. */
async function downloadTiles(bbox: BBox): Promise<OverpassResponse> {
  const tiles = splitBBox(bbox, config.tileKm);
  console.log(`[map] downloading ${tiles.length} tiles of ≤ ${config.tileKm} km`);
  const parts: OverpassResponse[] = [];
  for (const [k, tile] of tiles.entries()) {
    const query = mapQuery(tile);
    const hash = createHash('sha1').update(query).digest('hex').slice(0, 10);
    const cacheFile = resolve(root, 'data-raw', `${config.id}-${hash}.json`);
    const label = `tile ${k + 1}/${tiles.length}`;
    if (existsSync(cacheFile) && !args.has('refresh')) {
      console.log(`[map] ${label}: cached`);
      parts.push(checkOverpassResponse(JSON.parse(readFileSync(cacheFile, 'utf8'))));
      continue;
    }
    const part = await overpass(query, label);
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(part));
    parts.push(part);
    await sleep(1000); // be polite to the free servers
  }
  const merged = mergeResponses(parts);
  console.log(`[map] ${merged.elements.length} unique elements`);
  return merged;
}

function osmiumAvailable(): boolean {
  try {
    execFileSync('osmium', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url: string, file: string): Promise<void> {
  console.log(`[geofabrik] downloading ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const tmp = `${file}.part`;
  let bytes = 0;
  let nextLog = 100e6;
  const body = Readable.fromWeb(res.body as never);
  body.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes >= nextLog) {
      console.log(`[geofabrik] … ${(bytes / 1e6).toFixed(0)} MB`);
      nextLog += 100e6;
    }
  });
  await pipeline(body, createWriteStream(tmp));
  renameSync(tmp, file);
  console.log(`[geofabrik] ${(bytes / 1e6).toFixed(0)} MB downloaded`);
}

/**
 * Cuts the bbox out of the Geofabrik region extract with osmium (complete ways and multipolygons)
 * and reads it as Overpass-like elements. Only the small town extract is kept in data-raw/.
 */
async function fromGeofabrik(bbox: BBox): Promise<OverpassResponse> {
  const dir = resolve(root, 'data-raw');
  mkdirSync(dir, { recursive: true });
  const key = createHash('sha1').update(`${config.geofabrik}|${fmt(bbox)}`).digest('hex').slice(0, 10);
  const extract = resolve(dir, `${config.id}-${key}.osm.pbf`);
  if (!existsSync(extract) || args.has('refresh')) {
    const region = resolve(dir, basename(new URL(config.geofabrik).pathname));
    if (!existsSync(region) || args.has('refresh')) await downloadFile(config.geofabrik, region);
    const b = [bbox.west, bbox.south, bbox.east, bbox.north].join(',');
    console.log(`[geofabrik] osmium extract -b ${b}`);
    execFileSync('osmium', ['extract', '-b', b, '--strategy=smart', '--overwrite', '-o', extract, region], { stdio: 'inherit' });
    rmSync(region); // hundreds of MB: not worth keeping once the town is cut out
  } else {
    console.log(`[geofabrik] using cached ${basename(extract)}`);
  }
  const xmlFile = extract.replace(/\.pbf$/, '');
  execFileSync('osmium', ['cat', '--overwrite', '-o', xmlFile, extract], { stdio: 'inherit' });
  const elements = parseOsmXml(readFileSync(xmlFile, 'utf8'));
  rmSync(xmlFile);
  console.log(`[geofabrik] ${elements.length} elements`);
  return { elements };
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
    const source = args.get('source') ?? 'auto';
    const useGeofabrik = source === 'geofabrik' || (source === 'auto' && osmiumAvailable());
    if (useGeofabrik) {
      try {
        data = await fromGeofabrik(bbox);
      } catch (e) {
        if (source === 'geofabrik') throw e;
        console.warn(`[map] Geofabrik failed (${(e as Error).message}), falling back to Overpass`);
        data = await downloadTiles(bbox);
      }
    } else {
      if (source === 'auto') console.log('[map] osmium not installed: downloading from Overpass');
      data = await downloadTiles(bbox);
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
