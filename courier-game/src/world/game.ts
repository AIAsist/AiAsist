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
import { VEHICLES, vehicleById, type Vehicle, type VehicleId } from './vehicles';
import { World } from './world';

/** How close (metres) the courier has to get to a pickup/drop point. */
export const ARRIVE_RADIUS = 12;
const STAR_HISTORY = 20;

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
  | { type: 'vehicle'; vehicle: Vehicle; bought: boolean };

export interface GameOptions {
  rng?: Rng;
  store?: KeyValueStore | null;
}

export class Game {
  readonly world: World;
  readonly courier: Courier;
  readonly board: OrderBoard;
  readonly profile: Profile;
  active: ActiveOrder | null = null;
  streak = 0;
  time = 0;
  private field: DistanceField | null = null;
  private readonly saveSlot: SaveSlot;
  private readonly listeners: ((e: GameEvent) => void)[] = [];
  private offerTimer = 0;
  private savedDistance = 0;

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
    updateCourier(c, input, this.vehicle, this.world, dt);
    this.profile.distance = this.savedDistance + c.odometer;

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
    const start = g.nearestNode(c.x, c.y, 3000);
    const nodes = g.pathFromField(this.field, start);
    const points: FlatCoords = [c.x, c.y];
    for (const n of nodes) points.push(g.xs[n], g.ys[n]);
    points.push(target.x, target.y);
    let length = 0;
    for (let i = 0; i + 3 < points.length; i += 2) length += Math.hypot(points[i + 2] - points[i], points[i + 3] - points[i + 1]);
    return { points, length, startNode: start };
  }

  persist(): void {
    this.savedDistance = this.profile.distance;
    this.courier.odometer = 0;
    this.saveSlot.save(this.profile);
  }
}
