// Player progress, kept in localStorage per map. Storage may be unavailable (private mode): never throw.

import { VEHICLES, type VehicleId } from './vehicles';

export interface Profile {
  version: 1;
  money: number;
  owned: VehicleId[];
  vehicle: VehicleId;
  /** Stars of the last deliveries (most recent last). */
  stars: number[];
  deliveries: number;
  earned: number;
  distance: number;
  bestStreak: number;
}

export function newProfile(): Profile {
  return { version: 1, money: 0, owned: ['foot'], vehicle: 'foot', stars: [], deliveries: 0, earned: 0, distance: 0, bestStreak: 0 };
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class SaveSlot {
  constructor(
    private readonly key: string,
    private readonly store: KeyValueStore | null = defaultStore(),
  ) {}

  load(): Profile {
    try {
      const raw = this.store?.getItem(this.key);
      if (!raw) return newProfile();
      const p = { ...newProfile(), ...JSON.parse(raw) } as Profile;
      const ids = new Set(VEHICLES.map((v) => v.id));
      p.owned = p.owned.filter((id) => ids.has(id));
      if (!p.owned.includes('foot')) p.owned.unshift('foot');
      if (!p.owned.includes(p.vehicle)) p.vehicle = 'foot';
      if (!Number.isFinite(p.money)) p.money = 0;
      return p;
    } catch {
      return newProfile();
    }
  }

  save(p: Profile): void {
    try {
      this.store?.setItem(this.key, JSON.stringify(p));
    } catch {
      // Storage full or disabled: progress just isn't kept.
    }
  }
}

export function rating(p: Profile): number | null {
  if (!p.stars.length) return null;
  return p.stars.reduce((a, b) => a + b, 0) / p.stars.length;
}
