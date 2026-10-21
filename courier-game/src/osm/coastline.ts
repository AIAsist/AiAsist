// Builds sea polygons inside a rectangle from natural=coastline ways.
// OSM convention: coastline ways run with land on the LEFT and water on the RIGHT.
// Pieces clipped to the rectangle are stitched clockwise along the rectangle border, which keeps
// the water on the right-hand side, so every resulting ring encloses sea.

import type { FlatCoords, PolygonRings } from '../data/mapFormat';
import { pointInRing, ringSignedArea } from '../world/geometry';

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CoastlineResult {
  polygons: PolygonRings[];
  stats: { chains: number; pieces: number; islands: number; danglingEnds: number };
}

const EPS = 1e-6;
const key = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`;

/** Joins directed coastline ways end→start into longer chains (direction is preserved). */
export function mergeChains(ways: FlatCoords[]): FlatCoords[] {
  const chains = ways.filter((w) => w.length >= 4).map((w) => w.slice());
  let merged = true;
  while (merged) {
    merged = false;
    const byStart = new Map<string, number>();
    chains.forEach((c, i) => byStart.set(key(c[0], c[1]), i));
    for (let i = 0; i < chains.length; i++) {
      const c = chains[i];
      const endKey = key(c[c.length - 2], c[c.length - 1]);
      if (endKey === key(c[0], c[1])) continue; // already closed
      const j = byStart.get(endKey);
      if (j === undefined || j === i) continue;
      chains[i] = c.concat(chains[j].slice(2));
      chains.splice(j, 1);
      merged = true;
      break;
    }
  }
  return chains;
}

function inside(r: Rect, x: number, y: number): boolean {
  return x >= r.minX - EPS && x <= r.maxX + EPS && y >= r.minY - EPS && y <= r.maxY + EPS;
}

/** Liang–Barsky: returns the [t0, t1] part of segment p→q inside the rectangle, or null. */
function clipSegment(r: Rect, px: number, py: number, qx: number, qy: number): [number, number] | null {
  const dx = qx - px;
  const dy = qy - py;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, px - r.minX],
    [dx, r.maxX - px],
    [-dy, py - r.minY],
    [dy, r.maxY - py],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return [t0, t1];
}

interface Piece {
  pts: FlatCoords;
}

/** Clips a polyline to the rectangle, returning the parts that lie inside it. */
export function clipPolyline(r: Rect, line: FlatCoords): FlatCoords[] {
  const pieces: FlatCoords[] = [];
  let cur: FlatCoords | null = null;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const px = line[i];
    const py = line[i + 1];
    const qx = line[i + 2];
    const qy = line[i + 3];
    const t = clipSegment(r, px, py, qx, qy);
    if (!t || t[1] - t[0] < 1e-12) {
      if (cur) {
        pieces.push(cur);
        cur = null;
      }
      continue;
    }
    const ax = px + (qx - px) * t[0];
    const ay = py + (qy - py) * t[0];
    const bx = px + (qx - px) * t[1];
    const by = py + (qy - py) * t[1];
    if (!cur) cur = [ax, ay];
    cur.push(bx, by);
    if (t[1] < 1) {
      pieces.push(cur);
      cur = null;
    }
  }
  if (cur) pieces.push(cur);
  return pieces.filter((p) => p.length >= 4);
}

/** Position along the rectangle border, measured clockwise (north up) from the top-left corner. */
function borderPos(r: Rect, x: number, y: number): number {
  const w = r.maxX - r.minX;
  const h = r.maxY - r.minY;
  const dTop = Math.abs(y - r.maxY);
  const dRight = Math.abs(x - r.maxX);
  const dBottom = Math.abs(y - r.minY);
  const dLeft = Math.abs(x - r.minX);
  const m = Math.min(dTop, dRight, dBottom, dLeft);
  if (m === dTop) return x - r.minX;
  if (m === dRight) return w + (r.maxY - y);
  if (m === dBottom) return w + h + (r.maxX - x);
  return 2 * w + h + (y - r.minY);
}

function onBorder(r: Rect, x: number, y: number): boolean {
  const tol = 1e-3;
  return (
    Math.abs(x - r.minX) < tol || Math.abs(x - r.maxX) < tol || Math.abs(y - r.minY) < tol || Math.abs(y - r.maxY) < tol
  );
}

/** Nearest point on the rectangle border (used to extend coastline ends that stop inside it). */
function snapToBorder(r: Rect, x: number, y: number): [number, number] {
  const d = [y - r.minY, r.maxY - y, x - r.minX, r.maxX - x];
  const m = Math.min(...d);
  if (m === d[0]) return [x, r.minY];
  if (m === d[1]) return [x, r.maxY];
  if (m === d[2]) return [r.minX, y];
  return [r.maxX, y];
}

export function buildSea(coastWays: FlatCoords[], rect: Rect): CoastlineResult {
  const chains = mergeChains(coastWays);
  const pieces: Piece[] = [];
  const islands: FlatCoords[] = [];
  const lakes: FlatCoords[] = [];
  let danglingEnds = 0;

  for (const chain of chains) {
    const n = chain.length;
    const closed = key(chain[0], chain[1]) === key(chain[n - 2], chain[n - 1]);
    let allInside = true;
    for (let i = 0; i < n; i += 2) {
      if (!inside(rect, chain[i], chain[i + 1])) {
        allInside = false;
        break;
      }
    }
    if (closed && allInside) {
      const ring = chain.slice(0, -2);
      // Counter-clockwise ring → land on the left = inside → island. Clockwise → enclosed water.
      if (ringSignedArea(ring) > 0) islands.push(ring);
      else lakes.push(ring);
      continue;
    }
    let parts = clipPolyline(rect, chain);
    // A closed ring that starts inside the rectangle is cut at its start point: glue the ends back.
    if (closed && parts.length >= 2 && inside(rect, chain[0], chain[1])) {
      const last = parts.pop()!;
      parts[0] = last.concat(parts[0].slice(2));
    }
    for (const p of parts) {
      if (!onBorder(rect, p[0], p[1])) {
        danglingEnds++;
        p.unshift(...snapToBorder(rect, p[0], p[1]));
      }
      if (!onBorder(rect, p[p.length - 2], p[p.length - 1])) {
        danglingEnds++;
        p.push(...snapToBorder(rect, p[p.length - 2], p[p.length - 1]));
      }
      pieces.push({ pts: p });
    }
  }

  const w = rect.maxX - rect.minX;
  const h = rect.maxY - rect.minY;
  const perimeter = 2 * (w + h);
  const corners: [number, number, number][] = [
    [0, rect.minX, rect.maxY],
    [w, rect.maxX, rect.maxY],
    [w + h, rect.maxX, rect.minY],
    [2 * w + h, rect.minX, rect.minY],
  ];
  const startPos = pieces.map((p) => borderPos(rect, p.pts[0], p.pts[1]));
  const endPos = pieces.map((p) => borderPos(rect, p.pts[p.pts.length - 2], p.pts[p.pts.length - 1]));
  const used = new Uint8Array(pieces.length);
  const outers: FlatCoords[] = [];

  for (let s = 0; s < pieces.length; s++) {
    if (used[s]) continue;
    const ring: FlatCoords = [];
    let cur = s;
    for (let guard = 0; guard <= pieces.length; guard++) {
      used[cur] = 1;
      ring.push(...pieces[cur].pts);
      const from = endPos[cur];
      // The next piece is the one whose start comes first going clockwise from this end.
      let best = -1;
      let bestD = Infinity;
      for (let k = 0; k < pieces.length; k++) {
        if (used[k] && k !== s) continue;
        let d = (startPos[k] - from + perimeter) % perimeter;
        if (d < 1e-9 && k === cur) d = perimeter; // own start at the same spot: full loop
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      if (best < 0) break;
      // Walk the border clockwise from this end to the next start, picking up the corners passed.
      corners
        .map(([cPos, cx, cy]) => [(cPos - from + perimeter) % perimeter, cx, cy] as const)
        .filter(([d]) => d > 1e-9 && d < bestD - 1e-9)
        .sort((a, b) => a[0] - b[0])
        .forEach(([, cx, cy]) => ring.push(cx, cy));
      if (best === s) break;
      cur = best;
    }
    if (ring.length >= 6 && Math.abs(ringSignedArea(ring)) > 1) outers.push(ring);
  }

  // Islands with no coastline crossing the rectangle at all: the whole rectangle is sea.
  if (pieces.length === 0 && islands.length > 0) {
    outers.push([rect.minX, rect.maxY, rect.maxX, rect.maxY, rect.maxX, rect.minY, rect.minX, rect.minY]);
  }

  const polygons: PolygonRings[] = outers.map((o) => [o]);
  for (const isl of islands) {
    const host = polygons.find((p) => pointInRing(isl[0], isl[1], p[0]));
    if (host) host.push(isl);
  }
  for (const lake of lakes) polygons.push([lake]);

  return {
    polygons,
    stats: { chains: chains.length, pieces: pieces.length, islands: islands.length, danglingEnds },
  };
}
