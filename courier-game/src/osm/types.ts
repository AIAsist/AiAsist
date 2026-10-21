// Subset of the Overpass API JSON output (`out body geom`).

export type Tags = Record<string, string>;
export type LatLon = { lat: number; lon: number } | null;

export interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Tags;
}

export interface OsmWay {
  type: 'way';
  id: number;
  nodes?: number[];
  geometry?: LatLon[];
  tags?: Tags;
}

export interface OsmMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
  geometry?: LatLon[];
  lat?: number;
  lon?: number;
}

export interface OsmRelation {
  type: 'relation';
  id: number;
  members?: OsmMember[];
  tags?: Tags;
}

export type OsmElement = OsmNode | OsmWay | OsmRelation;

export interface OverpassResponse {
  elements: OsmElement[];
}

/** Geographic bounding box. */
export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}
