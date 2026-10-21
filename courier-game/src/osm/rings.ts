// Assembles closed rings from OSM way pieces (multipolygon members) and groups them into polygons.

import type { FlatCoords, PolygonRings } from '../data/mapFormat';
import { pointInRing, ringSignedArea } from '../world/geometry';

const key = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`;

function isClosed(c: FlatCoords): boolean {
  const n = c.length;
  return n >= 8 && key(c[0], c[1]) === key(c[n - 2], c[n - 1]);
}

function reversed(c: FlatCoords): FlatCoords {
  const out: FlatCoords = new Array(c.length);
  for (let i = 0, j = c.length - 2; j >= 0; i += 2, j -= 2) {
    out[i] = c[j];
    out[i + 1] = c[j + 1];
  }
  return out;
}

/**
 * Joins open polylines end-to-end (reversing pieces when needed) into closed rings.
 * Returned rings do not repeat the first point at the end. Pieces that cannot be closed are dropped.
 */
export function assembleRings(pieces: FlatCoords[]): { rings: FlatCoords[]; dropped: number } {
  const rings: FlatCoords[] = [];
  const open: (FlatCoords | null)[] = [];
  for (const p of pieces) {
    if (p.length < 4) continue;
    if (isClosed(p)) rings.push(p.slice(0, -2));
    else open.push(p);
  }

  const byEnd = new Map<string, number[]>();
  const addEnd = (k: string, idx: number) => {
    const list = byEnd.get(k);
    if (list) list.push(idx);
    else byEnd.set(k, [idx]);
  };
  open.forEach((p, idx) => {
    addEnd(key(p![0], p![1]), idx);
    addEnd(key(p![p!.length - 2], p![p!.length - 1]), idx);
  });

  let dropped = 0;
  for (let start = 0; start < open.length; start++) {
    const first = open[start];
    if (!first) continue;
    open[start] = null;
    let ring = first.slice();
    const startKey = key(ring[0], ring[1]);
    let closed = false;
    for (;;) {
      const endKey = key(ring[ring.length - 2], ring[ring.length - 1]);
      if (endKey === startKey) {
        closed = true;
        break;
      }
      const candidates = byEnd.get(endKey) ?? [];
      const nextIdx = candidates.find((i) => open[i] !== null);
      if (nextIdx === undefined) break;
      let next = open[nextIdx]!;
      open[nextIdx] = null;
      if (key(next[0], next[1]) !== endKey) next = reversed(next);
      ring = ring.concat(next.slice(2));
    }
    if (closed && ring.length >= 8) rings.push(ring.slice(0, -2));
    else dropped++;
  }
  return { rings, dropped };
}

/** Groups outer and inner rings into polygons: each inner ring goes into the smallest outer that contains it. */
export function buildPolygons(outer: FlatCoords[], inner: FlatCoords[]): PolygonRings[] {
  const outers = outer
    .filter((r) => r.length >= 6)
    .map((r) => ({ ring: r, area: Math.abs(ringSignedArea(r)), holes: [] as FlatCoords[] }))
    .sort((a, b) => a.area - b.area);
  for (const hole of inner) {
    if (hole.length < 6) continue;
    const host = outers.find((o) => pointInRing(hole[0], hole[1], o.ring));
    if (host) host.holes.push(hole);
  }
  return outers.map((o) => [o.ring, ...o.holes]);
}
