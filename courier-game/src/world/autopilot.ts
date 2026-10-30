// A «decent player» autopilot: follows the navigator, rings the bell at people ahead, brakes when a
// jumper shows its «!», keeps up speed and dashes when the police is after it, and backs off (or, as a
// last resort, presses «R» — back to the road) when it runs into a wall. Used by tests and the smoke
// test to check that the real map is playable and the street life is fair, and handy for a demo mode.

import type { MoveInput } from './courier';
import type { Game } from './game';

const LOOKAHEAD = 6;
/** No progress for this long while trying to move: back off; for the longer one: press «R». */
const STUCK_BACKOFF = 2;
const STUCK_UNSTUCK = 8;

export interface Autopilot {
  (game: Game): MoveInput;
  /** How many times it had to use «R» (back to the road). */
  unstucks: number;
}

export function createAutopilot(): Autopilot {
  let anchorX = NaN;
  let anchorY = NaN;
  let anchorTime = 0;
  let backoff = 0;

  const step = ((game: Game): MoveInput => {
    const c = game.courier;
    const street = game.street;
    const route = game.route();
    if (!route) return { x: 0, y: 0 };

    // Progress check: a few metres every few seconds (stuns do not count).
    if (Number.isNaN(anchorX) || Math.hypot(c.x - anchorX, c.y - anchorY) > 3 || c.stun > 0) {
      anchorX = c.x;
      anchorY = c.y;
      anchorTime = game.time;
    }
    const stuckFor = game.time - anchorTime;
    if (stuckFor > STUCK_UNSTUCK) {
      game.unstuck();
      step.unstucks++;
      anchorX = NaN;
    }

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
    const ix = (tx - c.x) / m;
    const iy = (ty - c.y) / m;

    // Ran into something: reverse and to the side for a moment, like a player would.
    if (stuckFor > STUCK_BACKOFF && backoff <= 0) backoff = 0.6;
    if (backoff > 0) {
      backoff -= 1 / 60;
      return { x: -ix * 0.6 - iy * 0.8, y: -iy * 0.6 + ix * 0.8 };
    }

    const near = (x: number, y: number, r: number) => (x - c.x) ** 2 + (y - c.y) ** 2 < r * r;

    // A jumper about to leap (its «!» is showing) close by: brake.
    if (street.pedestrians.some((q) => (q.state === 'notice' || q.state === 'dash') && near(q.x, q.y, 32))) {
      anchorTime = game.time;
      return { x: 0, y: 0 };
    }
    // People ahead: ring the bell.
    if (street.bellCooldown <= 0 && street.pedestrians.some((q) => q.state === 'walk' && near(q.x, q.y, 18))) game.ring();

    // Police after us: keep the speed up (a moving courier cannot be grabbed) and dash.
    const chased =
      street.officers.some((o) => (o.state === 'alert' || o.state === 'chase') && near(o.x, o.y, 30)) ||
      (street.car !== null && near(street.car.x, street.car.y, 60));
    if (chased) game.dash();
    return { x: ix, y: iy };
  }) as Autopilot;
  step.unstucks = 0;
  return step;
}
