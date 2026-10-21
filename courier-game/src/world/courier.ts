// Courier movement: arcade direct control (stick direction = movement direction), with collisions.

import type { Vehicle } from './vehicles';
import type { World } from './world';

export const COURIER_RADIUS = 0.9;
const STEP = 0.4;

export interface Courier {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Facing angle, radians (0 = east, counter-clockwise). */
  heading: number;
  onRoad: boolean;
  /** Metres travelled in total. */
  odometer: number;
}

export function createCourier(x: number, y: number): Courier {
  return { x, y, vx: 0, vy: 0, heading: Math.PI / 2, onRoad: true, odometer: 0 };
}

export interface MoveInput {
  /** Desired direction, |(x, y)| ≤ 1 (0 = stop). */
  x: number;
  y: number;
}

export function updateCourier(c: Courier, input: MoveInput, vehicle: Vehicle, world: World, dt: number): void {
  c.onRoad = world.onRoad(c.x, c.y);
  let ix = input.x;
  let iy = input.y;
  const mag = Math.hypot(ix, iy);
  if (mag > 1) {
    ix /= mag;
    iy /= mag;
  }
  const top = vehicle.maxSpeed * (c.onRoad ? 1 : vehicle.offroad);
  const tx = ix * top;
  const ty = iy * top;
  const dvx = tx - c.vx;
  const dvy = ty - c.vy;
  const dv = Math.hypot(dvx, dvy);
  // Braking is stronger than accelerating; letting go of the stick stops quickly.
  const rate = (mag < 0.05 ? 2.2 : 1) * vehicle.accel * dt;
  if (dv <= rate) {
    c.vx = tx;
    c.vy = ty;
  } else {
    c.vx += (dvx / dv) * rate;
    c.vy += (dvy / dv) * rate;
  }

  const dist = Math.hypot(c.vx, c.vy) * dt;
  if (dist < 1e-6) return;
  const steps = Math.ceil(dist / STEP);
  const sx = (c.vx * dt) / steps;
  const sy = (c.vy * dt) / steps;
  for (let i = 0; i < steps; i++) {
    const nx = c.x + sx;
    const ny = c.y + sy;
    if (!world.isBlocked(nx, ny, COURIER_RADIUS)) {
      c.x = nx;
      c.y = ny;
    } else if (sx !== 0 && !world.isBlocked(nx, c.y, COURIER_RADIUS)) {
      // Slide along the obstacle.
      c.x = nx;
      c.vy *= 0.5;
    } else if (sy !== 0 && !world.isBlocked(c.x, ny, COURIER_RADIUS)) {
      c.y = ny;
      c.vx *= 0.5;
    } else {
      c.vx *= 0.2;
      c.vy *= 0.2;
      break;
    }
    c.odometer += Math.hypot(sx, sy);
  }

  const speed = Math.hypot(c.vx, c.vy);
  if (speed > 0.3) {
    const target = Math.atan2(c.vy, c.vx);
    let d = target - c.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    c.heading += d * Math.min(1, dt * 12);
  }
}
