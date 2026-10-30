// Street life that gets in the courier's way, runner style:
//  - pedestrians walk the pavements; some of them are «подставщики» who, when they see the courier
//    coming, wind up for a moment (the «!») and throw themselves under the wheels for compensation;
//  - police officers wait on the route ahead and run after the courier when it passes close by;
//  - hitting people raises the wanted level, and at level 2 a police car chases along the roads.
// Rendering-free, like the rest of src/world: the 2D and the future 3D view just draw this state.

import { ROAD_CLASSES, ROAD_HALF_WIDTH, type FlatCoords } from '../data/mapFormat';
import type { Courier } from './courier';
import type { Rng } from './orders';
import type { Vehicle } from './vehicles';
import type { World } from './world';

/** Courier ↔ pedestrian contact distance, arcade metres (people are drawn larger than life too). */
export const CONTACT_RADIUS = 3;
export const OFFICER_CATCH_RADIUS = 2.6;
/** An officer can grab a courier only if it is not much faster than the officer runs: keep moving! */
export const GRAB_SPEED_MARGIN = 1;
export const CAR_CATCH_RADIUS = 4;
export const MAX_HEAT = 3;

const WALK_SPEED = 1.4;
const ASIDE_SPEED = 4;
const DASH_SPEED = 7.5;
/** The «!» wind-up before a jumper leaps: the player's chance to brake or swerve. */
const NOTICE_TIME = 0.7;
const DASH_TIME = 1.1;
const DOWN_TIME = 2.5;
/** Below this courier speed nobody can be hit: braking is always a way out. */
const HIT_SPEED = 2.5;
const SPAWN_MIN = 60;
const SPAWN_MAX = 135;
const DESPAWN = 190;
const BELL_RADIUS = 20;
/** A jumper's dash that ends this close without a hit counts as a dodge. */
const DODGE_DISTANCE = 10;
const HEAT_DECAY_TIME = 40;
const CAUGHT_IMMUNITY = 20;
/** At most one jumper attempt per this many seconds. */
const JUMPER_COOLDOWN = 6;

export type PedestrianState = 'walk' | 'aside' | 'notice' | 'dash' | 'down';

export interface Pedestrian {
  id: number;
  /** «Подставщик»: looks like everybody else until it notices the courier. */
  jumper: boolean;
  /** A jumper tries only once; an ordinary pedestrian decides once whether to jump out of the way. */
  tried: boolean;
  state: PedestrianState;
  x: number;
  y: number;
  heading: number;
  /** Seconds left in the current state (aside / notice / dash / down). */
  timer: number;
  from: number;
  to: number;
  /** Which side of the road the pedestrian keeps to (+1 left, -1 right of its way). */
  side: number;
  /** Sideways offset from the road centre line: the pavement, beyond the carriageway. */
  offset: number;
  dirX: number;
  dirY: number;
  /** Closest distance to the courier during a dash (a near miss counts as a dodge). */
  closest: number;
  /** Clothes colour index for the renderer. */
  look: number;
}

export type OfficerState = 'post' | 'alert' | 'chase' | 'giveup';

export interface Officer {
  id: number;
  state: OfficerState;
  x: number;
  y: number;
  heading: number;
  timer: number;
  chaseTime: number;
}

export interface PoliceCar {
  id: number;
  x: number;
  y: number;
  heading: number;
  speed: number;
  path: number[];
  pathIdx: number;
  repath: number;
  time: number;
  farTime: number;
}

export type StreetEvent =
  | { type: 'hit'; jumper: boolean; fine: number }
  | { type: 'dodge'; bonus: number }
  | { type: 'whistle' }
  | { type: 'carChase' }
  | { type: 'caught'; fine: number }
  | { type: 'escaped'; bonus: number; car: boolean }
  | { type: 'heat'; level: number };

/** Share of jumpers among pedestrians: faster vehicles attract more of them. */
export function jumperShare(vehicle: Vehicle): number {
  return 0.03 + vehicle.maxSpeed * 0.008;
}

/** How close the police notices the courier: farther when wanted, and fast vehicles draw more attention. */
export function detectRadius(heat: number, vehicleSpeed = 17): number {
  return [20, 30, 38, 44][Math.min(heat, MAX_HEAT)] * Math.min(1, 0.55 + vehicleSpeed / 38);
}

export class StreetLife {
  pedestrians: Pedestrian[] = [];
  officers: Officer[] = [];
  car: PoliceCar | null = null;
  heat = 0;
  /** Switches for new pedestrians / new police (tests, calmer modes). */
  crowd = true;
  police = true;
  /** Seconds the police leaves the courier alone (after a catch). */
  immunity = 0;
  bellCooldown = 0;
  private nextId = 1;
  private spawnTimer = 0;
  private densityTimer = 0;
  private targetCount = 10;
  private officerTimer = 15;
  private quietTime = 0;
  private hitImmunity = 0;
  private jumperCooldown = 0;
  private vehicleSpeed = 17;
  private listeners: ((e: StreetEvent) => void)[] = [];

  constructor(
    private readonly world: World,
    private readonly pois: readonly { x: number; y: number }[],
    private readonly rng: Rng = Math.random,
  ) {}

  on(fn: (e: StreetEvent) => void): void {
    this.listeners.push(fn);
  }

  private emit(e: StreetEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  /** `route` gives the current navigation route (officers wait on it). */
  update(dt: number, c: Courier, vehicle: Vehicle, route: () => FlatCoords | null): void {
    this.vehicleSpeed = vehicle.maxSpeed;
    this.bellCooldown = Math.max(0, this.bellCooldown - dt);
    this.hitImmunity = Math.max(0, this.hitImmunity - dt);
    this.jumperCooldown = Math.max(0, this.jumperCooldown - dt);
    this.immunity = Math.max(0, this.immunity - dt);
    this.updatePopulation(dt, c, vehicle);
    for (const p of this.pedestrians) this.updatePedestrian(p, dt, c);
    this.updateOfficers(dt, c, route);
    this.updateCar(dt, c);
    this.updateHeat(dt);
  }

  // ------------------------------------------------------------------ pedestrians

  private updatePopulation(dt: number, c: Courier, vehicle: Vehicle): void {
    this.densityTimer -= dt;
    if (this.densityTimer <= 0) {
      // Busier near shops and cafés: the town centre and the station are crowded.
      this.densityTimer = 2;
      let near = 0;
      for (const p of this.pois) if ((p.x - c.x) ** 2 + (p.y - c.y) ** 2 < 300 * 300) near++;
      this.targetCount = 6 + Math.min(14, near);
    }
    this.pedestrians = this.pedestrians.filter(
      (p) => p.state === 'notice' || p.state === 'dash' || (p.x - c.x) ** 2 + (p.y - c.y) ** 2 < DESPAWN * DESPAWN,
    );
    this.spawnTimer -= dt;
    if (!this.crowd || this.spawnTimer > 0 || this.pedestrians.length >= this.targetCount) return;
    this.spawnTimer = 0.35;
    const g = this.world.graph;
    const a = this.rng() * Math.PI * 2;
    const r = SPAWN_MIN + this.rng() * (SPAWN_MAX - SPAWN_MIN);
    const node = g.nearestNode(c.x + r * Math.cos(a), c.y + r * Math.sin(a), 30);
    if (node < 0) return;
    const d = Math.hypot(g.xs[node] - c.x, g.ys[node] - c.y);
    if (d < SPAWN_MIN - 15 || d > SPAWN_MAX + 30) return;
    const next = g.neighbors(node);
    if (!next.length) return;
    this.pedestrians.push(
      this.makePedestrian(
        node,
        next[Math.floor(this.rng() * next.length)],
        this.rng() < jumperShare(vehicle),
        this.rng() < 0.5 ? -1 : 1,
        Math.floor(this.rng() * 8),
      ),
    );
  }

  private makePedestrian(node: number, to: number, jumper: boolean, side: number, look: number): Pedestrian {
    const g = this.world.graph;
    return {
      id: this.nextId++,
      jumper,
      tried: false,
      state: 'walk',
      x: g.xs[node],
      y: g.ys[node],
      heading: 0,
      timer: 0,
      from: node,
      to,
      side,
      offset: this.pavementOffset(node, to, side),
      dirX: 0,
      dirY: 0,
      closest: Infinity,
      look,
    };
  }

  private updatePedestrian(p: Pedestrian, dt: number, c: Courier): void {
    const g = this.world.graph;
    const cs = Math.hypot(c.vx, c.vy);
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const dist = Math.hypot(dx, dy);

    switch (p.state) {
      case 'walk': {
        // Follow the road network, on the side of the road.
        const ax = g.xs[p.from];
        const ay = g.ys[p.from];
        const bx = g.xs[p.to];
        const by = g.ys[p.to];
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const tx = bx + ((-(by - ay) / len) * p.offset);
        const ty = by + (((bx - ax) / len) * p.offset);
        const ddx = tx - p.x;
        const ddy = ty - p.y;
        const dd = Math.hypot(ddx, ddy);
        if (dd < 0.6) {
          const next = g.neighbors(p.to).filter((n) => n !== p.from);
          const options = next.length ? next : [p.from];
          p.from = p.to;
          p.to = options[Math.floor(this.rng() * options.length)];
          p.offset = this.pavementOffset(p.from, p.to, p.side);
        } else {
          const step = Math.min(dd, WALK_SPEED * dt);
          p.x += (ddx / dd) * step;
          p.y += (ddy / dd) * step;
          p.heading = Math.atan2(ddy, ddx);
        }
        if (!p.tried && cs > 3 && dist > 4) {
          const cos = (c.vx * dx + c.vy * dy) / (cs * dist);
          // Faster couriers are spotted from farther away, so the warning comes early enough to react.
          if (p.jumper && dist < 15 + cs * 0.9 && cos > 0.7 && this.jumperCooldown <= 0) {
            // A jumper spots a courier coming at it fast, roughly head-on.
            p.state = 'notice';
            p.timer = NOTICE_TIME;
            p.tried = true;
            this.jumperCooldown = JUMPER_COOLDOWN;
          } else if (!p.jumper && dist < 9 && cos > 0.8) {
            // Half of the people jump out of the way by themselves; the bell makes everyone do it.
            p.tried = true;
            if (this.rng() < 0.5) this.stepAside(p, c);
          }
        }
        break;
      }
      case 'aside':
        p.x += p.dirX * ASIDE_SPEED * dt;
        p.y += p.dirY * ASIDE_SPEED * dt;
        p.heading = Math.atan2(p.dirY, p.dirX);
        p.timer -= dt;
        if (p.timer <= 0) p.state = 'walk';
        break;
      case 'notice':
        p.heading = Math.atan2(-dy, -dx);
        p.timer -= dt;
        if (p.timer <= 0) {
          // Run to where the courier is about to be.
          const tx = c.x + c.vx * 0.6 - p.x;
          const ty = c.y + c.vy * 0.6 - p.y;
          const m = Math.hypot(tx, ty) || 1;
          p.dirX = tx / m;
          p.dirY = ty / m;
          p.state = 'dash';
          p.timer = DASH_TIME;
          p.closest = dist;
        }
        break;
      case 'dash':
        p.x += p.dirX * DASH_SPEED * dt;
        p.y += p.dirY * DASH_SPEED * dt;
        p.heading = Math.atan2(p.dirY, p.dirX);
        p.closest = Math.min(p.closest, dist);
        p.timer -= dt;
        if (p.timer <= 0) {
          if (p.closest < DODGE_DISTANCE) this.emit({ type: 'dodge', bonus: 15 });
          // Missed: the scam is off. The jumper gets out of the way and is just a passer-by now.
          p.jumper = false;
          this.stepAside(p, c);
        }
        break;
      case 'down':
        p.timer -= dt;
        if (p.timer <= 0) this.backToWalking(p);
        break;
    }

    // People getting out of the way or lying on the ground cannot be hit.
    const hittable = p.state === 'walk' || p.state === 'notice' || p.state === 'dash';
    if (hittable && this.hitImmunity <= 0 && cs > HIT_SPEED && dist < CONTACT_RADIUS) {
      p.state = 'down';
      p.timer = DOWN_TIME;
      this.hitImmunity = 2;
      this.raiseHeat();
      this.emit({ type: 'hit', jumper: p.jumper, fine: p.jumper ? 150 : 100 });
    }
  }

  /** Puts a pedestrian at the road node nearest to (x, y). */
  addPedestrian(x: number, y: number, jumper: boolean): Pedestrian | null {
    const g = this.world.graph;
    const node = g.nearestNode(x, y, 60);
    if (node < 0) return null;
    const next = g.neighbors(node);
    const p = this.makePedestrian(node, next.length ? next[0] : node, jumper, 1, 0);
    p.offset = 0; // tests put people right on the centre line
    this.pedestrians.push(p);
    return p;
  }

  /** Puts a police officer on post at (x, y). */
  addOfficer(x: number, y: number): Officer {
    const o: Officer = { id: this.nextId++, state: 'post', x, y, heading: 0, timer: 0, chaseTime: 0 };
    this.officers.push(o);
    return o;
  }

  /** Pedestrians keep to the pavement: just beyond the carriageway of streets, on footpaths themselves. */
  private pavementOffset(a: number, b: number, side: number): number {
    const cls = ROAD_CLASSES[this.world.graph.edgeClass(a, b)];
    if (!cls || cls === 'path') return side * 0.6;
    return side * (ROAD_HALF_WIDTH[cls] + 1.2);
  }

  private backToWalking(p: Pedestrian): void {
    const node = this.world.graph.nearestNode(p.x, p.y, 80);
    p.state = 'walk';
    if (node >= 0) {
      p.from = node;
      p.to = node;
      p.offset = 0;
    }
  }

  /** Bell / horn: ordinary people step aside; jumpers ignore it, which gives them away. */
  ring(c: Courier): boolean {
    if (this.bellCooldown > 0) return false;
    this.bellCooldown = 1.2;
    for (const p of this.pedestrians) {
      if (p.jumper || p.state !== 'walk') continue;
      if ((p.x - c.x) ** 2 + (p.y - c.y) ** 2 <= BELL_RADIUS * BELL_RADIUS) this.stepAside(p, c);
    }
    return true;
  }

  /** Step sideways, away from the courier's line of travel. */
  private stepAside(p: Pedestrian, c: Courier): void {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const cs = Math.hypot(c.vx, c.vy);
    let nx = cs > 0.5 ? -c.vy / cs : -dy;
    let ny = cs > 0.5 ? c.vx / cs : dx;
    if (nx * dx + ny * dy < 0) {
      nx = -nx;
      ny = -ny;
    }
    const m = Math.hypot(nx, ny) || 1;
    p.dirX = nx / m;
    p.dirY = ny / m;
    p.state = 'aside';
    p.timer = 1.2;
  }

  // ------------------------------------------------------------------ police on foot

  private updateOfficers(dt: number, c: Courier, route: () => FlatCoords | null): void {
    this.officerTimer -= dt;
    if (this.police && this.officerTimer <= 0 && this.immunity <= 0 && this.officers.length < 1 + this.heat) {
      this.officerTimer = (this.heat > 0 ? 18 : 40) + this.rng() * 15;
      this.spawnOfficer(c, route());
    }
    for (const o of this.officers) this.updateOfficer(o, dt, c);
    this.officers = this.officers.filter(
      (o) => !(o.state === 'giveup' && o.timer <= 0) && Math.hypot(o.x - c.x, o.y - c.y) < 260,
    );
  }

  /** Police wait on the route ahead: «на пути». */
  private spawnOfficer(c: Courier, route: FlatCoords | null): void {
    const want = 90 + this.rng() * 90;
    let px = NaN;
    let py = NaN;
    if (route && route.length >= 4) {
      let along = 0;
      for (let i = 2; i < route.length; i += 2) {
        along += Math.hypot(route[i] - route[i - 2], route[i + 1] - route[i - 1]);
        if (along >= want) {
          px = route[i];
          py = route[i + 1];
          break;
        }
      }
    }
    if (Number.isNaN(px)) {
      const cs = Math.hypot(c.vx, c.vy);
      const a = cs > 0.5 ? Math.atan2(c.vy, c.vx) + (this.rng() - 0.5) : this.rng() * Math.PI * 2;
      px = c.x + Math.cos(a) * want;
      py = c.y + Math.sin(a) * want;
    }
    // On the pavement next to the route, not in the middle of it: a courier at full speed gets past.
    const g = this.world.graph;
    const node = g.nearestNode(px, py, 50);
    if (node < 0) return;
    const next = g.neighbors(node);
    const to = next.length ? next[Math.floor(this.rng() * next.length)] : node;
    const len = Math.hypot(g.xs[to] - g.xs[node], g.ys[to] - g.ys[node]) || 1;
    const nx = -(g.ys[to] - g.ys[node]) / len;
    const ny = (g.xs[to] - g.xs[node]) / len;
    const first = this.rng() < 0.5 ? -1 : 1;
    let x = g.xs[node];
    let y = g.ys[node];
    for (const side of [first, -first]) {
      const off = Math.abs(this.pavementOffset(node, to, side)) + 0.5;
      if (!this.world.isBlocked(x + nx * off * side, y + ny * off * side, 0.6)) {
        x += nx * off * side;
        y += ny * off * side;
        break;
      }
    }
    this.officers.push({ id: this.nextId++, state: 'post', x, y, heading: 0, timer: 0, chaseTime: 0 });
  }

  private updateOfficer(o: Officer, dt: number, c: Courier): void {
    const dx = c.x - o.x;
    const dy = c.y - o.y;
    const dist = Math.hypot(dx, dy);
    switch (o.state) {
      case 'post':
        if (this.immunity <= 0 && dist < detectRadius(this.heat, this.vehicleSpeed)) {
          o.state = 'alert';
          o.timer = 0.6;
          o.heading = Math.atan2(dy, dx);
          this.emit({ type: 'whistle' });
        }
        break;
      case 'alert':
        o.heading = Math.atan2(dy, dx);
        o.timer -= dt;
        if (o.timer <= 0) {
          o.state = 'chase';
          o.chaseTime = 0;
        }
        break;
      case 'chase': {
        o.chaseTime += dt;
        const tx = c.x + c.vx * 0.3 - o.x;
        const ty = c.y + c.vy * 0.3 - o.y;
        const m = Math.hypot(tx, ty) || 1;
        const speed = 5.2 + 0.4 * this.heat;
        this.moveBody(o, (tx / m) * speed * dt, (ty / m) * speed * dt, 0.6);
        o.heading = Math.atan2(ty, tx);
        const courierSpeed = Math.hypot(c.vx, c.vy);
        if (this.immunity <= 0 && dist < OFFICER_CATCH_RADIUS && courierSpeed < speed + GRAB_SPEED_MARGIN) {
          this.caught();
        } else if (dist > 40 + 10 * this.heat || o.chaseTime > 7 + 2 * this.heat) {
          // Wanted couriers are chased harder and longer.
          o.state = 'giveup';
          o.timer = 1.5;
          this.emit({ type: 'escaped', bonus: 20, car: false });
        }
        break;
      }
      case 'giveup':
        o.timer -= dt;
        break;
    }
  }

  /** Moves a body with axis-separated sliding along obstacles. */
  private moveBody(b: { x: number; y: number }, dx: number, dy: number, r: number): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.5));
    for (let i = 0; i < steps; i++) {
      const sx = dx / steps;
      const sy = dy / steps;
      if (!this.world.isBlocked(b.x + sx, b.y + sy, r)) {
        b.x += sx;
        b.y += sy;
      } else if (!this.world.isBlocked(b.x + sx, b.y, r)) {
        b.x += sx;
      } else if (!this.world.isBlocked(b.x, b.y + sy, r)) {
        b.y += sy;
      } else {
        break;
      }
    }
  }

  // ------------------------------------------------------------------ police car

  private updateCar(dt: number, c: Courier): void {
    const g = this.world.graph;
    if (!this.car) {
      if (this.police && this.heat >= 2 && this.immunity <= 0) this.spawnCar(c);
      return;
    }
    const car = this.car;
    car.time += dt;
    const dist = Math.hypot(c.x - car.x, c.y - car.y);
    if (this.immunity <= 0 && dist < CAR_CATCH_RADIUS) {
      this.caught();
      return;
    }
    car.farTime = dist > 280 ? car.farTime + dt : 0;
    if (car.farTime > 4 || car.time > 50) {
      this.car = null;
      this.lowerHeat();
      this.emit({ type: 'escaped', bonus: 50, car: true });
      return;
    }

    // Steering target: straight at the courier when close with nothing in between, else the road path.
    let tx: number;
    let ty: number;
    if (dist < 30 && this.world.clearLine(car.x, car.y, c.x, c.y, 1.2)) {
      tx = c.x;
      ty = c.y;
    } else {
      car.repath -= dt;
      if (car.repath <= 0 || car.pathIdx >= car.path.length) {
        car.repath = 0.8;
        const from = g.nearestNode(car.x, car.y, 200, true, true);
        const to = g.nearestNode(c.x, c.y, 200, true, true);
        const path = from >= 0 && to >= 0 ? g.shortestPath(from, to, 1500, true) : null;
        car.path = path ? path.nodes : [];
        car.pathIdx = car.path.length > 1 ? 1 : 0;
      }
      while (car.pathIdx < car.path.length && Math.hypot(g.xs[car.path[car.pathIdx]] - car.x, g.ys[car.path[car.pathIdx]] - car.y) < 2) car.pathIdx++;
      if (car.pathIdx < car.path.length) {
        tx = g.xs[car.path[car.pathIdx]];
        ty = g.ys[car.path[car.pathIdx]];
      } else {
        tx = c.x;
        ty = c.y;
      }
    }
    // Arcade car: limited turn rate, slows down for sharp turns.
    const want = Math.atan2(ty - car.y, tx - car.x);
    let turn = Math.atan2(Math.sin(want - car.heading), Math.cos(want - car.heading));
    const maxTurn = 2.4 * dt;
    turn = Math.max(-maxTurn, Math.min(maxTurn, turn));
    car.heading += turn;
    const offAngle = Math.abs(Math.atan2(Math.sin(want - car.heading), Math.cos(want - car.heading)));
    const top = (12.5 + 1.5 * this.heat) * (1 - Math.min(0.6, offAngle));
    car.speed += Math.max(-12 * dt, Math.min(7 * dt, top - car.speed));
    car.x += Math.cos(car.heading) * car.speed * dt;
    car.y += Math.sin(car.heading) * car.speed * dt;
  }

  private spawnCar(c: Courier): void {
    const g = this.world.graph;
    const cs = Math.hypot(c.vx, c.vy);
    const back = cs > 0.5 ? Math.atan2(-c.vy, -c.vx) : this.rng() * Math.PI * 2;
    for (let i = 0; i < 6; i++) {
      const a = back + (this.rng() - 0.5) * 2;
      const r = 120 + this.rng() * 60;
      const node = g.nearestNode(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, 80, true, true);
      if (node < 0) continue;
      this.car = {
        id: this.nextId++,
        x: g.xs[node],
        y: g.ys[node],
        heading: Math.atan2(c.y - g.ys[node], c.x - g.xs[node]),
        speed: 0,
        path: [],
        pathIdx: 0,
        repath: 0,
        time: 0,
        farTime: 0,
      };
      this.emit({ type: 'carChase' });
      return;
    }
  }

  // ------------------------------------------------------------------ wanted level

  private caught(): void {
    const fine = 150 * (1 + this.heat);
    this.heat = 0;
    this.quietTime = 0;
    this.immunity = CAUGHT_IMMUNITY;
    this.car = null;
    for (const o of this.officers) {
      o.state = 'giveup';
      o.timer = 2;
    }
    this.emit({ type: 'caught', fine });
    this.emit({ type: 'heat', level: 0 });
  }

  private raiseHeat(): void {
    this.quietTime = 0;
    if (this.heat < MAX_HEAT) {
      this.heat++;
      this.emit({ type: 'heat', level: this.heat });
    }
  }

  private lowerHeat(): void {
    this.quietTime = 0;
    if (this.heat > 0) {
      this.heat--;
      this.emit({ type: 'heat', level: this.heat });
    }
  }

  private updateHeat(dt: number): void {
    this.quietTime = this.chased ? 0 : this.quietTime + dt;
    if (this.heat > 0 && this.quietTime > HEAT_DECAY_TIME) this.lowerHeat();
  }

  /** Whether anyone from the police is after the courier right now. */
  get chased(): boolean {
    return this.car !== null || this.officers.some((o) => o.state === 'chase' || o.state === 'alert');
  }
}
