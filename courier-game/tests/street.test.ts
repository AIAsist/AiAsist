import { describe, expect, it } from 'vitest';
import { ROAD_CLASSES } from '../src/data/mapFormat';
import { convertOsm } from '../src/osm/convert';
import { createCourier, type Courier } from '../src/world/courier';
import { Game } from '../src/world/game';
import { StreetLife, type StreetEvent } from '../src/world/street';
import { vehicleById } from '../src/world/vehicles';
import { World } from '../src/world/world';
import { buildTestTown } from './fixtures/testTown';

const town = buildTestTown();
const { map } = convertOsm(town.elements, { name: 'Тестоград', bbox: town.bbox });
const world = new World(map);
const bike = vehicleById('bike');
const DT = 1 / 60;

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A street with nothing spawning on its own: the test places everybody by hand. */
function quietStreet(): { street: StreetLife; events: StreetEvent[] } {
  const street = new StreetLife(world, [], seeded(3));
  street.crowd = false;
  street.police = false;
  const events: StreetEvent[] = [];
  street.on((e) => events.push(e));
  return { street, events };
}

/** Moves the courier in a straight line (no physics) and steps the street. */
function drive(street: StreetLife, c: Courier, seconds: number, each?: () => void): void {
  for (let t = 0; t < seconds; t += DT) {
    c.x += c.vx * DT;
    c.y += c.vy * DT;
    street.update(DT, c, bike, () => null);
    each?.();
  }
}

describe('pedestrians', () => {
  it('populate the streets around the courier and leave when it goes away', () => {
    const street = new StreetLife(world, [{ x: 0, y: 0 }], seeded(1));
    street.police = false;
    const c = createCourier(0, 0);
    drive(street, c, 15);
    expect(street.pedestrians.length).toBeGreaterThanOrEqual(6);
    for (const p of street.pedestrians) expect(Math.hypot(p.x, p.y)).toBeLessThan(200);
    c.x = 700;
    c.y = -800;
    drive(street, c, 0.5);
    for (const p of street.pedestrians) expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeLessThan(200);
  });

  it('a jumper sees the courier coming, shows «!», runs under the wheels and claims a fine', () => {
    const { street, events } = quietStreet();
    const c = createCourier(100, 0);
    c.vx = 10;
    const p = street.addPedestrian(150, 0, true)!;
    const states = new Set<string>();
    drive(street, c, 5, () => states.add(p.state));
    expect([...states]).toEqual(expect.arrayContaining(['walk', 'notice', 'dash', 'down']));
    expect(events.filter((e) => e.type === 'hit')).toEqual([{ type: 'hit', jumper: true, fine: 150 }]);
    expect(street.heat).toBe(1);
  });

  it('braking in time saves the courier and counts as a dodge', () => {
    const { street, events } = quietStreet();
    const c = createCourier(100, 0);
    c.vx = 10;
    const p = street.addPedestrian(150, 0, true)!;
    // Keep going until the jumper actually leaps, then brake hard.
    drive(street, c, 5, () => {
      if (p.state === 'dash' && Math.hypot(p.x - c.x, p.y - c.y) < 12) c.vx = Math.max(0, c.vx - 40 * DT);
    });
    expect(events.some((e) => e.type === 'hit')).toBe(false);
    expect(events).toContainEqual({ type: 'dodge', bonus: 15 });
    expect(street.heat).toBe(0);
  });

  it('the bell moves ordinary people aside, but jumpers ignore it', () => {
    const { street } = quietStreet();
    const c = createCourier(100, 0);
    const walker = street.addPedestrian(110, 0, false)!;
    const jumper = street.addPedestrian(100, 50, true)!;
    expect(street.ring(c)).toBe(true);
    expect(walker.state).toBe('aside');
    expect(jumper.state).toBe('walk');
    expect(street.ring(c)).toBe(false); // cooldown
  });
});

describe('police', () => {
  it('an officer on the way whistles, chases and catches: fine, stop, wanted level cleared', () => {
    const game = new Game(map, 'police', { rng: seeded(5) });
    game.street.crowd = false;
    const events: string[] = [];
    game.on((e) => e.type === 'street' && events.push(e.event.type));
    game.profile.money = 1000;
    game.street.heat = 1;
    const c = game.courier;
    game.street.addOfficer(c.x + 15, c.y);
    let stunned = 0;
    for (let t = 0; t < 6; t += DT) {
      game.update(DT, { x: 0, y: 0 });
      stunned = Math.max(stunned, c.stun);
    }
    expect(events.slice(0, 2)).toEqual(['whistle', 'caught']);
    expect(game.profile.money).toBe(1000 - 300); // 150 × (1 + wanted level)
    expect(game.profile.caught).toBe(1);
    expect(stunned).toBeGreaterThan(2);
    expect(game.street.heat).toBe(0);
    expect(game.street.immunity).toBeGreaterThan(8);
  });

  it('a fast courier gets away from an officer on foot', () => {
    const { street, events } = quietStreet();
    const c = createCourier(-300, 0);
    c.vx = -17;
    street.addOfficer(-285, 0);
    drive(street, c, 15);
    expect(events.map((e) => e.type)).toEqual(['whistle', 'escaped']);
  });

  it('at wanted level 2 a police car chases along the roads and catches a courier that stays put', () => {
    const { street, events } = quietStreet();
    street.police = true;
    street.heat = 2;
    const c = createCourier(100, 200);
    let onRoads = 0;
    let samples = 0;
    for (let t = 0; t < 60 && !events.some((e) => e.type === 'caught'); t += DT) {
      street.update(DT, c, bike, () => null);
      const car = street.car;
      if (car && Math.round(t / DT) % 30 === 0 && Math.hypot(car.x - c.x, car.y - c.y) > 30) {
        samples++;
        const hit = world.roadAt(car.x, car.y, 3);
        if (hit && ROAD_CLASSES[map.roads[world.segRoad[hit.segment]].c] !== 'path') onRoads++;
      }
    }
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('carChase');
    expect(types).toContain('caught');
    expect(samples).toBeGreaterThan(3);
    expect(onRoads / samples).toBeGreaterThan(0.8);
  });

  it('the wanted level cools down when nothing happens', () => {
    const { street, events } = quietStreet();
    street.heat = 1;
    drive(street, createCourier(100, 0), 42);
    expect(street.heat).toBe(0);
    expect(events).toContainEqual({ type: 'heat', level: 0 });
  });
});

describe('dash', () => {
  it('gives a short burst of speed with a cooldown', () => {
    const game = new Game(map, 'dash', { rng: seeded(9) });
    game.street.crowd = false;
    game.street.police = false;
    game.courier.x = -300;
    game.courier.y = 0;
    for (let t = 0; t < 2; t += DT) game.update(DT, { x: -1, y: 0 });
    const cruise = Math.hypot(game.courier.vx, game.courier.vy);
    expect(game.dash()).toBe(true);
    expect(game.dash()).toBe(false);
    let top = 0;
    for (let t = 0; t < 0.5; t += DT) {
      game.update(DT, { x: -1, y: 0 });
      top = Math.max(top, Math.hypot(game.courier.vx, game.courier.vy));
    }
    expect(top).toBeGreaterThan(cruise * 1.4);
    for (let t = 0; t < 3.5; t += DT) game.update(DT, { x: -1, y: 0 });
    expect(game.dash()).toBe(true);
  });
});
