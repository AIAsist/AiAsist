import { describe, expect, it } from 'vitest';
import { POI_KINDS } from '../src/data/mapFormat';
import { convertOsm } from '../src/osm/convert';
import { updateCourier, createCourier } from '../src/world/courier';
import { Game, ARRIVE_RADIUS } from '../src/world/game';
import { pointInPolygon } from '../src/world/geometry';
import { priceFor, settleDelivery } from '../src/world/orders';
import { vehicleById } from '../src/world/vehicles';
import { RoadGraph } from '../src/world/graph';
import { World } from '../src/world/world';
import { buildTestTown } from './fixtures/testTown';

const town = buildTestTown();
const { map, stats, warnings } = convertOsm(town.elements, { name: 'Тестоград', bbox: town.bbox });

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class MemoryStore {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

describe('OSM conversion (test town)', () => {
  it('extracts every layer', () => {
    expect(warnings).toEqual([]);
    expect(stats.roads).toBeGreaterThan(100);
    expect(stats.buildings).toBeGreaterThan(400);
    expect(stats.seaPolygons).toBe(1);
    expect(stats.rails).toBe(1);
    expect(map.roads.filter((r) => r.b).length).toBe(9);
    expect(map.names).toContain('пр. Главный');
  });

  it('builds the sea west of the coastline, with the island as a hole', () => {
    const sea = map.water.find((w) => w.sea)!;
    expect(sea.r).toHaveLength(2);
    expect(pointInPolygon(-1100, -800, sea.r)).toBe(true);
    expect(pointInPolygon(0, 0, sea.r)).toBe(false);
    expect(pointInPolygon(-1060, 300, sea.r)).toBe(false); // island
  });

  it('keeps building heights, courtyards, pickups and addresses', () => {
    expect(map.buildings.some((b) => b.r.length === 2 && b.h === 20)).toBe(true);
    expect(map.buildings.some((b) => b.h === 17)).toBe(true); // 5 levels
    const names = map.pois.map((p) => p.name);
    expect(names).toContain('Универсам «Тест»');
    expect(names).toContain('Цветы'); // unnamed florist gets a label
    expect(names).not.toContain('Автосервис');
    expect(map.pois.find((p) => p.name === 'Пицца «Тест»')!.k).toBe(POI_KINDS.indexOf('pizza'));
    expect(map.addresses.length).toBeGreaterThan(400);
    expect(map.spawn).toEqual({ x: 1100, y: 100 }); // the railway station
  });
});

describe('world queries', () => {
  const world = new World(map);

  it('knows water, bridges and buildings', () => {
    expect(world.inWater(-1100, -800)).toBe(true); // sea
    expect(world.inWater(650, 550)).toBe(true); // lake
    expect(world.inWater(0, 100)).toBe(false);
    // River crossing on a bridge vs swimming next to it.
    expect(world.isBlocked(-100, -505, 0.9)).toBe(false);
    expect(world.isBlocked(-150, -505, 0.9)).toBe(true);
    // A house south of «пр. Главный» around x = -65, y = -22.
    expect(world.inBuilding(-65, -22)).toBe(true);
    expect(world.isBlocked(-65, -22, 0.9)).toBe(true);
    expect(world.streetNameAt(0, 2)).toBe('пр. Главный');
  });

  it('routes along the street grid', () => {
    const g = world.graph;
    const a = g.nearestNode(-500, -200);
    const b = g.nearestNode(300, 400);
    const path = g.shortestPath(a, b)!;
    expect(path.length).toBeCloseTo(800 + 600, 0);
    const field = g.distanceField(b);
    const viaField = g.pathFromField(field, a);
    expect(viaField[viaField.length - 1]).toBe(b);
    expect(g.pathLength(viaField)).toBeCloseTo(path.length, 0);
    // Bounded search gives up on routes that are too long; reused buffers stay consistent.
    expect(g.shortestPath(a, b, 1000)).toBeNull();
    expect(g.shortestPath(a, b, 1500)!.length).toBeCloseTo(path.length, 0);
    expect(g.shortestPath(b, a)!.length).toBeCloseTo(path.length, 0);
  });

  it('stays fast on a town-sized graph', () => {
    // 250 × 250 street grid, 20 m blocks: ~62k nodes, more than Sestroretsk has.
    const n = 250;
    const nodes: number[] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) nodes.push(i * 20, j * 20);
    const roads = [];
    for (let j = 0; j < n; j++) roads.push({ c: 2, n: -1, i: Array.from({ length: n }, (_, i) => j * n + i) });
    for (let i = 0; i < n; i++) roads.push({ c: 2, n: -1, i: Array.from({ length: n }, (_, j) => j * n + i) });
    const g = new RoadGraph(nodes, roads, { minX: 0, minY: 0, maxX: 5000, maxY: 5000 });
    const t0 = performance.now();
    for (let k = 0; k < 200; k++) {
      const from = (k * 7919) % (n * n);
      const to = (k * 104729) % (n * n);
      g.shortestPath(from, to, 3000);
    }
    g.distanceField(0);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('courier movement', () => {
  const world = new World(map);

  it('accelerates along a road and stops at buildings', () => {
    const bike = vehicleById('bike');
    const c = createCourier(-300, 0);
    for (let i = 0; i < 120; i++) updateCourier(c, { x: 1, y: 0 }, bike, world, 1 / 60);
    expect(Math.hypot(c.vx, c.vy)).toBeCloseTo(bike.maxSpeed, 1);
    // Push south into the row of apartment houses: the courier must stay out of them.
    const d = createCourier(-65, -10);
    for (let i = 0; i < 240; i++) updateCourier(d, { x: 0, y: -1 }, bike, world, 1 / 60);
    expect(world.inBuilding(d.x, d.y)).toBe(false);
    expect(d.y).toBeGreaterThan(-16);
  });

  it('cannot swim', () => {
    const foot = vehicleById('foot');
    const c = createCourier(-820, 100); // on the coastal side, heading west into the sea
    for (let i = 0; i < 600; i++) updateCourier(c, { x: -1, y: 0 }, foot, world, 1 / 60);
    expect(world.inWater(c.x, c.y)).toBe(false);
  });
});

describe('orders and game loop', () => {
  it('prices and settles deliveries', () => {
    expect(priceFor(1000)).toBe(100);
    const onTime = settleDelivery(100, 50, 100, 2);
    expect(onTime).toMatchObject({ base: 100, tip: 20, bonus: 20, stars: 5, late: false });
    const late = settleDelivery(100, -100, 100, 2);
    expect(late.late).toBe(true);
    expect(late.stars).toBe(1);
    expect(late.base).toBe(50);
  });

  it('plays a full order: offers → accept → pick up → deliver → paid and saved', () => {
    const store = new MemoryStore();
    const game = new Game(map, 'test', { rng: seeded(42), store });
    expect(game.board.pickups.length).toBeGreaterThanOrEqual(8);
    expect(game.board.drops.length).toBeGreaterThan(300);
    const events: string[] = [];
    game.on((e) => events.push(e.type));

    game.update(1 / 60, { x: 0, y: 0 });
    expect(game.board.offers.length).toBe(3);
    const offer = game.board.offers[0];
    const [min, max] = game.vehicle.orderRange;
    expect(offer.routeLength).toBeGreaterThanOrEqual(min);
    expect(offer.routeLength).toBeLessThanOrEqual(max);
    expect(game.world.isBlocked(offer.drop.x, offer.drop.y, 0.9)).toBe(false);

    expect(game.accept(offer.id)).toBe(true);
    const route = game.route()!;
    expect(route.length).toBeGreaterThan(0);

    game.courier.x = offer.pickup.x + ARRIVE_RADIUS / 2;
    game.courier.y = offer.pickup.y;
    game.update(1 / 60, { x: 0, y: 0 });
    expect(game.active?.stage).toBe('toDrop');

    game.courier.x = offer.drop.x;
    game.courier.y = offer.drop.y;
    game.update(1 / 60, { x: 0, y: 0 });
    expect(game.active).toBeNull();
    expect(game.profile.money).toBeGreaterThanOrEqual(offer.pay);
    expect(game.profile.deliveries).toBe(1);
    expect(events).toEqual(['offers', 'accepted', 'pickedUp', 'delivered']);

    const reloaded = new Game(map, 'test', { rng: seeded(1), store });
    expect(reloaded.profile.money).toBe(game.profile.money);
  });

  it('buys a vehicle only with enough money', () => {
    const game = new Game(map, 'shop', { store: new MemoryStore() });
    expect(game.chooseVehicle('bike')).toBe(false);
    game.profile.money = 2000;
    expect(game.chooseVehicle('bike')).toBe(true);
    expect(game.profile.money).toBe(500);
    expect(game.vehicle.id).toBe('bike');
    expect(game.chooseVehicle('foot')).toBe(true);
    expect(game.chooseVehicle('bike')).toBe(true);
    expect(game.profile.money).toBe(500);
  });
});
