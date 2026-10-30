// A «decent player» autopilot: follows the navigator, rings the bell at people ahead, brakes when a
// jumper shows its «!», and runs from the police with a dash. Used by tests and the smoke test to
// check that the real map is playable and the street life is fair, and handy for a demo mode.

import type { MoveInput } from './courier';
import type { Game } from './game';

const LOOKAHEAD = 6;

export function autopilotStep(game: Game): MoveInput {
  const c = game.courier;
  const street = game.street;
  const route = game.route();
  if (!route) return { x: 0, y: 0 };

  // Steer at a point a few metres ahead along the route.
  const p = route.points;
  let tx = p[p.length - 2];
  let ty = p[p.length - 1];
  let along = 0;
  for (let i = 2; i < p.length; i += 2) {
    along += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    if (along > LOOKAHEAD) {
      tx = p[i];
      ty = p[i + 1];
      break;
    }
  }
  const m = Math.hypot(tx - c.x, ty - c.y) || 1;
  let ix = (tx - c.x) / m;
  let iy = (ty - c.y) / m;

  const near = (x: number, y: number, r: number) => (x - c.x) ** 2 + (y - c.y) ** 2 < r * r;

  // A jumper about to leap (its «!» is showing) close by: brake.
  if (street.pedestrians.some((q) => (q.state === 'notice' || q.state === 'dash') && near(q.x, q.y, 32))) {
    return { x: 0, y: 0 };
  }
  // People ahead: ring the bell.
  if (street.bellCooldown <= 0 && street.pedestrians.some((q) => q.state === 'walk' && near(q.x, q.y, 18))) game.ring();

  // Police: dash. A chaser behind is simply outrun along the route; one ahead is avoided sideways.
  const chasers: { x: number; y: number }[] = street.officers.filter(
    (o) => (o.state === 'alert' || o.state === 'chase') && near(o.x, o.y, 30),
  );
  if (street.car && near(street.car.x, street.car.y, 60)) chasers.push(street.car);
  if (chasers.length) game.dash();
  for (const q of chasers) {
    const ax = q.x - c.x;
    const ay = q.y - c.y;
    if (ax * ix + ay * iy <= 0) continue; // behind
    let sx = -iy;
    let sy = ix;
    if (sx * ax + sy * ay > 0) {
      sx = -sx;
      sy = -sy;
    }
    ix = ix * 0.5 + sx * 0.5;
    iy = iy * 0.5 + sy * 0.5;
  }
  const im = Math.hypot(ix, iy) || 1;
  return { x: ix / im, y: iy / im };
}
