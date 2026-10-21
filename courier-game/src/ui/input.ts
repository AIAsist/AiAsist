// Keyboard (WASD / arrows), touch/mouse drag joystick, mouse wheel and pinch zoom.

import type { MoveInput } from '../world/courier';

const STICK_RADIUS = 60;

export class Input {
  private readonly keys = new Set<string>();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private stickOrigin: { x: number; y: number } | null = null;
  private stickVec = { x: 0, y: 0 };
  private pinchDist = 0;
  onZoom: (factor: number) => void = () => {};
  onKey: (code: string) => void = () => {};

  constructor(
    surface: HTMLElement,
    private readonly stickEl: HTMLElement,
  ) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      if (!e.repeat) this.onKey(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.release();
    });

    surface.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.onZoom(Math.exp(e.deltaY * 0.0012));
    }, { passive: false });

    surface.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      surface.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        this.stickOrigin = { x: e.clientX, y: e.clientY };
        this.stickVec = { x: 0, y: 0 };
        this.drawStick();
      } else if (this.pointers.size === 2) {
        // Second finger: pinch zoom instead of steering.
        this.stickOrigin = null;
        this.stickVec = { x: 0, y: 0 };
        this.drawStick();
        this.pinchDist = this.currentPinch();
      }
    });
    surface.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const d = this.currentPinch();
        if (this.pinchDist > 0 && d > 0) this.onZoom(this.pinchDist / d);
        this.pinchDist = d;
        return;
      }
      if (!this.stickOrigin) return;
      let dx = (e.clientX - this.stickOrigin.x) / STICK_RADIUS;
      let dy = (e.clientY - this.stickOrigin.y) / STICK_RADIUS;
      const m = Math.hypot(dx, dy);
      if (m > 1) {
        dx /= m;
        dy /= m;
      }
      // Small dead zone so a tap does not move the courier.
      this.stickVec = m < 0.15 ? { x: 0, y: 0 } : { x: dx, y: -dy };
      this.drawStick();
    });
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) this.release();
      this.pinchDist = 0;
    };
    surface.addEventListener('pointerup', up);
    surface.addEventListener('pointercancel', up);
  }

  private currentPinch(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private release(): void {
    this.stickOrigin = null;
    this.stickVec = { x: 0, y: 0 };
    this.pointers.clear();
    this.drawStick();
  }

  private drawStick(): void {
    const el = this.stickEl;
    if (!this.stickOrigin) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    el.style.left = `${this.stickOrigin.x}px`;
    el.style.top = `${this.stickOrigin.y}px`;
    const knob = el.firstElementChild as HTMLElement;
    knob.style.transform = `translate(${this.stickVec.x * STICK_RADIUS}px, ${-this.stickVec.y * STICK_RADIUS}px)`;
  }

  get move(): MoveInput {
    let x = 0;
    let y = 0;
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (x || y) {
      const m = Math.hypot(x, y);
      return { x: x / m, y: y / m };
    }
    return { ...this.stickVec };
  }
}
