// Compact game-map format produced by scripts/build-map.ts from OpenStreetMap data.
// All coordinates are local metres: x → east, y → north, origin at `origin` (lat/lon).
// The same coordinates are used by the 2D view and by the future 3D view (z → up).

/** Flat list of coordinates: [x0, y0, x1, y1, ...]. */
export type FlatCoords = number[];

/** Polygon: first ring is outer, the rest are holes. Rings are not closed (last ≠ first). */
export type PolygonRings = FlatCoords[];

export const ROAD_CLASSES = [
  'major', // motorway, trunk, primary
  'secondary', // secondary, tertiary
  'street', // residential, unclassified, living_street
  'service', // service, track
  'path', // footway, path, cycleway, pedestrian, steps
] as const;
export type RoadClass = (typeof ROAD_CLASSES)[number];

/** Half of the drawn/drivable road width per class, metres (slightly exaggerated for the arcade view). */
export const ROAD_HALF_WIDTH: Record<RoadClass, number> = {
  major: 7,
  secondary: 5.5,
  street: 4,
  service: 2.8,
  path: 1.6,
};

export const AREA_KINDS = [
  'forest',
  'park',
  'grass',
  'wetland',
  'sand',
  'industrial',
  'residential',
  'cemetery',
  'pitch',
  'farmland',
] as const;
export type AreaKind = (typeof AREA_KINDS)[number];

export const POI_KINDS = [
  'restaurant',
  'cafe',
  'fast_food',
  'pizza',
  'supermarket',
  'grocery',
  'bakery',
  'pharmacy',
  'flowers',
  'shop',
] as const;
export type PoiKind = (typeof POI_KINDS)[number];

export interface MapRoad {
  /** Index into ROAD_CLASSES. */
  c: number;
  /** Index into `names`, or -1 when unnamed. */
  n: number;
  /** Indices into `nodes` (graph vertices), in way order. */
  i: number[];
  /** 1 when the road is a bridge (drawn above water). */
  b?: 1;
}

export interface MapBuilding {
  r: PolygonRings;
  /** Height in metres (from building:levels/height, or a default per building type). */
  h: number;
}

export interface MapArea {
  /** Index into AREA_KINDS. */
  k: number;
  r: PolygonRings;
}

export interface MapWater {
  r: PolygonRings;
  /** 1 for sea polygons reconstructed from natural=coastline. */
  sea?: 1;
}

export interface MapWaterway {
  /** Drawn width, metres. */
  w: number;
  p: FlatCoords;
}

export interface MapPoi {
  x: number;
  y: number;
  name: string;
  /** Index into POI_KINDS. */
  k: number;
  /** Street + house, when known. */
  addr?: string;
}

export interface MapAddress {
  x: number;
  y: number;
  street: string;
  house: string;
}

export interface GameMapData {
  version: 1;
  name: string;
  attribution: string;
  generatedAt: string;
  origin: { lat: number; lon: number };
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  spawn: { x: number; y: number };
  names: string[];
  /** Road graph vertices: [x0, y0, x1, y1, ...]. */
  nodes: FlatCoords;
  roads: MapRoad[];
  buildings: MapBuilding[];
  areas: MapArea[];
  water: MapWater[];
  waterways: MapWaterway[];
  rails: FlatCoords[];
  pois: MapPoi[];
  addresses: MapAddress[];
}
