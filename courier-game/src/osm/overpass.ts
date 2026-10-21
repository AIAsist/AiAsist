// Overpass API queries for the game map.

import type { BBox, OverpassResponse } from './types';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Finds the town's administrative boundary (for its bounding box) and its place node. */
export function boundaryQuery(name: string): string {
  return `[out:json][timeout:90];
rel["boundary"="administrative"]["name"="${esc(name)}"];
out tags bb;
node["place"~"^(town|city)$"]["name"="${esc(name)}"];
out;`;
}

/** Everything the game draws or uses inside the bbox. */
export function mapQuery(b: BBox): string {
  const bbox = [b.south, b.west, b.north, b.east].map((v) => v.toFixed(6)).join(',');
  // Modest timeout/maxsize: Overpass queues requests that ask for big limits when it is busy.
  return `[out:json][timeout:240][maxsize:268435456][bbox:${bbox}];
(
  way["highway"];
  way["building"];
  relation["building"]["type"="multipolygon"];
  way["natural"~"^(water|wood|wetland|beach|sand|scrub|grassland|heath|coastline)$"];
  relation["natural"~"^(water|wood|wetland|beach|sand|scrub|grassland|heath)$"]["type"="multipolygon"];
  way["waterway"~"^(river|canal|stream|ditch|drain|riverbank|dock)$"];
  relation["waterway"="riverbank"]["type"="multipolygon"];
  way["landuse"];
  relation["landuse"]["type"="multipolygon"];
  way["leisure"~"^(park|garden|pitch|stadium|track|playground|beach_resort)$"];
  relation["leisure"~"^(park|garden|beach_resort)$"]["type"="multipolygon"];
  way["amenity"~"^(restaurant|cafe|fast_food|ice_cream|pharmacy|grave_yard)$"];
  way["railway"~"^(rail|light_rail|narrow_gauge|tram)$"];
  node["amenity"~"^(restaurant|cafe|fast_food|ice_cream|pharmacy)$"];
  node["shop"];
  way["shop"];
  node["addr:housenumber"];
  node["railway"~"^(station|halt)$"];
  node["place"];
);
out body geom qt;`;
}

/** Overpass can answer 200 with a partial result and a runtime error in `remark`. */
export function checkOverpassResponse(json: unknown): OverpassResponse {
  const r = json as { elements?: unknown; remark?: string };
  if (!r || !Array.isArray(r.elements)) throw new Error('Overpass: response has no "elements" array');
  if (r.remark && /error|timed out|out of memory/i.test(r.remark)) throw new Error(`Overpass: ${r.remark}`);
  return r as OverpassResponse;
}

export interface BoundaryInfo {
  bbox: BBox | null;
  center: { lat: number; lon: number } | null;
}

export function parseBoundary(resp: OverpassResponse): BoundaryInfo {
  let bbox: BBox | null = null;
  let bestLevel = Infinity;
  let center: BoundaryInfo['center'] = null;
  for (const el of resp.elements as unknown as Record<string, any>[]) {
    if (el.type === 'relation' && el.bounds) {
      // Prefer the municipal level (8) — it is the town itself, not the whole district.
      const level = Math.abs(parseInt(el.tags?.admin_level ?? '99', 10) - 8);
      if (level < bestLevel) {
        bestLevel = level;
        bbox = { south: el.bounds.minlat, west: el.bounds.minlon, north: el.bounds.maxlat, east: el.bounds.maxlon };
      }
    } else if (el.type === 'node' && !center) {
      center = { lat: el.lat, lon: el.lon };
    }
  }
  return { bbox, center };
}

const M_PER_DEG_LAT = 111_320;

/** Square bbox of `halfKm` around a point. */
export function bboxAround(lat: number, lon: number, halfKm: number): BBox {
  const dLat = (halfKm * 1000) / M_PER_DEG_LAT;
  const dLon = (halfKm * 1000) / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon };
}

/** Shrinks a bbox to at most `maxKm` per side, keeping `focus` inside (the town centre). */
export function capBBox(b: BBox, maxKm: number, focus: { lat: number; lon: number }): BBox {
  const latSpan = (maxKm * 1000) / M_PER_DEG_LAT;
  const lonSpan = (maxKm * 1000) / (M_PER_DEG_LAT * Math.cos((focus.lat * Math.PI) / 180));
  const fit = (lo: number, hi: number, span: number, f: number): [number, number] => {
    if (hi - lo <= span) return [lo, hi];
    let a = Math.max(lo, f - span / 2);
    a = Math.min(a, hi - span);
    return [a, a + span];
  };
  const [south, north] = fit(b.south, b.north, latSpan, focus.lat);
  const [west, east] = fit(b.west, b.east, lonSpan, focus.lon);
  return { south, west, north, east };
}
