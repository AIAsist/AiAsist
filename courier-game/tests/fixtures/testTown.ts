// Synthetic Overpass response for a fictional town «Тестоград» — used by unit tests and for
// running the game without network access to Overpass. It is NOT a real place.
//
// Layout (metres, x → east, y → north, origin at TEST_ORIGIN):
//  - sea on the west behind a wavy coastline (x ≈ -900), with a small island;
//  - a street grid every 200 m, «Главный проспект» (primary) along y = 0;
//  - a river band at y ≈ -505 crossed by bridges; a lake around (650, 550);
//  - houses with addresses along the streets, a courtyard building (multipolygon);
//  - a park, a forest with a clearing, a beach; a railway with the station «Тестоград».

import { makeProjection } from '../../src/osm/projection';
import type { BBox, OsmElement, OsmNode, OsmRelation, OsmWay, Tags } from '../../src/osm/types';

export const TEST_ORIGIN = { lat: 60.0, lon: 30.0 };
export const TEST_HALF = { x: 1200, y: 1000 };
const proj = makeProjection(TEST_ORIGIN.lat, TEST_ORIGIN.lon);

export function testTownBBox(): BBox {
  const [south, west] = proj.toLatLon(-TEST_HALF.x, -TEST_HALF.y);
  const [north, east] = proj.toLatLon(TEST_HALF.x, TEST_HALF.y);
  return { south: north > south ? south : north, west, north, east };
}

const COAST_X = (y: number) => -900 + 40 * Math.sin(y / 150);
const LAKE = { x: 650, y: 550, r: 120 };
const RIVER = { y0: -520, y1: -490 };
const PARK = { x0: -490, y0: 210, x1: -310, y1: 390 };
const FOREST = { x0: 220, y0: -390, x1: 980, y1: -210 };

const STREETS_X = [-700, -500, -300, -100, 100, 300, 500, 700, 900];
const STREETS_Y = [-800, -600, -400, -200, 0, 200, 400, 600, 800];
const NAMES_X = [
  'Морская улица',
  'улица Пушкина',
  'Садовая улица',
  'Школьная улица',
  'Тестовый переулок',
  'Лесная улица',
  'Озёрная улица',
  'Полевая улица',
  'Вокзальная улица',
];
const NAMES_Y = [
  'Южная улица',
  'Речная улица',
  'улица Гагарина',
  'Почтовая улица',
  'Главный проспект',
  'Парковая улица',
  'Центральная улица',
  'Северная улица',
  'Дачная улица',
];

export function buildTestTown(): { elements: OsmElement[]; bbox: BBox } {
  const elements: OsmElement[] = [];
  let nextId = 1;
  const nodeIds = new Map<string, number>();
  const ll = (x: number, y: number) => {
    const [lat, lon] = proj.toLatLon(x, y);
    return { lat, lon };
  };
  /** Shared node ids for identical coordinates, so streets connect at intersections. */
  const nid = (x: number, y: number) => {
    const k = `${x.toFixed(2)},${y.toFixed(2)}`;
    let id = nodeIds.get(k);
    if (id === undefined) {
      id = nextId++;
      nodeIds.set(k, id);
    }
    return id;
  };
  const way = (pts: [number, number][], tags: Tags): OsmWay => {
    const w: OsmWay = { type: 'way', id: nextId++, nodes: pts.map(([x, y]) => nid(x, y)), geometry: pts.map(([x, y]) => ll(x, y)), tags };
    elements.push(w);
    return w;
  };
  const node = (x: number, y: number, tags: Tags): OsmNode => {
    const n: OsmNode = { type: 'node', id: nextId++, ...ll(x, y), tags };
    elements.push(n);
    return n;
  };
  const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
  const circle = (cx: number, cy: number, r: number, n = 24, ccw = true): [number, number][] => {
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = ((ccw ? 1 : -1) * i * 2 * Math.PI) / n;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    pts.push(pts[0]);
    return pts;
  };
  const inLake = (x: number, y: number, pad = 15) => Math.hypot(x - LAKE.x, y - LAKE.y) < LAKE.r + pad;

  // --- Sea: coastline split into three directed ways (north → south keeps land on the left/east).
  const coastPts: [number, number][] = [];
  for (let y = 1300; y >= -1300; y -= 50) coastPts.push([COAST_X(y), y]);
  const third = Math.floor(coastPts.length / 3);
  way(coastPts.slice(0, third + 1), { natural: 'coastline' });
  way(coastPts.slice(third, 2 * third + 1), { natural: 'coastline' });
  way(coastPts.slice(2 * third), { natural: 'coastline' });
  way(circle(-1060, 300, 40, 12, true), { natural: 'coastline', place: 'islet' });

  // --- Streets: blocks between intersections; vertical blocks over the river are bridges.
  STREETS_Y.forEach((y, j) => {
    const cls = y === 0 ? 'primary' : 'residential';
    for (let i = 0; i + 1 < STREETS_X.length; i++) {
      const x0 = STREETS_X[i];
      const x1 = STREETS_X[i + 1];
      const pts: [number, number][] = [];
      for (let x = x0; x <= x1; x += 50) pts.push([x, y]);
      const keep = pts.filter(([x]) => !inLake(x, y));
      if (keep.length === pts.length) way(pts, { highway: cls, name: NAMES_Y[j] });
    }
    // The streets run down to the beach road along the coast.
    way([[-850, y], [-800, y], [-750, y], [-700, y]], { highway: 'residential', name: NAMES_Y[j] });
  });
  STREETS_X.forEach((x, i) => {
    for (let j = 0; j + 1 < STREETS_Y.length; j++) {
      const y0 = STREETS_Y[j];
      const y1 = STREETS_Y[j + 1];
      const pts: [number, number][] = [];
      for (let y = y0; y <= y1; y += 50) pts.push([x, y]);
      if (pts.some(([px, py]) => inLake(px, py))) continue;
      const bridge = y0 < RIVER.y0 && y1 > RIVER.y1;
      way(pts, bridge ? { highway: 'residential', name: NAMES_X[i], bridge: 'yes', layer: '1' } : { highway: 'residential', name: NAMES_X[i] });
    }
  });
  // Coastal road (connects the street ends) and a park path.
  const coastRoad: [number, number][] = STREETS_Y.map((y) => [-850, y]);
  way(coastRoad, { highway: 'tertiary', name: 'Приморская набережная' });
  way([[-490, 210], [-400, 300], [-310, 390]], { highway: 'footway' });
  way([[-400, 200], [-400, 300]], { highway: 'path' });
  way([[900, 100], [950, 100], [1000, 100], [1050, 100]], { highway: 'service', name: 'Привокзальная площадь' });
  way([[0, 820], [0, 900]], { highway: 'construction' });

  // --- Water: lake and river band.
  way(circle(LAKE.x, LAKE.y, LAKE.r, 28), { natural: 'water', name: 'Тестовое озеро' });
  way(rect(-950, RIVER.y0, 1300, RIVER.y1), { natural: 'water', water: 'river', name: 'Тест-река' });
  way([[400, 820], [450, 870], [520, 900]], { waterway: 'stream' });

  // --- Green areas.
  way(rect(PARK.x0, PARK.y0, PARK.x1, PARK.y1), { leisure: 'park', name: 'Тестовый парк' });
  const forestOuter = way(rect(FOREST.x0, FOREST.y0, FOREST.x1, FOREST.y1), {});
  const clearing = way(rect(500, -350, 600, -250), {});
  const forestRel: OsmRelation = {
    type: 'relation',
    id: nextId++,
    tags: { type: 'multipolygon', landuse: 'forest' },
    members: [
      { type: 'way', ref: forestOuter.id, role: 'outer', geometry: forestOuter.geometry },
      { type: 'way', ref: clearing.id, role: 'inner', geometry: clearing.geometry },
    ],
  };
  elements.push(forestRel);
  way(rect(-880, 220, -820, 580), { natural: 'beach' });

  // --- Buildings with addresses along the streets.
  let houses = 0;
  const blocked = (x: number, y: number) =>
    x < COAST_X(y) + 60 ||
    inLake(x, y, 30) ||
    (y > RIVER.y0 - 25 && y < RIVER.y1 + 25) ||
    (x > PARK.x0 - 5 && x < PARK.x1 + 5 && y > PARK.y0 - 5 && y < PARK.y1 + 5) ||
    (x > FOREST.x0 - 5 && x < FOREST.x1 + 5 && y > FOREST.y0 - 5 && y < FOREST.y1 + 5);
  STREETS_Y.forEach((y, j) => {
    for (let i = 0; i + 1 < STREETS_X.length; i++) {
      for (const side of [1, -1]) {
        for (let k = 0; k < 4; k++) {
          const cx = STREETS_X[i] + 35 + k * 43;
          const cy = y + side * 22;
          if (blocked(cx, cy) || Math.abs(cy) > 900) continue;
          const apartments = j === 4;
          const hw = apartments ? 16 : 6;
          const hh = apartments ? 7 : 5;
          const house = String(i * 8 + k * 2 + (side > 0 ? 1 : 2));
          way(rect(cx - hw, cy - hh, cx + hw, cy + hh), {
            building: apartments ? 'apartments' : 'house',
            ...(apartments ? { 'building:levels': '5' } : {}),
            'addr:street': NAMES_Y[j],
            'addr:housenumber': house,
          });
          houses++;
        }
      }
    }
  });
  // Courtyard building as a multipolygon relation.
  const outer = way(rect(160, 270, 240, 330), {});
  const inner = way(rect(185, 285, 215, 315), {});
  elements.push({
    type: 'relation',
    id: nextId++,
    tags: { type: 'multipolygon', building: 'apartments', 'building:levels': '6', 'addr:street': 'Парковая улица', 'addr:housenumber': '101' },
    members: [
      { type: 'way', ref: outer.id, role: 'outer', geometry: outer.geometry },
      { type: 'way', ref: inner.id, role: 'inner', geometry: inner.geometry },
    ],
  });
  // A supermarket mapped as a building outline.
  way(rect(-140, 40, -60, 80), { building: 'retail', shop: 'supermarket', name: 'Универсам «Тест»', 'addr:street': 'Главный проспект', 'addr:housenumber': '12' });

  // --- Pickup points.
  node(-80, -20, { amenity: 'cafe', name: 'Кофейня «Пробник»' });
  node(320, 20, { amenity: 'fast_food', cuisine: 'pizza', name: 'Пицца «Тест»' });
  node(520, -180, { amenity: 'restaurant', name: 'Столовая №1' });
  node(-480, 420, { amenity: 'pharmacy', name: 'Аптека «Здоровье»' });
  node(120, -420, { shop: 'bakery', name: 'Пекарня у моста' });
  node(-680, -180, { shop: 'florist' });
  node(720, 220, { shop: 'convenience', name: 'Продукты 24' });
  node(-280, -620, { amenity: 'fast_food', cuisine: 'burger', name: 'Шаурма у вокзала' });
  node(10, 10, { shop: 'car_repair', name: 'Автосервис' }); // not a pickup point

  // --- Railway, station and place.
  way([[1100, 1300], [1100, 0], [1100, -1300]], { railway: 'rail' });
  node(1100, 100, { railway: 'station', name: 'Тестоград' });
  node(0, 0, { place: 'town', name: 'Тестоград' });

  if (houses < 50) throw new Error('test town generator: too few houses');
  return { elements, bbox: testTownBBox() };
}
