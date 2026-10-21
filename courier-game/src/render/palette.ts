import type { AreaKind, RoadClass } from '../data/mapFormat';

export const COLORS = {
  land: 0xece7de,
  water: 0x9ecbea,
  waterway: 0x9ecbea,
  rail: 0x8f8a84,
  railTie: 0xf4f1ea,
  buildingShadow: 0x000000,
  route: 0x2563eb,
  pickup: 0xf97316,
  drop: 0x16a34a,
  sky: 0xbfdcf2,
};

export const AREA_COLORS: Record<AreaKind, number> = {
  forest: 0xb5d4a2,
  park: 0xc5e3ad,
  grass: 0xd2e8bd,
  wetland: 0xc9dfd2,
  sand: 0xf2e6bd,
  industrial: 0xdcd5df,
  residential: 0xe5e0d6,
  cemetery: 0xc2d8b6,
  pitch: 0xb6dfbf,
  farmland: 0xebe7c8,
};

export const ROAD_STYLE: Record<RoadClass, { fill: number; casing: number | null }> = {
  major: { fill: 0xffd685, casing: 0xd3a24c },
  secondary: { fill: 0xfff0b3, casing: 0xd2c08a },
  street: { fill: 0xffffff, casing: 0xcdc5b8 },
  service: { fill: 0xfbf9f5, casing: 0xd6d0c4 },
  path: { fill: 0xd9c9ad, casing: null },
};

/** Roof colours: buildings pick one by a hash of their position for a lived-in look. */
export const ROOF_COLORS = [0xd8d0c4, 0xd2c8bb, 0xcfc6be, 0xdcd3c3, 0xc9c1b6, 0xd6cabb];
