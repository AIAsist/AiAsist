// Static world queries built from the map: road surface, buildings, water, street names, routing.

import { ROAD_CLASSES, ROAD_HALF_WIDTH, type GameMapData, type PolygonRings } from '../data/mapFormat';
import { bboxOf, distSqToSegment, pointInPolygon } from './geometry';
import { RoadGraph } from './graph';
import { SpatialGrid } from './spatialGrid';

const HALF_WIDTHS = ROAD_CLASSES.map((c) => ROAD_HALF_WIDTH[c]);

/** Bit raster of water (lakes, rivers, sea) over the map bounds. */
export class WaterMask {
  readonly cols: number;
  readonly rows: number;
  private readonly bits: Uint8Array;

  constructor(
    readonly minX: number,
    readonly minY: number,
    maxX: number,
    maxY: number,
    readonly res: number,
  ) {
    this.cols = Math.ceil((maxX - minX) / res);
    this.rows = Math.ceil((maxY - minY) / res);
    this.bits = new Uint8Array(Math.ceil((this.cols * this.rows) / 8));
  }

  /** Scanline fill with the even-odd rule over all rings (holes work). */
  fillPolygon(rings: PolygonRings): void {
    const [x0, y0, x1, y1] = bboxOf(rings[0]);
    const r0 = Math.max(0, Math.floor((y0 - this.minY) / this.res));
    const r1 = Math.min(this.rows - 1, Math.ceil((y1 - this.minY) / this.res));
    if (r0 > r1 || x1 < this.minX || x0 > this.minX + this.cols * this.res) return;
    // Edge list: [ax, ay, bx, by] with ay <= by, skipping horizontal edges.
    const edges: number[] = [];
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
        let ax = ring[j];
        let ay = ring[j + 1];
        let bx = ring[i];
        let by = ring[i + 1];
        if (ay === by) continue;
        if (ay > by) [ax, ay, bx, by] = [bx, by, ax, ay];
        edges.push(ax, ay, bx, by);
      }
    }
    const xs: number[] = [];
    for (let r = r0; r <= r1; r++) {
      const y = this.minY + (r + 0.5) * this.res;
      xs.length = 0;
      for (let e = 0; e < edges.length; e += 4) {
        const ay = edges[e + 1];
        const by = edges[e + 3];
        if (y < ay || y >= by) continue;
        const ax = edges[e];
        xs.push(ax + ((y - ay) / (by - ay)) * (edges[e + 2] - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - this.minX) / this.res - 0.5));
        const c1 = Math.min(this.cols - 1, Math.floor((xs[k + 1] - this.minX) / this.res - 0.5));
        for (let c = c0; c <= c1; c++) {
          const idx = r * this.cols + c;
          this.bits[idx >> 3] |= 1 << (idx & 7);
        }
      }
    }
  }

  get(x: number, y: number): boolean {
    const c = Math.floor((x - this.minX) / this.res);
    const r = Math.floor((y - this.minY) / this.res);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return false;
    const idx = r * this.cols + c;
    return (this.bits[idx >> 3] & (1 << (idx & 7))) !== 0;
  }
}

export interface RoadHit {
  segment: number;
  /** Distance from the road centre line, metres. */
  dist: number;
}

export class World {
  readonly graph: RoadGraph;
  readonly bounds: GameMapData['bounds'];
  readonly water: WaterMask;
  /** Road segments: node index pairs. */
  readonly segA: Int32Array;
  readonly segB: Int32Array;
  readonly segRoad: Int32Array;
  private readonly roadGrid: SpatialGrid;
  private readonly buildingGrid: SpatialGrid;
  private readonly buildingBoxes: Float64Array;

  constructor(readonly map: GameMapData) {
    this.bounds = map.bounds;
    const { minX, minY, maxX, maxY } = map.bounds;
    this.graph = new RoadGraph(map.nodes, map.roads, map.bounds);

    const pad = 400;
    this.roadGrid = new SpatialGrid(minX - pad, minY - pad, maxX + pad, maxY + pad, 25);
    const a: number[] = [];
    const b: number[] = [];
    const ri: number[] = [];
    const xs = this.graph.xs;
    const ys = this.graph.ys;
    map.roads.forEach((road, r) => {
      const hw = HALF_WIDTHS[road.c] ?? 3;
      for (let k = 0; k + 1 < road.i.length; k++) {
        const p = road.i[k];
        const q = road.i[k + 1];
        const id = a.length;
        a.push(p);
        b.push(q);
        ri.push(r);
        this.roadGrid.insert(
          id,
          Math.min(xs[p], xs[q]) - hw,
          Math.min(ys[p], ys[q]) - hw,
          Math.max(xs[p], xs[q]) + hw,
          Math.max(ys[p], ys[q]) + hw,
        );
      }
    });
    this.segA = Int32Array.from(a);
    this.segB = Int32Array.from(b);
    this.segRoad = Int32Array.from(ri);

    this.buildingGrid = new SpatialGrid(minX - pad, minY - pad, maxX + pad, maxY + pad, 25);
    this.buildingBoxes = new Float64Array(map.buildings.length * 4);
    map.buildings.forEach((bld, i) => {
      const [x0, y0, x1, y1] = bboxOf(bld.r[0]);
      this.buildingBoxes.set([x0, y0, x1, y1], i * 4);
      this.buildingGrid.insert(i, x0, y0, x1, y1);
    });

    this.water = new WaterMask(minX, minY, maxX, maxY, 2);
    for (const w of map.water) this.water.fillPolygon(w.r);
  }

  /** The road under (x, y) — the closest segment whose drivable width covers the point — or null. */
  roadAt(x: number, y: number, extra = 0.6): RoadHit | null {
    let best = -1;
    let bestD = Infinity;
    const xs = this.graph.xs;
    const ys = this.graph.ys;
    for (const s of this.roadGrid.at(x, y)) {
      const p = this.segA[s];
      const q = this.segB[s];
      const d2 = distSqToSegment(x, y, xs[p], ys[p], xs[q], ys[q]);
      const hw = HALF_WIDTHS[this.map.roads[this.segRoad[s]].c] + extra;
      if (d2 <= hw * hw && d2 < bestD) {
        bestD = d2;
        best = s;
      }
    }
    return best < 0 ? null : { segment: best, dist: Math.sqrt(bestD) };
  }

  onRoad(x: number, y: number): boolean {
    return this.roadAt(x, y) !== null;
  }

  inBuilding(x: number, y: number): boolean {
    const boxes = this.buildingBoxes;
    for (const i of this.buildingGrid.at(x, y)) {
      const o = i * 4;
      if (x < boxes[o] || y < boxes[o + 1] || x > boxes[o + 2] || y > boxes[o + 3]) continue;
      if (pointInPolygon(x, y, this.map.buildings[i].r)) return true;
    }
    return false;
  }

  inWater(x: number, y: number): boolean {
    return this.water.get(x, y);
  }

  insideBounds(x: number, y: number, margin = 0): boolean {
    const b = this.bounds;
    return x >= b.minX + margin && x <= b.maxX - margin && y >= b.minY + margin && y <= b.maxY - margin;
  }

  /**
   * Whether a round body of radius `r` can stand at (x, y). Roads are always passable: bridges over
   * water, passages through buildings, and footways that OSM draws slightly overlapping a wall.
   */
  isBlocked(x: number, y: number, r: number): boolean {
    if (!this.insideBounds(x, y, r)) return true;
    if (this.onRoad(x, y)) return false;
    if (
      this.inBuilding(x, y) ||
      this.inBuilding(x + r, y) ||
      this.inBuilding(x - r, y) ||
      this.inBuilding(x, y + r) ||
      this.inBuilding(x, y - r)
    )
      return true;
    return this.inWater(x, y);
  }

  /** Whether a body of radius `r` can go straight from one point to another. */
  clearLine(x0: number, y0: number, x1: number, y1: number, r: number): boolean {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.ceil(d / 1.5);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (this.isBlocked(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r)) return false;
    }
    return true;
  }

  /** Name of the closest named road within `radius` metres. */
  streetNameAt(x: number, y: number, radius = 30): string | null {
    let best: string | null = null;
    let bestD = radius * radius;
    const xs = this.graph.xs;
    const ys = this.graph.ys;
    this.roadGrid.forEachIn(x - radius, y - radius, x + radius, y + radius, (s) => {
      const road = this.map.roads[this.segRoad[s]];
      if (road.n < 0) return;
      const p = this.segA[s];
      const q = this.segB[s];
      const d2 = distSqToSegment(x, y, xs[p], ys[p], xs[q], ys[q]);
      if (d2 < bestD) {
        bestD = d2;
        best = this.map.names[road.n];
      }
    });
    return best;
  }

  /** A free spot on the road network near (x, y): used for spawning and «unstuck». */
  findFreeSpot(x: number, y: number, r: number): { x: number; y: number } {
    const node = this.graph.nearestNode(x, y, 3000);
    if (node >= 0) {
      const nx = this.graph.xs[node];
      const ny = this.graph.ys[node];
      if (!this.isBlocked(nx, ny, r)) return { x: nx, y: ny };
    }
    // Spiral search for any free point.
    for (let rad = 2; rad < 500; rad += 2) {
      for (let a = 0; a < 16; a++) {
        const px = x + rad * Math.cos((a * Math.PI) / 8);
        const py = y + rad * Math.sin((a * Math.PI) / 8);
        if (!this.isBlocked(px, py, r)) return { x: px, y: py };
      }
    }
    return { x, y };
  }
}
