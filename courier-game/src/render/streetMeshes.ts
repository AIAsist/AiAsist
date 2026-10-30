// Draws the street life: pedestrians (jumpers show a red «!» before they leap), police officers and
// the police car with flashing lights. Objects are pooled by id; models face +x, z is up, metres.

import * as THREE from 'three';
import type { Officer, Pedestrian, PoliceCar, StreetLife } from '../world/street';
import { makeIconSprite } from './actors';

const CLOTHES = [0x2563eb, 0x16a34a, 0xdb2777, 0x7c3aed, 0x0d9488, 0xea580c, 0x4b5563, 0xca8a04];
const RENDER_ORDER = 140;

// Shared geometry: cylinders pre-rotated so their axis is z (up).
const bodyGeo = new THREE.CylinderGeometry(0.3, 0.34, 0.95, 10).rotateX(Math.PI / 2);
const headGeo = new THREE.SphereGeometry(0.19, 10, 8);
const capGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.1, 12).rotateX(Math.PI / 2);
const visorGeo = new THREE.BoxGeometry(0.18, 0.3, 0.04);
const shadowGeo = new THREE.CircleGeometry(0.42, 16);
const ringGeo = new THREE.RingGeometry(0.42, 0.55, 20);

const lambert = (color: number) => new THREE.MeshLambertMaterial({ color });
const clothesMats = CLOTHES.map(lambert);
const skinMat = lambert(0xf2c9a0);
const policeMat = lambert(0x1e3a8a);
const policeCapMat = lambert(0x172554);
const redMat = lambert(0xdc2626);
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.2, depthWrite: false });
const policeRingMat = new THREE.MeshBasicMaterial({ color: 0x2563eb });

function figure(body: THREE.Material, police: boolean): THREE.Group {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  add(shadowGeo, shadowMat, 0, 0, 0.02);
  if (police) add(ringGeo, policeRingMat, 0, 0, 0.03);
  add(bodyGeo, body, 0, 0, 0.95);
  add(headGeo, skinMat, 0.02, 0, 1.6);
  if (police) {
    add(capGeo, policeCapMat, 0.02, 0, 1.76);
    add(visorGeo, redMat, 0.2, 0, 1.73);
  }
  return g;
}

function policeCar(): { group: THREE.Group; red: THREE.Mesh; blue: THREE.Mesh } {
  const g = new THREE.Group();
  const add = (w: number, d: number, h: number, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 2.2), shadowMat);
  shadow.position.z = 0.02;
  g.add(shadow);
  const dark = lambert(0x1f2937);
  for (const [x, y] of [[1.4, 0.85], [1.4, -0.85], [-1.4, 0.85], [-1.4, -0.85]]) add(0.7, 0.3, 0.6, dark, x, y, 0.3);
  add(4.4, 1.85, 0.75, lambert(0xf8fafc), 0, 0, 0.75);
  add(4.42, 1.87, 0.2, lambert(0x1d4ed8), 0, 0, 0.8); // blue stripe
  add(2.1, 1.6, 0.6, lambert(0xe2e8f0), -0.3, 0, 1.4);
  add(0.25, 1.5, 0.45, lambert(0x334155), 0.8, 0, 1.35); // windscreen
  const red = add(0.35, 0.6, 0.2, new THREE.MeshBasicMaterial({ color: 0xef4444 }), -0.3, 0.38, 1.8);
  const blue = add(0.35, 0.6, 0.2, new THREE.MeshBasicMaterial({ color: 0x3b82f6 }), -0.3, -0.38, 1.8);
  return { group: g, red, blue };
}

interface Pooled {
  group: THREE.Group;
  mark: THREE.Sprite | null;
}

export class StreetView {
  readonly group = new THREE.Group();
  private readonly people = new Map<number, Pooled>();
  private readonly cops = new Map<number, Pooled>();
  private car: { id: number; group: THREE.Group; red: THREE.Mesh; blue: THREE.Mesh } | null = null;
  private readonly jumperMark = makeIconSprite('!', '#dc2626', 96);
  private readonly copMark = makeIconSprite('!', '#1d4ed8', 96);

  constructor() {
    this.jumperMark.visible = false;
    this.copMark.visible = false;
  }

  /** `scale`: the same larger-than-life factor the courier is drawn with. */
  update(street: StreetLife, scale: number, time: number): void {
    const s = scale * 1.1;
    this.sync(this.people, street.pedestrians, (p) => this.makePerson(p), (o, p) => this.placePerson(o, p, s, time));
    this.sync(this.cops, street.officers, () => this.makeCop(), (o, c) => this.placeCop(o, c, s, time));
    this.updateCar(street.car, scale, time);
  }

  private sync<T extends { id: number }>(
    pool: Map<number, Pooled>,
    items: readonly T[],
    make: (item: T) => Pooled,
    place: (o: Pooled, item: T) => void,
  ): void {
    const alive = new Set<number>();
    for (const item of items) {
      alive.add(item.id);
      let o = pool.get(item.id);
      if (!o) {
        o = make(item);
        o.group.traverse((m) => (m.renderOrder = RENDER_ORDER));
        this.group.add(o.group);
        pool.set(item.id, o);
      }
      place(o, item);
    }
    for (const [id, o] of pool) {
      if (alive.has(id)) continue;
      this.group.remove(o.group);
      pool.delete(id);
    }
  }

  private makePerson(p: Pedestrian): Pooled {
    // Jumpers wear the same clothes as everybody: they give themselves away only by the «!».
    return { group: figure(clothesMats[p.look % clothesMats.length], false), mark: null };
  }

  private makeCop(): Pooled {
    return { group: figure(policeMat, true), mark: null };
  }

  private placePerson(o: Pooled, p: Pedestrian, s: number, time: number): void {
    const g = o.group;
    g.scale.setScalar(s);
    g.position.set(p.x, p.y, p.state === 'walk' ? Math.abs(Math.sin(time * 9 + p.id)) * 0.05 * s : 0);
    g.rotation.set(0, p.state === 'down' ? Math.PI / 2 : 0, p.heading);
    const warn = p.jumper && (p.state === 'notice' || p.state === 'dash');
    this.toggleMark(o, warn ? this.jumperMark : null, time);
  }

  private placeCop(o: Pooled, c: Officer, s: number, time: number): void {
    const g = o.group;
    g.scale.setScalar(s);
    g.position.set(c.x, c.y, c.state === 'chase' ? Math.abs(Math.sin(time * 14 + c.id)) * 0.08 * s : 0);
    g.rotation.set(0, 0, c.heading);
    this.toggleMark(o, c.state === 'alert' || c.state === 'chase' ? this.copMark : null, time);
  }

  /** Shows the «!» above a figure (each figure gets its own sprite sharing the template's material). */
  private toggleMark(o: Pooled, template: THREE.Sprite | null, time: number): void {
    if (!template) {
      if (o.mark) o.mark.visible = false;
      return;
    }
    if (!o.mark || o.mark.material !== template.material) {
      if (o.mark) o.group.remove(o.mark);
      o.mark = new THREE.Sprite(template.material);
      o.mark.renderOrder = 310;
      o.group.add(o.mark);
    }
    o.mark.visible = true;
    // Local units: the figure group itself is scaled up like the courier.
    o.mark.scale.setScalar(1.2);
    o.mark.position.set(0, 0, 2.6 + Math.sin(time * 10) * 0.15);
  }

  private updateCar(car: PoliceCar | null, scale: number, time: number): void {
    if (!car) {
      if (this.car) {
        this.group.remove(this.car.group);
        this.car = null;
      }
      return;
    }
    if (!this.car || this.car.id !== car.id) {
      if (this.car) this.group.remove(this.car.group);
      const made = policeCar();
      made.group.traverse((m) => (m.renderOrder = RENDER_ORDER));
      this.car = { id: car.id, ...made };
      this.group.add(made.group);
    }
    const g = this.car.group;
    g.scale.setScalar(Math.max(1.6, scale * 0.6));
    g.position.set(car.x, car.y, 0);
    g.rotation.z = car.heading;
    const phase = Math.floor(time * 6) % 2 === 0;
    this.car.red.visible = phase;
    this.car.blue.visible = !phase;
  }
}
