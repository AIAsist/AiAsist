// Delivery orders: where to pick up (cafés, shops from OSM), where to deliver (real addresses).

import { CARGO, POI_ICONS } from '../data/labels';
import { POI_KINDS, type PoiKind } from '../data/mapFormat';
import { formatAddress } from '../osm/names';
import { bboxOf } from './geometry';
import type { Vehicle } from './vehicles';
import type { World } from './world';
import { COURIER_RADIUS } from './courier';

export interface Place {
  /** Where the courier has to get to (outside any building, next to the road network). */
  x: number;
  y: number;
  title: string;
  subtitle: string;
  icon: string;
  node: number;
  kind?: PoiKind;
}

export interface Offer {
  id: number;
  pickup: Place;
  drop: Place;
  cargo: string;
  /** Base pay, ₽. */
  pay: number;
  /** Route length pickup → drop, metres. */
  routeLength: number;
  expiresAt: number;
}

export type Rng = () => number;

const MAX_SNAP = 150;

/** Moves a point that lies inside a building towards its road node until the courier fits. */
function accessPoint(world: World, x: number, y: number, node: number): { x: number; y: number } {
  if (!world.isBlocked(x, y, COURIER_RADIUS)) return { x, y };
  const nx = world.graph.xs[node];
  const ny = world.graph.ys[node];
  const d = Math.hypot(nx - x, ny - y);
  for (let t = 1; t < d; t += 1) {
    const px = x + ((nx - x) * t) / d;
    const py = y + ((ny - y) * t) / d;
    if (!world.isBlocked(px, py, COURIER_RADIUS)) return { x: px, y: py };
  }
  return { x: nx, y: ny };
}

export function buildPickups(world: World): Place[] {
  const out: Place[] = [];
  for (const poi of world.map.pois) {
    if (!world.insideBounds(poi.x, poi.y, 30)) continue;
    const node = world.graph.nearestNode(poi.x, poi.y, MAX_SNAP);
    if (node < 0) continue;
    const kind = POI_KINDS[poi.k] ?? 'shop';
    const p = accessPoint(world, poi.x, poi.y, node);
    out.push({
      ...p,
      node,
      kind,
      title: poi.name,
      subtitle: poi.addr ?? world.streetNameAt(poi.x, poi.y, 80) ?? '',
      icon: POI_ICONS[kind],
    });
  }
  return out;
}

export function buildDrops(world: World): Place[] {
  const out: Place[] = [];
  const add = (x: number, y: number, title: string) => {
    if (!world.insideBounds(x, y, 30)) return;
    const node = world.graph.nearestNode(x, y, MAX_SNAP);
    if (node < 0) return;
    out.push({ ...accessPoint(world, x, y, node), node, title, subtitle: 'клиент', icon: '🏠' });
  };
  for (const a of world.map.addresses) add(a.x, a.y, formatAddress(a.street, a.house));
  if (out.length < 20) {
    // Few addresses in OSM: deliver to buildings, named after the nearest street.
    for (const b of world.map.buildings) {
      const [x0, y0, x1, y1] = bboxOf(b.r[0]);
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const street = world.streetNameAt(cx, cy, 60);
      if (street) add(cx, cy, `${street}, дом`);
    }
  }
  return out;
}

export class OrderBoard {
  offers: Offer[] = [];
  private nextId = 1;

  constructor(
    private readonly world: World,
    readonly pickups: Place[],
    readonly drops: Place[],
    private readonly rng: Rng = Math.random,
  ) {}

  /** Drops expired offers and tops the list up to `count` offers around the courier. */
  refresh(now: number, x: number, y: number, vehicle: Vehicle, count = 3): boolean {
    const before = this.offers.length;
    this.offers = this.offers.filter((o) => o.expiresAt > now);
    let changed = this.offers.length !== before;
    for (let tries = 0; this.offers.length < count && tries < count * 2; tries++) {
      const offer = this.makeOffer(now, x, y, vehicle);
      if (offer) {
        this.offers.push(offer);
        changed = true;
      }
    }
    return changed;
  }

  take(id: number): Offer | null {
    const idx = this.offers.findIndex((o) => o.id === id);
    if (idx < 0) return null;
    return this.offers.splice(idx, 1)[0];
  }

  clear(): void {
    this.offers = [];
  }

  makeOffer(now: number, x: number, y: number, vehicle: Vehicle): Offer | null {
    if (!this.pickups.length || !this.drops.length) return null;
    const [minLen, maxLen] = vehicle.orderRange;
    const near = this.pickups
      .map((p) => ({ p, d: Math.hypot(p.x - x, p.y - y) }))
      .sort((a, b) => a.d - b.d);
    let pool = near.filter((e) => e.d <= maxLen * 0.6);
    if (pool.length < 3) pool = near.slice(0, 6);

    for (let attempt = 0; attempt < 10; attempt++) {
      const pickup = pool[Math.floor(this.rng() * pool.length)].p;
      for (let k = 0; k < 12; k++) {
        const drop = this.drops[Math.floor(this.rng() * this.drops.length)];
        const straight = Math.hypot(drop.x - pickup.x, drop.y - pickup.y);
        if (straight < minLen * 0.5 || straight > maxLen) continue;
        if (this.offers.some((o) => o.pickup === pickup && o.drop === drop)) continue;
        const path = this.world.graph.shortestPath(pickup.node, drop.node, maxLen);
        if (!path || path.length < minLen || path.length > maxLen) continue;
        const cargoList = CARGO[pickup.kind ?? 'shop'];
        return {
          id: this.nextId++,
          pickup,
          drop,
          cargo: cargoList[Math.floor(this.rng() * cargoList.length)],
          pay: priceFor(path.length),
          routeLength: path.length,
          expiresAt: now + 40 + this.rng() * 30,
        };
      }
    }
    return null;
  }
}

/** Base pay for a route, ₽ (rounded to 5). */
export function priceFor(routeLength: number): number {
  return Math.round((40 + routeLength * 0.06) / 5) * 5;
}

/** Time limit for the whole order (to the pickup and on to the client), seconds. */
export function timeLimitFor(totalLength: number, vehicle: Vehicle): number {
  return Math.round(20 + totalLength / (vehicle.maxSpeed * 0.72));
}

export interface DeliveryResult {
  base: number;
  tip: number;
  bonus: number;
  stars: number;
  late: boolean;
}

/** Pay-out for a delivery given the time left (negative when late) and the on-time streak before it. */
export function settleDelivery(pay: number, timeLeft: number, timeLimit: number, streakBefore: number): DeliveryResult {
  if (timeLeft >= 0) {
    const share = timeLeft / timeLimit;
    const tip = Math.round((pay * 0.4 * share) / 5) * 5;
    const streak = streakBefore + 1;
    const bonus = streak > 1 ? Math.round((pay * 0.1 * Math.min(streak - 1, 5)) / 5) * 5 : 0;
    return { base: pay, tip, bonus, stars: share > 0.25 ? 5 : 4, late: false };
  }
  const lateness = -timeLeft;
  const factor = Math.max(0.4, 1 - (lateness / 60) * 0.3);
  return {
    base: Math.round((pay * factor) / 5) * 5,
    tip: 0,
    bonus: 0,
    stars: lateness < 30 ? 3 : lateness < 90 ? 2 : 1,
    late: true,
  };
}
