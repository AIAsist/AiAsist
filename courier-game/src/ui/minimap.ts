// Overview map of the whole town: pre-rendered once, markers drawn every frame.

import { ROAD_CLASSES, type FlatCoords, type GameMapData } from '../data/mapFormat';
import type { Courier } from '../world/courier';

export class Minimap {
  private readonly base: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scale: number;
  private readonly dpr: number;
  readonly cssWidth: number;
  readonly cssHeight: number;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly map: GameMapData,
    maxSize: number,
  ) {
    const { minX, minY, maxX, maxY } = map.bounds;
    const w = maxX - minX;
    const h = maxY - minY;
    this.scale = maxSize / Math.max(w, h);
    this.cssWidth = Math.round(w * this.scale);
    this.cssHeight = Math.round(h * this.scale);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = this.cssWidth * this.dpr;
    canvas.height = this.cssHeight * this.dpr;
    canvas.style.width = `${this.cssWidth}px`;
    canvas.style.height = `${this.cssHeight}px`;
    this.ctx = canvas.getContext('2d')!;

    this.base = document.createElement('canvas');
    this.base.width = canvas.width;
    this.base.height = canvas.height;
    this.prerender(this.base.getContext('2d')!);
  }

  private tx(x: number): number {
    return (x - this.map.bounds.minX) * this.scale * this.dpr;
  }

  private ty(y: number): number {
    return (this.map.bounds.maxY - y) * this.scale * this.dpr;
  }

  private path(ctx: CanvasRenderingContext2D, pts: FlatCoords, close: boolean): void {
    ctx.moveTo(this.tx(pts[0]), this.ty(pts[1]));
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(this.tx(pts[i]), this.ty(pts[i + 1]));
    if (close) ctx.closePath();
  }

  private prerender(ctx: CanvasRenderingContext2D): void {
    const m = this.map;
    ctx.fillStyle = '#ece7de';
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    ctx.fillStyle = '#c3dcb0';
    for (const a of m.areas) {
      if (a.k > 3) continue; // forest, park, grass, wetland
      ctx.beginPath();
      for (const ring of a.r) this.path(ctx, ring, true);
      ctx.fill('evenodd');
    }
    ctx.fillStyle = '#9ecbea';
    for (const w of m.water) {
      ctx.beginPath();
      for (const ring of w.r) this.path(ctx, ring, true);
      ctx.fill('evenodd');
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const styles: Record<string, [string, number]> = {
      major: ['#e0a94a', 2.2],
      secondary: ['#c9b27a', 1.6],
      street: ['#ffffff', 1.1],
      service: ['#ffffff', 0.6],
    };
    for (const cls of ['service', 'street', 'secondary', 'major']) {
      const [color, width] = styles[cls];
      ctx.strokeStyle = color;
      ctx.lineWidth = width * this.dpr;
      ctx.beginPath();
      for (const r of m.roads) {
        if (ROAD_CLASSES[r.c] !== cls) continue;
        const pts: FlatCoords = [];
        for (const i of r.i) pts.push(m.nodes[2 * i], m.nodes[2 * i + 1]);
        this.path(ctx, pts, false);
      }
      ctx.stroke();
    }
  }

  draw(courier: Courier, target: { x: number; y: number; color: string } | null, route: FlatCoords | null): void {
    const ctx = this.ctx;
    const d = this.dpr;
    ctx.drawImage(this.base, 0, 0);
    if (route && route.length >= 4) {
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2.2 * d;
      ctx.beginPath();
      this.path(ctx, route, false);
      ctx.stroke();
    }
    if (target) {
      ctx.fillStyle = target.color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 * d;
      ctx.beginPath();
      ctx.arc(this.tx(target.x), this.ty(target.y), 4.5 * d, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // Courier as an arrow.
    const cx = this.tx(courier.x);
    const cy = this.ty(courier.y);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-courier.heading);
    ctx.fillStyle = '#111827';
    ctx.strokeStyle = '#ffc400';
    ctx.lineWidth = 1.5 * d;
    ctx.beginPath();
    ctx.moveTo(6 * d, 0);
    ctx.lineTo(-4 * d, 4 * d);
    ctx.lineTo(-2 * d, 0);
    ctx.lineTo(-4 * d, -4 * d);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
