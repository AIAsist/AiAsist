// Small 2D geometry helpers over flat coordinate arrays ([x0, y0, x1, y1, ...]).

import type { FlatCoords, PolygonRings } from '../data/mapFormat';

/** Signed area of a ring (positive = counter-clockwise). */
export function ringSignedArea(ring: FlatCoords): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    sum += (ring[j] - ring[i]) * (ring[j + 1] + ring[i + 1]);
  }
  return sum / 2;
}

export function polygonArea(rings: PolygonRings): number {
  let a = Math.abs(ringSignedArea(rings[0]));
  for (let k = 1; k < rings.length; k++) a -= Math.abs(ringSignedArea(rings[k]));
  return a;
}

export function pointInRing(x: number, y: number, ring: FlatCoords): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = ring[i];
    const yi = ring[i + 1];
    const xj = ring[j];
    const yj = ring[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Even-odd test over all rings, so holes work regardless of orientation. */
export function pointInPolygon(x: number, y: number, rings: PolygonRings): boolean {
  let inside = false;
  for (const ring of rings) if (pointInRing(x, y, ring)) inside = !inside;
  return inside;
}

export function distSqToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

export function bboxOf(coords: FlatCoords): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < coords.length; i += 2) {
    const x = coords[i];
    const y = coords[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** Douglas–Peucker simplification of an open polyline. Keeps both endpoints. */
export function simplifyLine(coords: FlatCoords, tolerance: number): FlatCoords {
  const n = coords.length / 2;
  if (n <= 2) return coords.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = tolerance * tolerance;
  const stack: number[] = [0, n - 1];
  while (stack.length) {
    const last = stack.pop()!;
    const first = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    const ax = coords[first * 2];
    const ay = coords[first * 2 + 1];
    const bx = coords[last * 2];
    const by = coords[last * 2 + 1];
    for (let i = first + 1; i < last; i++) {
      const d = distSqToSegment(coords[i * 2], coords[i * 2 + 1], ax, ay, bx, by);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tol2) {
      keep[idx] = 1;
      stack.push(first, idx, idx, last);
    }
  }
  const out: FlatCoords = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(coords[i * 2], coords[i * 2 + 1]);
  return out;
}

/** Simplifies a closed ring (given without the closing point). Returns null if it degenerates. */
export function simplifyRing(ring: FlatCoords, tolerance: number): FlatCoords | null {
  if (ring.length < 6) return null;
  // Split at the vertex farthest from the first one so both halves are well-conditioned.
  let far = 0;
  let farD = -1;
  for (let i = 2; i < ring.length; i += 2) {
    const d = (ring[i] - ring[0]) ** 2 + (ring[i + 1] - ring[1]) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = simplifyLine(ring.slice(0, far + 2), tolerance);
  const b = simplifyLine([...ring.slice(far), ring[0], ring[1]], tolerance);
  const out = [...a, ...b.slice(2, -2)];
  if (out.length < 6 || Math.abs(ringSignedArea(out)) < 1e-6) return null;
  return out;
}

export function roundCoords(coords: FlatCoords, decimals = 1): FlatCoords {
  const f = 10 ** decimals;
  return coords.map((v) => Math.round(v * f) / f);
}
