import { describe, expect, it } from 'vitest';
import { buildSea, clipPolyline, mergeChains } from '../src/osm/coastline';
import { shortStreetName } from '../src/osm/names';
import { bboxAround, capBBox, mergeResponses, splitBBox } from '../src/osm/overpass';
import { makeProjection } from '../src/osm/projection';
import { assembleRings, buildPolygons } from '../src/osm/rings';
import { pointInPolygon, polygonArea, ringSignedArea, simplifyLine, simplifyRing } from '../src/world/geometry';

const square = (x0: number, y0: number, s: number) => [x0, y0, x0 + s, y0, x0 + s, y0 + s, x0, y0 + s];

describe('geometry', () => {
  it('signed area is positive for counter-clockwise rings', () => {
    expect(ringSignedArea(square(0, 0, 10))).toBeCloseTo(100);
    expect(ringSignedArea([0, 0, 0, 10, 10, 10, 10, 0])).toBeCloseTo(-100);
  });

  it('point in polygon respects holes', () => {
    const poly = [square(0, 0, 10), square(3, 3, 4)];
    expect(pointInPolygon(1, 1, poly)).toBe(true);
    expect(pointInPolygon(5, 5, poly)).toBe(false);
    expect(pointInPolygon(11, 5, poly)).toBe(false);
    expect(polygonArea(poly)).toBeCloseTo(84);
  });

  it('simplifies lines and rings', () => {
    expect(simplifyLine([0, 0, 1, 0.01, 2, 0, 3, 0], 0.1)).toEqual([0, 0, 3, 0]);
    const ring = [0, 0, 5, 0.01, 10, 0, 10, 10, 0, 10];
    expect(simplifyRing(ring, 0.1)!.length).toBe(8);
    expect(simplifyRing([0, 0, 1, 0, 2, 0], 0.1)).toBeNull();
  });
});

describe('projection', () => {
  it('round-trips and measures ~111 km per degree of latitude', () => {
    const p = makeProjection(60, 30);
    const [x, y] = p.toXY(60.01, 30.02);
    expect(y).toBeCloseTo(1113.2, 0);
    expect(x).toBeCloseTo(1113.2, 0); // 0.02° of longitude at 60° ≈ 0.01° of latitude
    const [lat, lon] = p.toLatLon(x, y);
    expect(lat).toBeCloseTo(60.01, 9);
    expect(lon).toBeCloseTo(30.02, 9);
  });

  it('splits the download into tiles and merges duplicates back', () => {
    const b = bboxAround(60.1, 29.96, 4.5); // 9 × 9 km
    const tiles = splitBBox(b, 3);
    expect(tiles).toHaveLength(9);
    expect(tiles[0].south).toBeCloseTo(b.south, 9);
    expect(tiles[8].north).toBeCloseTo(b.north, 9);
    expect(tiles[8].east).toBeCloseTo(b.east, 9);
    expect(splitBBox(bboxAround(60, 30, 1), 3)).toHaveLength(1);
    const way = { type: 'way' as const, id: 7, nodes: [1, 2] };
    const node = { type: 'node' as const, id: 7, lat: 60, lon: 30 };
    const merged = mergeResponses([{ elements: [way, node] }, { elements: [way] }]);
    expect(merged.elements).toHaveLength(2); // same id, different types are different elements
  });

  it('caps a large bbox around the focus point', () => {
    const big = bboxAround(60.1, 29.96, 10);
    const capped = capBBox(big, 9, { lat: 60.12, lon: 29.96 });
    expect((capped.north - capped.south) * 111.32).toBeCloseTo(9, 1);
    expect(capped.north).toBeLessThanOrEqual(big.north + 1e-9);
    expect(capped.south).toBeGreaterThanOrEqual(big.south - 1e-9);
  });
});

describe('ring assembly', () => {
  it('joins pieces (including reversed ones) into rings and nests holes', () => {
    const pieces = [
      [0, 0, 10, 0],
      [10, 10, 10, 0], // reversed
      [10, 10, 0, 10, 0, 0],
    ];
    const { rings, dropped } = assembleRings(pieces);
    expect(dropped).toBe(0);
    expect(rings).toHaveLength(1);
    expect(Math.abs(ringSignedArea(rings[0]))).toBeCloseTo(100);
    const polys = buildPolygons(rings, [[2, 2, 4, 2, 4, 4, 2, 4, 2, 2].slice(0, 8)]);
    expect(polys[0]).toHaveLength(2);
  });

  it('drops pieces that never close', () => {
    expect(assembleRings([[0, 0, 1, 1]]).dropped).toBe(1);
  });
});

describe('coastline', () => {
  const rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  it('merges directed ways and clips them', () => {
    const chains = mergeChains([
      [50, 150, 50, 50],
      [50, 50, 50, -50],
    ]);
    expect(chains).toHaveLength(1);
    expect(clipPolyline(rect, chains[0])).toEqual([[50, 100, 50, 50, 50, 0]]);
  });

  it('puts the sea on the right of the coastline direction', () => {
    // Going south: land on the left (east), sea on the right (west).
    const south = buildSea([[40, 150, 40, -50]], rect);
    expect(south.polygons).toHaveLength(1);
    expect(polygonArea(south.polygons[0])).toBeCloseTo(4000);
    expect(pointInPolygon(10, 50, south.polygons[0])).toBe(true);
    expect(pointInPolygon(80, 50, south.polygons[0])).toBe(false);

    // Going north: the sea is to the east.
    const north = buildSea([[40, -50, 40, 150]], rect);
    expect(polygonArea(north.polygons[0])).toBeCloseTo(6000);
    expect(pointInPolygon(80, 50, north.polygons[0])).toBe(true);
  });

  it('handles a bay entering and leaving through the same side, and islands', () => {
    // Coast comes from the south, makes a bay northwards and goes back south: sea inside the bay?
    // Land on the left: going north along x=30 (land west), across at y=60, south along x=70 (land... east?).
    const bay = buildSea([[30, -10, 30, 60, 70, 60, 70, -10]], rect);
    // Walking north at x=30 the right-hand side (east) is water, so the strip between x=30..70 below y=60 is sea.
    expect(polygonArea(bay.polygons[0])).toBeCloseTo(40 * 60);
    expect(pointInPolygon(50, 30, bay.polygons[0])).toBe(true);

    const withIsland = buildSea(
      [
        [40, 150, 40, -50],
        [10, 40, 20, 40, 20, 50, 10, 50, 10, 40], // counter-clockwise → island
      ],
      rect,
    );
    expect(withIsland.stats.islands).toBe(1);
    expect(polygonArea(withIsland.polygons[0])).toBeCloseTo(4000 - 100);
    expect(pointInPolygon(15, 45, withIsland.polygons[0])).toBe(false);
  });

  it('extends coastline ends that stop inside the map to the border', () => {
    const r = buildSea([[40, 150, 40, 30]], rect);
    expect(r.stats.danglingEnds).toBe(1);
    expect(r.polygons).toHaveLength(1);
  });
});

describe('street names', () => {
  it('abbreviates street types and puts them first', () => {
    expect(shortStreetName('улица Мосина')).toBe('ул. Мосина');
    expect(shortStreetName('Приморское шоссе')).toBe('ш. Приморское');
    expect(shortStreetName('Садовая улица')).toBe('ул. Садовая');
    expect(shortStreetName('Дубковское шоссе')).toBe('ш. Дубковское');
    expect(shortStreetName('Площадь Свободы')).toBe('пл. Свободы');
  });
});
