// Game state and rules, independent of rendering (the 2D view today, a 3D view later).

import type { FlatCoords, GameMapData } from '../data/mapFormat';
import { createCourier, updateCourier, COURIER_RADIUS, type Courier, type MoveInput } from './courier';
import type { DistanceField } from './graph';
import {
  buildDrops,
  buildPickups,
  OrderBoard,
  settleDelivery,
  timeLimitFor,
  type DeliveryResult,
  type Offer,
  type Place,
  type Rng,
} from './orders';
import { SaveSlot, type KeyValueStore, type Profile } from './save';
import { StreetLife, type StreetEvent } from './street';
import { VEHICLES, vehicleById, type Vehicle, type VehicleId } from './vehicles';
import { World } from './world';

/** How close (metres) the courier has to get to a pickup/drop point. */
export const ARRIVE_RADIUS = 12;
const STAR_HISTORY = 20;
/** Dash («рывок»): duration, cooldown and speed multiplier. */
export const DASH_TIME = 0.45;
export const DASH_COOLDOWN = 3.5;
const DASH_BOOST = 1.7;
const HIT_STUN = 1.2;
const CAUGHT_STUN = 3;

export interface ActiveOrder extends Offer {
  stage: 'toPickup' | 'toDrop';
  timeLimit: number;
  timeLeft: number;
}

export type GameEvent =
  | { type: 'accepted'; order: ActiveOrder }
  | { type: 'pickedUp'; order: ActiveOrder }
  | { type: 'delivered'; order: ActiveOrder; result: DeliveryResult; streak: number }
  | { type: 'cancelled'; order: ActiveOrder }
  | { type: 'offers' }
  | { type: 'vehicle'; vehicle: Vehicle; bought: boolean }
  | { type: 'dash' }
  | { type: 'bell' }
  /** Street incident; `amount` is the money actually taken (fines) or given (bonuses). */
  | { type: 'street'; event: StreetEvent; amount: number };

export interface GameOptions {
  rng?: Rng;
  store?: KeyValueStore | null;
}

export class Game {
  readonly world: World;
  readonly courier: Courier;
  readonly board: OrderBoard;
  readonly profile: Profile;
  readonly street: StreetLife;
  active: ActiveOrder | null = null;
  /** Seconds left of the current dash, and until the next one is available. */
  dashTime = 0;
  dashCooldown = 0;
  streak = 0;
  time = 0;
  private field: DistanceField | null = null;
  private readonly saveSlot: SaveSlot;
  private readonly listeners: ((e: GameEvent) => void)[] = [];
  private offerTimer = 0;
  private savedDistance = 0;
  /** routeStart() result, reused while the courier stays put and the target is the same. */
  private startCache = { x: NaN, y: NaN, target: -1, node: -1 };

  constructor(
    readonly map: GameMapData,
    mapId: string,
    opts: GameOptions = {},
  ) {
    this.world = new World(map);
    this.saveSlot = new SaveSlot(`courier:${mapId}:v1`, opts.store);
    this.profile = this.saveSlot.load();
    this.savedDistance = this.profile.distance;
    const spot = this.world.findFreeSpot(map.spawn.x, map.spawn.y, COURIER_RADIUS);
    this.courier = createCourier(spot.x, spot.y);
    this.board = new OrderBoard(this.world, buildPickups(this.world), buildDrops(this.world), opts.rng);
    this.street = new StreetLife(this.world, this.board.pickups, opts.rng);
    this.street.on((e) => this.onStreet(e));
  }

  on(fn: (e: GameEvent) => void): void {
    this.listeners.push(fn);
  }

  private emit(e: GameEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  get vehicle(): Vehicle {
    return vehicleById(this.profile.vehicle);
  }

  update(dt: number, input: MoveInput): void {
    this.time += dt;
    const c = this.courier;
    if (c.stun > 0) {
      c.stun = Math.max(0, c.stun - dt);
      input = { x: 0, y: 0 };
    }
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    let boost = 1;
    if (this.dashTime > 0) {
      this.dashTime = Math.max(0, this.dashTime - dt);
      boost = DASH_BOOST;
    }
    updateCourier(c, input, this.vehicle, this.world, dt, boost);
    this.profile.distance = this.savedDistance + c.odometer;
    this.street.update(dt, c, this.vehicle, () => this.route()?.points ?? null);

    if (!this.active) {
      this.offerTimer -= dt;
      if (this.offerTimer <= 0) {
        this.offerTimer = 1;
        if (this.board.refresh(this.time, c.x, c.y, this.vehicle)) this.emit({ type: 'offers' });
      }
      return;
    }

    const order = this.active;
    order.timeLeft -= dt;
    const target = order.stage === 'toPickup' ? order.pickup : order.drop;
    if (Math.hypot(target.x - c.x, target.y - c.y) <= ARRIVE_RADIUS) {
      if (order.stage === 'toPickup') {
        order.stage = 'toDrop';
        this.field = this.world.graph.distanceField(order.drop.node);
        this.emit({ type: 'pickedUp', order });
      } else {
        this.deliver(order);
      }
    }
  }

  private deliver(order: ActiveOrder): void {
    const result = settleDelivery(order.pay, order.timeLeft, order.timeLimit, this.streak);
    this.streak = result.late ? 0 : this.streak + 1;
    const p = this.profile;
    const total = result.base + result.tip + result.bonus;
    p.money += total;
    p.earned += total;
    p.deliveries++;
    p.bestStreak = Math.max(p.bestStreak, this.streak);
    this.pushStars(result.stars);
    this.active = null;
    this.field = null;
    this.offerTimer = 0;
    this.persist();
    this.emit({ type: 'delivered', order, result, streak: this.streak });
  }

  private pushStars(stars: number): void {
    this.profile.stars.push(stars);
    if (this.profile.stars.length > STAR_HISTORY) this.profile.stars.splice(0, this.profile.stars.length - STAR_HISTORY);
  }

  accept(offerId: number): boolean {
    if (this.active) return false;
    const offer = this.board.take(offerId);
    if (!offer) return false;
    const g = this.world.graph;
    const from = g.nearestNode(this.courier.x, this.courier.y, 3000);
    const toPickup = g.shortestPath(from, offer.pickup.node)?.length ?? Math.hypot(offer.pickup.x - this.courier.x, offer.pickup.y - this.courier.y) * 1.4;
    const timeLimit = timeLimitFor(toPickup + offer.routeLength, this.vehicle);
    this.active = { ...offer, stage: 'toPickup', timeLimit, timeLeft: timeLimit };
    this.field = g.distanceField(offer.pickup.node);
    this.board.clear();
    this.emit({ type: 'accepted', order: this.active });
    return true;
  }

  cancel(): void {
    const order = this.active;
    if (!order) return;
    this.active = null;
    this.field = null;
    this.streak = 0;
    this.pushStars(1);
    this.offerTimer = 0;
    this.persist();
    this.emit({ type: 'cancelled', order });
  }

  /** Buys (if needed and affordable) and switches to a vehicle. */
  chooseVehicle(id: VehicleId): boolean {
    const v = VEHICLES.find((x) => x.id === id);
    if (!v) return false;
    const p = this.profile;
    let bought = false;
    if (!p.owned.includes(id)) {
      if (p.money < v.price) return false;
      p.money -= v.price;
      p.owned.push(id);
      bought = true;
    }
    p.vehicle = id;
    // Offers depend on the vehicle (order distances): fetch new ones.
    if (!this.active) {
      this.board.clear();
      this.offerTimer = 0;
    }
    this.persist();
    this.emit({ type: 'vehicle', vehicle: v, bought });
    return true;
  }

  /** «Рывок»: a short burst of speed to dodge a jumper or break away from the police. */
  dash(): boolean {
    if (this.dashCooldown > 0 || this.courier.stun > 0) return false;
    this.dashTime = DASH_TIME;
    this.dashCooldown = DASH_COOLDOWN;
    this.emit({ type: 'dash' });
    return true;
  }

  /** Bell / horn: ordinary pedestrians step aside (jumpers do not). */
  ring(): boolean {
    if (!this.street.ring(this.courier)) return false;
    this.emit({ type: 'bell' });
    return true;
  }

  private onStreet(e: StreetEvent): void {
    const p = this.profile;
    const c = this.courier;
    let amount = 0;
    switch (e.type) {
      case 'hit':
        amount = Math.min(p.money, e.fine);
        p.money -= amount;
        p.hits++;
        c.stun = HIT_STUN;
        c.vx *= -0.3;
        c.vy *= -0.3;
        this.streak = 0;
        break;
      case 'caught':
        amount = Math.min(p.money, e.fine);
        p.money -= amount;
        p.caught++;
        c.stun = CAUGHT_STUN;
        c.vx = 0;
        c.vy = 0;
        this.dashTime = 0;
        break;
      case 'dodge':
        amount = e.bonus;
        p.money += amount;
        p.earned += amount;
        p.dodges++;
        break;
      case 'escaped':
        amount = e.bonus;
        p.money += amount;
        p.earned += amount;
        p.escapes++;
        break;
    }
    if (e.type === 'hit' || e.type === 'caught') this.persist();
    this.emit({ type: 'street', event: e, amount });
  }

  /** Teleports the courier to the nearest free spot on a road (if stuck somewhere). */
  unstuck(): void {
    const c = this.courier;
    const spot = this.world.findFreeSpot(c.x, c.y, COURIER_RADIUS);
    c.x = spot.x;
    c.y = spot.y;
    c.vx = 0;
    c.vy = 0;
  }

  target(): Place | null {
    if (!this.active) return null;
    return this.active.stage === 'toPickup' ? this.active.pickup : this.active.drop;
  }

  /** Navigation route from the courier to the current target along roads, with its length. */
  route(): { points: FlatCoords; length: number; startNode: number } | null {
    const target = this.target();
    if (!target || !this.field) return null;
    const g = this.world.graph;
    const c = this.courier;
    // Final approach: straight to the door when it is close and nothing is in the way.
    const direct = Math.hypot(target.x - c.x, target.y - c.y);
    if (direct < 80 && this.world.clearLine(c.x, c.y, target.x, target.y, COURIER_RADIUS)) {
      return { points: [c.x, c.y, target.x, target.y], length: direct, startNode: -1 };
    }
    const start = this.routeStart(this.field);
    const nodes = g.pathFromField(this.field, start);
    const points: FlatCoords = [c.x, c.y];
    for (const n of nodes) points.push(g.xs[n], g.ys[n]);
    points.push(target.x, target.y);
    let length = 0;
    for (let i = 0; i + 3 < points.length; i += 2) length += Math.hypot(points[i + 2] - points[i], points[i + 3] - points[i + 1]);
    return { points, length, startNode: start };
  }

  /**
   * Where the route joins the road network: the node with the shortest total way to the target
   * (straight line to it + road distance from it) among the nodes the courier can actually reach in a
   * straight line. The nearest node may be behind the courier, or behind a wall when the courier
   * stands in a yard by a door.
   */
  private routeStart(field: DistanceField): number {
    const g = this.world.graph;
    const c = this.courier;
    const cache = this.startCache;
    if (cache.target === field.target && Math.hypot(cache.x - c.x, cache.y - c.y) < 1.5) return cache.node;

    const nearest = g.nearestNode(c.x, c.y, 3000);
    const hit = this.world.roadAt(c.x, c.y, 8);
    let best: number | undefined;
    let fallback = nearest;
    // Look close first; a door can be up to ~150 m from its road node, so widen once if needed.
    for (const radius of [60, 160]) {
      const candidates = new Set<number>(g.nodesWithin(c.x, c.y, radius));
      if (hit) candidates.add(this.world.segA[hit.segment]).add(this.world.segB[hit.segment]);
      if (nearest >= 0) candidates.add(nearest);
      const scored = [...candidates]
        .filter((n) => Number.isFinite(field.cost[n]))
        .map((n) => ({ n, score: Math.hypot(g.xs[n] - c.x, g.ys[n] - c.y) + field.cost[n] }))
        .sort((a, b) => a.score - b.score);
      if (scored.length && fallback === nearest) fallback = scored[0].n;
      // The best candidate the courier can reach directly; checked lazily, usually the first one is.
      best = scored.find((s) => this.world.clearLine(c.x, c.y, g.xs[s.n], g.ys[s.n], COURIER_RADIUS))?.n;
      if (best !== undefined) break;
    }
    best ??= fallback;
    this.startCache = { x: c.x, y: c.y, target: field.target, node: best };
    return best;
  }

  persist(): void {
    this.savedDistance = this.profile.distance;
    this.courier.odometer = 0;
    this.saveSlot.save(this.profile);
  }
}
