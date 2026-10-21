// Converts Overpass API output into the compact GameMapData format used by the game.

import {
  AREA_KINDS,
  POI_KINDS,
  ROAD_CLASSES,
  type AreaKind,
  type FlatCoords,
  type GameMapData,
  type MapAddress,
  type MapArea,
  type MapBuilding,
  type MapPoi,
  type MapRoad,
  type MapWater,
  type MapWaterway,
  type PoiKind,
  type PolygonRings,
  type RoadClass,
} from '../data/mapFormat';
import { POI_LABELS } from '../data/labels';
import { polygonArea, ringSignedArea, roundCoords, simplifyLine, simplifyRing } from '../world/geometry';
import { buildSea, type Rect } from './coastline';
import { formatAddress, shortStreetName } from './names';
import { makeProjection } from './projection';
import { assembleRings, buildPolygons } from './rings';
import type { BBox, LatLon, OsmElement, OsmRelation, OsmWay, Tags } from './types';

export interface ConvertOptions {
  name: string;
  bbox: BBox;
  /** Spawn near a railway station or place whose name contains this text (defaults to `name`). */
  spawnName?: string;
}

export interface ConvertResult {
  map: GameMapData;
  stats: Record<string, number>;
  warnings: string[];
}

const ROAD_CLASS_BY_HIGHWAY: Record<string, RoadClass> = {
  motorway: 'major',
  motorway_link: 'major',
  trunk: 'major',
  trunk_link: 'major',
  primary: 'major',
  primary_link: 'major',
  secondary: 'secondary',
  secondary_link: 'secondary',
  tertiary: 'secondary',
  tertiary_link: 'secondary',
  residential: 'street',
  unclassified: 'street',
  living_street: 'street',
  road: 'street',
  service: 'service',
  track: 'service',
  footway: 'path',
  path: 'path',
  cycleway: 'path',
  pedestrian: 'path',
  steps: 'path',
  bridleway: 'path',
};

const WATERWAY_WIDTH: Record<string, number> = { river: 10, canal: 6, stream: 2.5, ditch: 1.5, drain: 1.5 };
const RAIL_TYPES = new Set(['rail', 'light_rail', 'narrow_gauge', 'tram']);

export function roadClassOf(tags: Tags): RoadClass | null {
  const hw = tags.highway;
  if (!hw || tags.area === 'yes') return null;
  return ROAD_CLASS_BY_HIGHWAY[hw] ?? null;
}

export function areaKindOf(tags: Tags): AreaKind | null {
  const { landuse, natural, leisure, amenity } = tags;
  if (landuse === 'forest' || natural === 'wood') return 'forest';
  if (natural === 'wetland') return 'wetland';
  if (natural === 'beach' || natural === 'sand' || leisure === 'beach_resort') return 'sand';
  if (leisure === 'park' || leisure === 'garden' || landuse === 'recreation_ground' || landuse === 'village_green')
    return 'park';
  if (leisure === 'pitch' || leisure === 'stadium' || leisure === 'track' || leisure === 'playground') return 'pitch';
  if (landuse === 'cemetery' || amenity === 'grave_yard') return 'cemetery';
  if (
    landuse === 'grass' ||
    landuse === 'meadow' ||
    natural === 'grassland' ||
    natural === 'heath' ||
    natural === 'scrub'
  )
    return 'grass';
  if (
    landuse === 'industrial' ||
    landuse === 'railway' ||
    landuse === 'garages' ||
    landuse === 'construction' ||
    landuse === 'brownfield'
  )
    return 'industrial';
  if (landuse === 'farmland' || landuse === 'allotments' || landuse === 'orchard' || landuse === 'plant_nursery')
    return 'farmland';
  if (landuse === 'residential') return 'residential';
  return null;
}

export function isWaterArea(tags: Tags): boolean {
  return (
    tags.natural === 'water' ||
    tags.waterway === 'riverbank' ||
    tags.waterway === 'dock' ||
    tags.landuse === 'reservoir' ||
    tags.landuse === 'basin'
  );
}

const SKIP_SHOPS = new Set([
  'vacant',
  'car',
  'car_repair',
  'car_parts',
  'tyres',
  'funeral_directors',
  'alcohol',
  'tobacco',
  'e-cigarette',
  'weapons',
  'pawnbroker',
  'money_lender',
  'bookmaker',
  'lottery',
]);

export function poiKindOf(tags: Tags): PoiKind | null {
  const { amenity, shop, cuisine = '' } = tags;
  const pizza = /pizza/.test(cuisine);
  switch (amenity) {
    case 'restaurant':
      return pizza ? 'pizza' : 'restaurant';
    case 'fast_food':
      return pizza ? 'pizza' : 'fast_food';
    case 'cafe':
    case 'ice_cream':
      return 'cafe';
    case 'pharmacy':
      return 'pharmacy';
  }
  if (!shop || SKIP_SHOPS.has(shop)) return null;
  switch (shop) {
    case 'supermarket':
      return 'supermarket';
    case 'convenience':
    case 'greengrocer':
    case 'butcher':
    case 'deli':
    case 'seafood':
    case 'dairy':
    case 'farm':
      return 'grocery';
    case 'bakery':
    case 'pastry':
    case 'confectionery':
      return 'bakery';
    case 'florist':
      return 'flowers';
    case 'chemist':
      return 'pharmacy';
  }
  return 'shop';
}

export function buildingHeight(tags: Tags): number {
  const h = parseFloat((tags.height ?? '').replace(',', '.'));
  if (Number.isFinite(h) && h > 0) return Math.min(h, 150);
  const levels = parseFloat((tags['building:levels'] ?? '').replace(',', '.'));
  if (Number.isFinite(levels) && levels > 0) return Math.min(levels * 3 + 2, 150);
  switch (tags.building) {
    case 'house':
    case 'detached':
    case 'semidetached_house':
    case 'bungalow':
    case 'cabin':
    case 'dacha':
      return 7;
    case 'apartments':
    case 'residential':
    case 'dormitory':
      return 15;
    case 'garage':
    case 'garages':
    case 'shed':
    case 'hut':
    case 'roof':
    case 'kiosk':
    case 'carport':
    case 'greenhouse':
      return 3;
    case 'church':
    case 'cathedral':
      return 18;
    case 'industrial':
    case 'warehouse':
      return 8;
    default:
      return 8;
  }
}

function centroid(ring: FlatCoords): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const f = ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
    a += f;
    cx += (ring[j] + ring[i]) * f;
    cy += (ring[j + 1] + ring[i + 1]) * f;
  }
  if (Math.abs(a) < 1e-9) return [ring[0], ring[1]];
  return [cx / (3 * a), cy / (3 * a)];
}

export function convertOsm(elements: OsmElement[], opts: ConvertOptions): ConvertResult {
  const { bbox } = opts;
  const warnings: string[] = [];
  const lat0 = (bbox.south + bbox.north) / 2;
  const lon0 = (bbox.west + bbox.east) / 2;
  const proj = makeProjection(lat0, lon0);
  const [minX, minY] = proj.toXY(bbox.south, bbox.west);
  const [maxX, maxY] = proj.toXY(bbox.north, bbox.east);
  const rect: Rect = { minX, minY, maxX, maxY };
  const margin = 300;
  const inExpanded = (x: number, y: number) =>
    x >= minX - margin && x <= maxX + margin && y >= minY - margin && y <= maxY + margin;

  const toFlat = (geom: LatLon[] | undefined): FlatCoords => {
    const out: FlatCoords = [];
    for (const g of geom ?? []) {
      if (!g) continue;
      const [x, y] = proj.toXY(g.lat, g.lon);
      out.push(x, y);
    }
    return out;
  };
  const closedRing = (geom: LatLon[] | undefined): FlatCoords | null => {
    const c = toFlat(geom);
    const n = c.length;
    if (n < 8 || Math.abs(c[0] - c[n - 2]) > 1e-6 || Math.abs(c[1] - c[n - 1]) > 1e-6) return null;
    return c.slice(0, -2);
  };
  const relationPolygons = (rel: OsmRelation): PolygonRings[] => {
    const outer: FlatCoords[] = [];
    const inner: FlatCoords[] = [];
    for (const m of rel.members ?? []) {
      if (m.type !== 'way' || !m.geometry) continue;
      (m.role === 'inner' ? inner : outer).push(toFlat(m.geometry));
    }
    const o = assembleRings(outer);
    const i = assembleRings(inner);
    if (o.dropped + i.dropped > 0) warnings.push(`relation ${rel.id}: ${o.dropped + i.dropped} unclosed ring(s) dropped`);
    return buildPolygons(o.rings, i.rings);
  };
  const polygonsOf = (el: OsmWay | OsmRelation): PolygonRings[] => {
    if (el.type === 'way') {
      const r = closedRing(el.geometry);
      return r ? [[r]] : [];
    }
    if (el.tags?.type !== 'multipolygon') return [];
    return relationPolygons(el);
  };
  const simplifyPolygon = (rings: PolygonRings, tol: number): PolygonRings | null => {
    const outer = simplifyRing(rings[0], tol);
    if (!outer) return null;
    const out: PolygonRings = [roundCoords(outer)];
    for (let k = 1; k < rings.length; k++) {
      const h = simplifyRing(rings[k], tol);
      if (h) out.push(roundCoords(h));
    }
    return out;
  };

  const names: string[] = [];
  const nameIdx = new Map<string, number>();
  const internName = (s: string | undefined): number => {
    if (!s) return -1;
    const short = shortStreetName(s);
    let idx = nameIdx.get(short);
    if (idx === undefined) {
      idx = names.length;
      names.push(short);
      nameIdx.set(short, idx);
    }
    return idx;
  };

  const nodes: FlatCoords = [];
  const nodeIndex = new Map<number, number>();
  const roads: MapRoad[] = [];
  const buildings: MapBuilding[] = [];
  const areas: MapArea[] = [];
  const water: MapWater[] = [];
  const waterways: MapWaterway[] = [];
  const rails: FlatCoords[] = [];
  const pois: MapPoi[] = [];
  const addresses: MapAddress[] = [];
  const coast: FlatCoords[] = [];
  const addrSeen = new Set<string>();
  const poiSeen = new Set<string>();
  let spawn: { x: number; y: number; score: number } | null = null;
  const spawnName = (opts.spawnName ?? opts.name).toLowerCase();

  const addAddress = (x: number, y: number, tags: Tags) => {
    const street = tags['addr:street'];
    const house = tags['addr:housenumber'];
    if (!street || !house || !inExpanded(x, y)) return;
    const k = `${street}|${house}`;
    if (addrSeen.has(k)) return;
    addrSeen.add(k);
    addresses.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, street, house });
  };
  const addPoi = (x: number, y: number, tags: Tags) => {
    const kind = poiKindOf(tags);
    if (!kind || !inExpanded(x, y)) return false;
    const name = (tags.name ?? tags.brand ?? POI_LABELS[kind]).trim();
    const k = `${name}|${Math.round(x / 20)}|${Math.round(y / 20)}`;
    if (poiSeen.has(k)) return true;
    poiSeen.add(k);
    const poi: MapPoi = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, name, k: POI_KINDS.indexOf(kind) };
    if (tags['addr:street'] && tags['addr:housenumber']) poi.addr = formatAddress(tags['addr:street'], tags['addr:housenumber']);
    pois.push(poi);
    return true;
  };
  const considerSpawn = (x: number, y: number, tags: Tags) => {
    const n = (tags.name ?? '').toLowerCase();
    if (!n.includes(spawnName) || !inExpanded(x, y)) return;
    const score =
      tags.railway === 'station' ? 3 : tags.railway === 'halt' ? 2 : tags.place === 'town' || tags.place === 'city' ? 1 : 0;
    if (!spawn || score > spawn.score) spawn = { x, y, score };
  };

  for (const el of elements) {
    const tags = el.tags ?? {};
    if (el.type === 'node') {
      const [x, y] = proj.toXY(el.lat, el.lon);
      if (tags.railway === 'station' || tags.railway === 'halt' || tags.place) considerSpawn(x, y, tags);
      const isPoi = addPoi(x, y, tags);
      if (!isPoi) addAddress(x, y, tags);
      continue;
    }

    if (el.type === 'way') {
      const roadClass = roadClassOf(tags);
      if (roadClass && el.nodes && el.geometry && el.nodes.length === el.geometry.length) {
        const c = ROAD_CLASSES.indexOf(roadClass);
        const n = internName(tags.name);
        const bridge = tags.bridge && tags.bridge !== 'no';
        let run: number[] = [];
        const flush = () => {
          if (run.length >= 2) {
            const road: MapRoad = { c, n, i: run };
            if (bridge) road.b = 1;
            roads.push(road);
          }
          run = [];
        };
        el.nodes.forEach((id, k) => {
          const g = el.geometry![k];
          if (!g) return flush();
          const [x, y] = proj.toXY(g.lat, g.lon);
          if (!inExpanded(x, y)) return flush();
          let idx = nodeIndex.get(id);
          if (idx === undefined) {
            idx = nodes.length / 2;
            nodes.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
            nodeIndex.set(id, idx);
          }
          if (run[run.length - 1] !== idx) run.push(idx);
        });
        flush();
        continue;
      }
      if (tags.natural === 'coastline') {
        coast.push(toFlat(el.geometry));
        // Coastline ways may also carry other tags, but they are lines: nothing else to do.
        continue;
      }
      if (tags.waterway && WATERWAY_WIDTH[tags.waterway] && tags.tunnel !== 'culvert') {
        const p = toFlat(el.geometry);
        if (p.length >= 4) waterways.push({ w: WATERWAY_WIDTH[tags.waterway], p: roundCoords(simplifyLine(p, 0.5)) });
        continue;
      }
      if (tags.railway && RAIL_TYPES.has(tags.railway)) {
        const p = toFlat(el.geometry);
        if (p.length >= 4 && tags.tunnel !== 'yes') rails.push(roundCoords(simplifyLine(p, 0.5)));
        continue;
      }
    }

    if (el.type === 'relation' && tags.type !== 'multipolygon') continue;
    const isBuilding = !!tags.building && tags.building !== 'no';
    const water1 = isWaterArea(tags);
    const areaKind = areaKindOf(tags);
    const poiKind = poiKindOf(tags);
    const hasAddr = !!tags['addr:housenumber'];
    if (!isBuilding && !water1 && !areaKind && !poiKind && !hasAddr) continue;

    const polys = polygonsOf(el);
    for (const poly of polys) {
      if (isBuilding) {
        const s = simplifyPolygon(poly, 0.2);
        if (s && polygonArea(s) >= 4) buildings.push({ r: s, h: Math.round(buildingHeight(tags) * 10) / 10 });
      } else if (water1) {
        const s = simplifyPolygon(poly, 0.5);
        if (s && polygonArea(s) >= 20) water.push({ r: s });
      } else if (areaKind) {
        const s = simplifyPolygon(poly, 1);
        if (s && polygonArea(s) >= 50) areas.push({ k: AREA_KINDS.indexOf(areaKind), r: s });
      }
    }
    // POIs and addresses mapped on building outlines or areas.
    if (polys.length && (poiKind || hasAddr)) {
      const [cx, cy] = centroid(polys[0][0]);
      const isPoi = addPoi(cx, cy, tags);
      if (!isPoi) addAddress(cx, cy, tags);
    }
  }

  if (coast.length) {
    const sea = buildSea(coast, rect);
    if (sea.stats.danglingEnds) warnings.push(`coastline: ${sea.stats.danglingEnds} chain end(s) inside the map were extended to the border`);
    for (const poly of sea.polygons) {
      const s = simplifyPolygon(poly, 1);
      if (s) water.push({ r: s, sea: 1 });
    }
  }

  // Big polygons first so smaller features draw on top of them.
  areas.sort((a, b) => Math.abs(ringSignedArea(b.r[0])) - Math.abs(ringSignedArea(a.r[0])));

  const spawnPoint = spawn as { x: number; y: number } | null;
  if (!spawnPoint) warnings.push(`no station/place named "${opts.spawnName ?? opts.name}" found: spawning at the map centre`);
  const map: GameMapData = {
    version: 1,
    name: opts.name,
    attribution: '© участники OpenStreetMap (ODbL)',
    generatedAt: new Date().toISOString(),
    origin: { lat: lat0, lon: lon0 },
    bounds: {
      minX: Math.round(minX),
      minY: Math.round(minY),
      maxX: Math.round(maxX),
      maxY: Math.round(maxY),
    },
    spawn: spawnPoint
      ? { x: Math.round(spawnPoint.x), y: Math.round(spawnPoint.y) }
      : { x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2) },
    names,
    nodes,
    roads,
    buildings,
    areas,
    water,
    waterways,
    rails,
    pois,
    addresses,
  };
  const stats = {
    roadNodes: nodes.length / 2,
    roads: roads.length,
    buildings: buildings.length,
    areas: areas.length,
    water: water.length,
    seaPolygons: water.filter((w) => w.sea).length,
    waterways: waterways.length,
    rails: rails.length,
    pois: pois.length,
    addresses: addresses.length,
    names: names.length,
  };
  return { map, stats, warnings };
}
