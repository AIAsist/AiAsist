// Moving things: the courier model, target markers, POI icons and the navigation route.

import * as THREE from 'three';
import type { FlatCoords } from '../data/mapFormat';
import type { VehicleId } from '../world/vehicles';
import { COLORS } from './palette';

const lambert = (color: number) => new THREE.MeshLambertMaterial({ color });

/** Low-poly courier with the signature yellow thermal bag. Faces +x; z is up; metres. */
export function buildCourierModel(vehicle: VehicleId, color: number): THREE.Group {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  const riding = vehicle !== 'foot';
  const seatZ = vehicle === 'moped' ? 0.75 : vehicle === 'bike' ? 0.9 : vehicle === 'scooter' ? 0.25 : 0;

  // Vehicle.
  const dark = lambert(0x262626);
  if (vehicle === 'bike') {
    for (const x of [-0.55, 0.55]) {
      const wheel = add(new THREE.TorusGeometry(0.33, 0.06, 6, 14), dark, x, 0, 0.35);
      wheel.rotation.x = Math.PI / 2;
    }
    add(new THREE.BoxGeometry(1.1, 0.08, 0.08), lambert(color), 0, 0, 0.6);
    add(new THREE.BoxGeometry(0.08, 0.6, 0.06), dark, 0.5, 0, 1.0);
  } else if (vehicle === 'scooter') {
    add(new THREE.BoxGeometry(1.0, 0.22, 0.08), lambert(color), 0, 0, 0.15);
    add(new THREE.BoxGeometry(0.07, 0.07, 1.0), dark, 0.5, 0, 0.65);
    add(new THREE.BoxGeometry(0.06, 0.5, 0.06), dark, 0.5, 0, 1.15);
  } else if (vehicle === 'moped') {
    add(new THREE.BoxGeometry(1.5, 0.5, 0.45), lambert(color), 0, 0, 0.45);
    add(new THREE.BoxGeometry(0.5, 0.45, 0.12), dark, -0.2, 0, 0.74);
    add(new THREE.BoxGeometry(0.1, 0.7, 0.08), dark, 0.65, 0, 1.0);
    // Cylinder axis is y by default: already sideways, like a wheel axle.
    for (const x of [-0.6, 0.6]) add(new THREE.CylinderGeometry(0.28, 0.28, 0.16, 12), dark, x, 0, 0.28);
  }

  // Rider.
  const bodyH = riding ? 0.75 : 1.0;
  const body = add(new THREE.CylinderGeometry(0.26, 0.3, bodyH, 10), lambert(color), riding ? -0.05 : 0, 0, seatZ + (riding ? 0.45 : 0.95));
  body.rotation.x = Math.PI / 2;
  if (!riding) {
    for (const y of [-0.13, 0.13]) {
      const leg = add(new THREE.CylinderGeometry(0.09, 0.09, 0.5, 6), lambert(0x1f2937), 0, y, 0.25);
      leg.rotation.x = Math.PI / 2;
    }
  }
  add(new THREE.SphereGeometry(0.22, 12, 10), lambert(0xf2c9a0), riding ? 0 : 0.03, 0, seatZ + (riding ? 1.02 : 1.65));
  // Cap.
  add(new THREE.SphereGeometry(0.235, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), lambert(color), riding ? 0 : 0.03, 0, seatZ + (riding ? 1.06 : 1.69));
  // Thermal bag: the brightest thing on the screen.
  add(new THREE.BoxGeometry(0.55, 0.6, 0.55), lambert(0xffc400), riding ? -0.38 : -0.33, 0, seatZ + (riding ? 0.62 : 1.15));

  // Navigation puck on the ground: makes the courier and its heading readable from straight above.
  const flat = (geo: THREE.BufferGeometry, c: number, z: number) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: c }));
    m.position.z = z;
    g.add(m);
  };
  flat(new THREE.CircleGeometry(0.95, 28), color, 0.02);
  flat(new THREE.CircleGeometry(0.78, 28), 0xffffff, 0.03);
  const wedge = new THREE.Shape([new THREE.Vector2(1.05, 0.42), new THREE.Vector2(1.6, 0), new THREE.Vector2(1.05, -0.42)]);
  flat(new THREE.ShapeGeometry(wedge), color, 0.02);
  return g;
}

/** Round icon (emoji on a coloured disc) as a camera-facing sprite. */
export function makeIconSprite(emoji: string, bg: string, size = 128): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const r = size / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.arc(r, r + size * 0.03, r * 0.92, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(r, r, r * 0.88, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = size * 0.06;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.font = `${Math.round(size * 0.5)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, r, r + size * 0.03);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false }));
  sprite.renderOrder = 300;
  return sprite;
}

/** Pulsing ring + floating icon above the current target. */
export class TargetMarker {
  readonly group = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly disc: THREE.Mesh;
  private sprite: THREE.Sprite | null = null;
  private icon = '';
  private t = 0;

  constructor(radius: number) {
    const ringMat = new THREE.MeshBasicMaterial({ color: COLORS.pickup, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.82, radius, 40), ringMat);
    this.ring.renderOrder = 90;
    const discMat = new THREE.MeshBasicMaterial({ color: COLORS.pickup, transparent: true, opacity: 0.18, depthTest: false, depthWrite: false });
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 40), discMat);
    this.disc.renderOrder = 89;
    this.group.add(this.disc, this.ring);
    this.group.visible = false;
  }

  show(x: number, y: number, kind: 'pickup' | 'drop', icon: string): void {
    const color = kind === 'pickup' ? COLORS.pickup : COLORS.drop;
    (this.ring.material as THREE.MeshBasicMaterial).color.setHex(color);
    (this.disc.material as THREE.MeshBasicMaterial).color.setHex(color);
    this.group.position.set(x, y, 0.05);
    if (icon !== this.icon || !this.sprite) {
      if (this.sprite) {
        this.group.remove(this.sprite);
        this.sprite.material.map?.dispose();
        this.sprite.material.dispose();
      }
      this.sprite = makeIconSprite(icon, kind === 'pickup' ? '#f97316' : '#16a34a');
      this.group.add(this.sprite);
      this.icon = icon;
    }
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  /** `iconSize` — sprite size in metres (depends on zoom so it stays readable). */
  update(dt: number, iconSize: number, iconHeight: number): void {
    this.t += dt;
    const s = 1 + 0.12 * Math.sin(this.t * 5);
    this.ring.scale.set(s, s, 1);
    if (this.sprite) {
      this.sprite.scale.set(iconSize, iconSize, 1);
      this.sprite.position.set(0, 0, iconHeight + Math.sin(this.t * 3) * iconSize * 0.08);
    }
  }
}

/** Blue navigation line along the roads (rebuilt when the route changes). */
export class RouteLine {
  readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.BufferGeometry();

  constructor() {
    this.mesh = new THREE.Mesh(
      this.geo,
      new THREE.MeshBasicMaterial({ color: COLORS.route, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.mesh.renderOrder = 80;
    this.mesh.frustumCulled = false;
  }

  set(points: FlatCoords | null, hw: number): void {
    if (!points || points.length < 4) {
      this.mesh.visible = false;
      return;
    }
    const pos: number[] = [];
    const idx: number[] = [];
    const quad = (ax: number, ay: number, bx: number, by: number) => {
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-6) return;
      const nx = (-(by - ay) / len) * hw;
      const ny = ((bx - ax) / len) * hw;
      const o = pos.length / 3;
      pos.push(ax + nx, ay + ny, 0, ax - nx, ay - ny, 0, bx - nx, by - ny, 0, bx + nx, by + ny, 0);
      idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    };
    const disc = (cx: number, cy: number) => {
      const o = pos.length / 3;
      pos.push(cx, cy, 0);
      for (let s = 0; s < 8; s++) {
        const a = (s / 8) * Math.PI * 2;
        pos.push(cx + hw * Math.cos(a), cy + hw * Math.sin(a), 0);
      }
      for (let s = 0; s < 8; s++) idx.push(o, o + 1 + s, o + 1 + ((s + 1) % 8));
    };
    for (let i = 0; i + 3 < points.length; i += 2) {
      quad(points[i], points[i + 1], points[i + 2], points[i + 3]);
      if (i > 0) disc(points[i], points[i + 1]);
    }
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.geo.setIndex(idx);
    this.geo.computeBoundingSphere();
    this.mesh.visible = true;
  }
}
