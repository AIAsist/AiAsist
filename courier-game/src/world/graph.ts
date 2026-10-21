// Road graph built from the map's road polylines: shortest paths for navigation and order pricing.

import type { FlatCoords, MapRoad } from '../data/mapFormat';
import { SpatialGrid } from './spatialGrid';

/** Route cost multiplier per road class: the courier prefers streets over footpaths a little. */
const CLASS_COST = [1, 1, 1, 1.05, 1.15];

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, key: number): void {
    const ids = this.ids;
    const keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }

  /** Removes the minimum; returns its id (key available via lastKey). */
  pop(): number {
    const ids = this.ids;
    const keys = this.keys;
    const top = ids[0];
    this.lastKey = keys[0];
    const id = ids.pop()!;
    const key = keys.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = id;
      keys[i] = key;
    }
    return top;
  }

  lastKey = 0;
}

export interface DistanceField {
  target: number;
  /** Weighted cost to the target per node (Infinity if unreachable). */
  cost: Float64Array;
  /** Next node towards the target (-1 at the target or when unreachable). */
  next: Int32Array;
}

export interface PathResult {
  nodes: number[];
  /** Geometric length, metres. */
  length: number;
}

export class RoadGraph {
  readonly count: number;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  private readonly start: Int32Array;
  private readonly to: Int32Array;
  private readonly cost: Float32Array;
  private readonly len: Float32Array;
  /** Connected component id per node; `mainComponent` is the largest one. */
  readonly component: Int32Array;
  readonly mainComponent: number;
  private readonly grid: SpatialGrid;

  constructor(nodes: FlatCoords, roads: MapRoad[], bounds: { minX: number; minY: number; maxX: number; maxY: number }) {
    const n = nodes.length / 2;
    this.count = n;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.xs[i] = nodes[2 * i];
      this.ys[i] = nodes[2 * i + 1];
    }

    // Undirected edges (the courier ignores one-way restrictions: arcade rules).
    const degree = new Int32Array(n + 1);
    const edges: [number, number, number][] = [];
    for (const road of roads) {
      const mult = CLASS_COST[road.c] ?? 1;
      for (let k = 0; k + 1 < road.i.length; k++) {
        const a = road.i[k];
        const b = road.i[k + 1];
        if (a === b) continue;
        edges.push([a, b, mult]);
        degree[a]++;
        degree[b]++;
      }
    }
    this.start = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) this.start[i + 1] = this.start[i] + degree[i];
    const fill = this.start.slice(0, n);
    const m = this.start[n];
    this.to = new Int32Array(m);
    this.cost = new Float32Array(m);
    this.len = new Float32Array(m);
    for (const [a, b, mult] of edges) {
      const l = Math.hypot(this.xs[a] - this.xs[b], this.ys[a] - this.ys[b]);
      let e = fill[a]++;
      this.to[e] = b;
      this.len[e] = l;
      this.cost[e] = l * mult;
      e = fill[b]++;
      this.to[e] = a;
      this.len[e] = l;
      this.cost[e] = l * mult;
    }

    // Connected components (iterative DFS).
    this.component = new Int32Array(n).fill(-1);
    const sizes: number[] = [];
    const stack: number[] = [];
    for (let s = 0; s < n; s++) {
      if (this.component[s] >= 0) continue;
      const id = sizes.length;
      let size = 0;
      this.component[s] = id;
      stack.push(s);
      while (stack.length) {
        const u = stack.pop()!;
        size++;
        for (let e = this.start[u]; e < this.start[u + 1]; e++) {
          const v = this.to[e];
          if (this.component[v] < 0) {
            this.component[v] = id;
            stack.push(v);
          }
        }
      }
      sizes.push(size);
    }
    this.mainComponent = sizes.length ? sizes.indexOf(Math.max(...sizes)) : -1;

    const pad = 500;
    this.grid = new SpatialGrid(bounds.minX - pad, bounds.minY - pad, bounds.maxX + pad, bounds.maxY + pad, 60);
    for (let i = 0; i < n; i++) this.grid.insert(i, this.xs[i], this.ys[i], this.xs[i], this.ys[i]);
  }

  /** Nearest node (optionally only in the main component) within `maxDist`, or -1. */
  nearestNode(x: number, y: number, maxDist = 400, mainOnly = true): number {
    let best = -1;
    let bestD = maxDist * maxDist;
    const cell = this.grid.cell;
    for (let ring = 0; ring * cell <= maxDist + cell; ring++) {
      const r = ring * cell;
      this.grid.forEachIn(x - r, y - r, x + r, y + r, (i) => {
        if (mainOnly && this.component[i] !== this.mainComponent) return;
        const d = (this.xs[i] - x) ** 2 + (this.ys[i] - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      // Everything closer than `r` has been seen once a node is found inside the searched square.
      if (best >= 0 && Math.sqrt(bestD) <= r) break;
    }
    return best;
  }

  /** Dijkstra from `target` over the whole graph: afterwards any node can follow `next` to the target. */
  distanceField(target: number): DistanceField {
    const n = this.count;
    const cost = new Float64Array(n).fill(Infinity);
    const next = new Int32Array(n).fill(-1);
    const heap = new MinHeap();
    cost[target] = 0;
    heap.push(target, 0);
    while (heap.size) {
      const u = heap.pop();
      const cu = heap.lastKey;
      if (cu > cost[u]) continue;
      for (let e = this.start[u]; e < this.start[u + 1]; e++) {
        const v = this.to[e];
        const c = cu + this.cost[e];
        if (c < cost[v]) {
          cost[v] = c;
          next[v] = u;
          heap.push(v, c);
        }
      }
    }
    return { target, cost, next };
  }

  /** Follows a distance field from `from` to its target. */
  pathFromField(field: DistanceField, from: number, maxNodes = 5000): number[] {
    if (from < 0 || !Number.isFinite(field.cost[from])) return [];
    const path = [from];
    let u = from;
    while (u !== field.target && path.length < maxNodes) {
      u = field.next[u];
      if (u < 0) break;
      path.push(u);
    }
    return path;
  }

  // A* scratch buffers, reused between calls (offer generation runs many searches per second).
  private aG: Float64Array | null = null;
  private aPrev: Int32Array | null = null;
  private aStamp: Uint32Array | null = null;
  private stamp = 0;

  /**
   * A* shortest path between two nodes. With `maxLength`, gives up (returns null) as soon as the
   * path is certain to be longer than that — much cheaper for rejecting far-away candidates.
   */
  shortestPath(from: number, to: number, maxLength = Infinity): PathResult | null {
    if (from < 0 || to < 0 || this.component[from] !== this.component[to]) return null;
    if (from === to) return { nodes: [from], length: 0 };
    if (!this.aG || !this.aPrev || !this.aStamp) {
      this.aG = new Float64Array(this.count);
      this.aPrev = new Int32Array(this.count);
      this.aStamp = new Uint32Array(this.count);
    }
    if (++this.stamp === 0xffffffff) {
      this.aStamp.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    const g = this.aG;
    const prev = this.aPrev;
    const seen = this.aStamp;
    const heap = new MinHeap();
    const tx = this.xs[to];
    const ty = this.ys[to];
    const h = (i: number) => Math.hypot(this.xs[i] - tx, this.ys[i] - ty);
    // Cost ≤ length × max class multiplier, so a cost bound above this means the length is too long.
    const maxCost = maxLength * Math.max(...CLASS_COST);
    g[from] = 0;
    prev[from] = -1;
    seen[from] = stamp;
    heap.push(from, h(from));
    let found = false;
    while (heap.size) {
      const u = heap.pop();
      if (u === to) {
        found = true;
        break;
      }
      if (heap.lastKey > maxCost) break;
      const gu = g[u];
      if (heap.lastKey > gu + h(u) + 1e-6) continue;
      for (let e = this.start[u]; e < this.start[u + 1]; e++) {
        const v = this.to[e];
        const c = gu + this.cost[e];
        if (seen[v] !== stamp || c < g[v]) {
          seen[v] = stamp;
          g[v] = c;
          prev[v] = u;
          heap.push(v, c + h(v));
        }
      }
    }
    if (!found) return null;
    const nodes: number[] = [];
    for (let u = to; u >= 0; u = prev[u]) nodes.push(u);
    nodes.reverse();
    return { nodes, length: this.pathLength(nodes) };
  }

  pathLength(nodes: number[]): number {
    let l = 0;
    for (let k = 0; k + 1 < nodes.length; k++) {
      l += Math.hypot(this.xs[nodes[k]] - this.xs[nodes[k + 1]], this.ys[nodes[k]] - this.ys[nodes[k + 1]]);
    }
    return l;
  }
}
