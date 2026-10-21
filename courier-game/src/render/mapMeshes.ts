// Turns the map data into a few large merged meshes (one draw call per layer).
// Flat layers lie at z = 0 and are ordered with renderOrder; buildings are real 3D extrusions.

import * as THREE from 'three';
import {
  AREA_KINDS,
  ROAD_CLASSES,
  ROAD_HALF_WIDTH,
  type FlatCoords,
  type GameMapData,
  type PolygonRings,
} from '../data/mapFormat';
import { ringSignedArea } from '../world/geometry';
import { AREA_COLORS, COLORS, ROAD_STYLE, ROOF_COLORS } from './palette';

/** Growable typed buffers for positions / colours / normals / indices. */
class GeoBuilder {
  pos = new Float32Array(3 * 1024);
  col: Float32Array | null;
  nor: Float32Array | null;
  idx = new Uint32Array(3 * 1024);
  vCount = 0;
  iCount = 0;

  constructor(opts: { colors?: boolean; normals?: boolean } = {}) {
    this.col = opts.colors ? new Float32Array(3 * 1024) : null;
    this.nor = opts.normals ? new Float32Array(3 * 1024) : null;
  }

  private growV(n: number) {
    const need = (this.vCount + n) * 3;
    if (need <= this.pos.length) return;
    const size = Math.max(need, this.pos.length * 2);
    const grow = (a: Float32Array) => {
      const b = new Float32Array(size);
      b.set(a);
      return b;
    };
    this.pos = grow(this.pos);
    if (this.col) this.col = grow(this.col);
    if (this.nor) this.nor = grow(this.nor);
  }

  private growI(n: number) {
    const need = this.iCount + n;
    if (need <= this.idx.length) return;
    const b = new Uint32Array(Math.max(need, this.idx.length * 2));
    b.set(this.idx);
    this.idx = b;
  }

  /** Adds a vertex and returns its index. */
  v(x: number, y: number, z: number, color?: THREE.Color, nx = 0, ny = 0, nz = 1): number {
    this.growV(1);
    const o = this.vCount * 3;
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    if (this.col && color) {
      this.col[o] = color.r;
      this.col[o + 1] = color.g;
      this.col[o + 2] = color.b;
    }
    if (this.nor) {
      this.nor[o] = nx;
      this.nor[o + 1] = ny;
      this.nor[o + 2] = nz;
    }
    return this.vCount++;
  }

  tri(a: number, b: number, c: number) {
    this.growI(3);
    this.idx[this.iCount++] = a;
    this.idx[this.iCount++] = b;
    this.idx[this.iCount++] = c;
  }

  get empty() {
    return this.iCount === 0;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.vCount * 3), 3));
    if (this.col) g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, this.vCount * 3), 3));
    if (this.nor) g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, this.vCount * 3), 3));
    g.setIndex(new THREE.BufferAttribute(this.idx.slice(0, this.iCount), 1));
    g.computeBoundingSphere();
    return g;
  }
}

function toVec2(ring: FlatCoords): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < ring.length; i += 2) out.push(new THREE.Vector2(ring[i], ring[i + 1]));
  return out;
}

/** Triangulates a polygon (with holes) at height z; triangles face +z. */
function addPolygon(b: GeoBuilder, rings: PolygonRings, z: number, color?: THREE.Color, dx = 0, dy = 0): void {
  const contour = toVec2(rings[0]);
  const holes = rings.slice(1).map(toVec2);
  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, holes);
  } catch {
    return;
  }
  const all = [...contour, ...holes.flat()];
  const base = b.vCount;
  for (const p of all) b.v(p.x + dx, p.y + dy, z, color);
  for (const [i, j, k] of faces) {
    const a = all[i];
    const c = all[j];
    const d = all[k];
    const cross = (c.x - a.x) * (d.y - a.y) - (c.y - a.y) * (d.x - a.x);
    if (cross >= 0) b.tri(base + i, base + j, base + k);
    else b.tri(base + i, base + k, base + j);
  }
}

/** Thick polyline with round joins and caps (joins only where the line actually turns). */
function addRibbon(b: GeoBuilder, pts: FlatCoords, hw: number, z: number, color?: THREE.Color): void {
  const n = pts.length / 2;
  if (n < 2) return;
  const fanSegs = hw > 3 ? 12 : 8;
  const fan = (cx: number, cy: number) => {
    const c = b.v(cx, cy, z, color);
    let prev = b.v(cx + hw, cy, z, color);
    const first = prev;
    for (let s = 1; s <= fanSegs; s++) {
      const a = (s / fanSegs) * Math.PI * 2;
      const cur = s === fanSegs ? first : b.v(cx + hw * Math.cos(a), cy + hw * Math.sin(a), z, color);
      b.tri(c, prev, cur);
      prev = cur;
    }
  };
  for (let i = 0; i + 1 < n; i++) {
    const ax = pts[2 * i];
    const ay = pts[2 * i + 1];
    const bx = pts[2 * i + 2];
    const by = pts[2 * i + 3];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) continue;
    const nx = (-(by - ay) / len) * hw;
    const ny = ((bx - ax) / len) * hw;
    const v0 = b.v(ax + nx, ay + ny, z, color);
    const v1 = b.v(ax - nx, ay - ny, z, color);
    const v2 = b.v(bx - nx, by - ny, z, color);
    const v3 = b.v(bx + nx, by + ny, z, color);
    b.tri(v0, v1, v2);
    b.tri(v0, v2, v3);
  }
  fan(pts[0], pts[1]);
  fan(pts[2 * n - 2], pts[2 * n - 1]);
  for (let i = 1; i + 1 < n; i++) {
    const ux = pts[2 * i] - pts[2 * i - 2];
    const uy = pts[2 * i + 1] - pts[2 * i - 1];
    const wx = pts[2 * i + 2] - pts[2 * i];
    const wy = pts[2 * i + 3] - pts[2 * i + 1];
    const cos = (ux * wx + uy * wy) / (Math.hypot(ux, uy) * Math.hypot(wx, wy) || 1);
    if (cos < 0.998) fan(pts[2 * i], pts[2 * i + 1]);
  }
}

/** Dashes along a polyline (railway ties look). */
function addDashes(b: GeoBuilder, pts: FlatCoords, hw: number, z: number, dash: number, gap: number): void {
  let carry = 0;
  let on = true;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i];
    const ay = pts[i + 1];
    const dx = pts[i + 2] - ax;
    const dy = pts[i + 3] - ay;
    const len = Math.hypot(dx, dy);
    let t = 0;
    while (t < len) {
      const step = Math.min((on ? dash : gap) - carry, len - t);
      if (on) addRibbonSegment(b, ax + (dx * t) / len, ay + (dy * t) / len, ax + (dx * (t + step)) / len, ay + (dy * (t + step)) / len, hw, z);
      t += step;
      carry += step;
      if (carry >= (on ? dash : gap) - 1e-6) {
        carry = 0;
        on = !on;
      }
    }
  }
}

function addRibbonSegment(b: GeoBuilder, ax: number, ay: number, bx: number, by: number, hw: number, z: number) {
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 1e-6) return;
  const nx = (-(by - ay) / len) * hw;
  const ny = ((bx - ax) / len) * hw;
  const v0 = b.v(ax + nx, ay + ny, z);
  const v1 = b.v(ax - nx, ay - ny, z);
  const v2 = b.v(bx - nx, by - ny, z);
  const v3 = b.v(bx + nx, by + ny, z);
  b.tri(v0, v1, v2);
  b.tri(v0, v2, v3);
}

function flatMaterial(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    transparent: opacity < 1,
    opacity,
  });
}

function flatMesh(geo: THREE.BufferGeometry, mat: THREE.Material, order: number, name: string): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = order;
  m.name = name;
  m.frustumCulled = false;
  return m;
}

export interface MapLayers {
  group: THREE.Group;
  /** Layers that only make sense in the top-down view (fake shadows). */
  topDownOnly: THREE.Object3D[];
}

export function buildMapLayers(map: GameMapData): MapLayers {
  const group = new THREE.Group();
  const topDownOnly: THREE.Object3D[] = [];
  const { minX, minY, maxX, maxY } = map.bounds;
  let order = 0;

  // Ground plane (larger than the map so the 3D view has a horizon).
  const pad = 4000;
  const ground = new GeoBuilder();
  addPolygon(ground, [[minX - pad, minY - pad, maxX + pad, minY - pad, maxX + pad, maxY + pad, minX - pad, maxY + pad]], 0);
  group.add(flatMesh(ground.build(), flatMaterial(COLORS.land), order++, 'ground'));

  // Land use (vertex coloured, biggest first).
  const areas = new GeoBuilder({ colors: true });
  const tmp = new THREE.Color();
  for (const a of map.areas) {
    tmp.setHex(AREA_COLORS[AREA_KINDS[a.k]] ?? COLORS.land);
    addPolygon(areas, a.r, 0, tmp.clone());
  }
  if (!areas.empty) {
    group.add(
      flatMesh(
        areas.build(),
        new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
        order++,
        'areas',
      ),
    );
  }

  // Water: streams/rivers as lines, then lakes, rivers and sea as polygons.
  const water = new GeoBuilder();
  for (const w of map.waterways) addRibbon(water, w.p, w.w / 2, 0);
  for (const w of map.water) addPolygon(water, w.r, 0);
  if (!water.empty) group.add(flatMesh(water.build(), flatMaterial(COLORS.water), order++, 'water'));

  // Railways: grey bed with light dashes.
  if (map.rails.length) {
    const bed = new GeoBuilder();
    const ties = new GeoBuilder();
    for (const r of map.rails) {
      addRibbon(bed, r, 1.3, 0);
      addDashes(ties, r, 0.55, 0, 7, 7);
    }
    group.add(flatMesh(bed.build(), flatMaterial(COLORS.rail), order++, 'rails'));
    group.add(flatMesh(ties.build(), flatMaterial(COLORS.railTie), order++, 'rail-ties'));
  }

  // Roads: road polylines resolved through the node table.
  const roadPts = map.roads.map((r) => {
    const pts: FlatCoords = [];
    for (const i of r.i) pts.push(map.nodes[2 * i], map.nodes[2 * i + 1]);
    return pts;
  });
  const bridges = new GeoBuilder();
  map.roads.forEach((r, k) => {
    if (r.b) addRibbon(bridges, roadPts[k], ROAD_HALF_WIDTH[ROAD_CLASSES[r.c]] + 2.2, 0);
  });
  if (!bridges.empty) group.add(flatMesh(bridges.build(), flatMaterial(0x8e8a84), order++, 'bridges'));

  // Draw order: small roads first so big roads cover them at junctions; all casings before all fills.
  const classOrder = [4, 3, 2, 1, 0];
  for (const pass of ['casing', 'fill'] as const) {
    for (const c of classOrder) {
      const cls = ROAD_CLASSES[c];
      const style = ROAD_STYLE[cls];
      const color = pass === 'casing' ? style.casing : style.fill;
      if (color === null) continue;
      const hw = ROAD_HALF_WIDTH[cls] + (pass === 'casing' ? 1 : 0);
      const b = new GeoBuilder();
      map.roads.forEach((r, k) => {
        if (r.c === c) addRibbon(b, roadPts[k], hw, 0);
      });
      if (!b.empty) group.add(flatMesh(b.build(), flatMaterial(color), order++, `road-${cls}-${pass}`));
    }
  }

  // Fake soft shadows for the top-down view (light from the north-west).
  const shadows = new GeoBuilder();
  for (const bld of map.buildings) {
    const off = Math.min(1 + bld.h * 0.12, 4);
    addPolygon(shadows, [bld.r[0]], 0, undefined, off, -off);
  }
  if (!shadows.empty) {
    // Transparent meshes render after all opaque ones (buildings included): the depth test keeps
    // the shadow off the roofs while the flat ground (no depth writes) still receives it.
    const mat = flatMaterial(COLORS.buildingShadow, 0.12);
    mat.depthTest = true;
    const m = flatMesh(shadows.build(), mat, order++, 'building-shadows');
    group.add(m);
    topDownOnly.push(m);
  }

  // Map edge: darken everything outside the playable bounds.
  const edge = new GeoBuilder();
  const far = pad;
  addPolygon(edge, [[minX - far, minY - far, maxX + far, minY - far, maxX + far, minY, minX - far, minY]], 0);
  addPolygon(edge, [[minX - far, maxY, maxX + far, maxY, maxX + far, maxY + far, minX - far, maxY + far]], 0);
  addPolygon(edge, [[minX - far, minY, minX, minY, minX, maxY, minX - far, maxY]], 0);
  addPolygon(edge, [[maxX, minY, maxX + far, minY, maxX + far, maxY, maxX, maxY]], 0);
  const edgeMat = flatMaterial(0x1f2937, 0.28);
  edgeMat.depthTest = true;
  group.add(flatMesh(edge.build(), edgeMat, order++, 'map-edge'));

  // Buildings: extruded with real heights. From straight above only roofs show (2D look).
  group.add(buildBuildings(map));
  return { group, topDownOnly };
}

function buildBuildings(map: GameMapData): THREE.Mesh {
  const b = new GeoBuilder({ colors: true, normals: true });
  const roof = new THREE.Color();
  const wall = new THREE.Color();
  for (const bld of map.buildings) {
    const h = bld.h;
    const hash = Math.abs(Math.floor(bld.r[0][0] * 7.3 + bld.r[0][1] * 3.1)) % ROOF_COLORS.length;
    roof.setHex(ROOF_COLORS[hash]);
    wall.copy(roof).multiplyScalar(0.82);
    // Normalise orientation: outer ring CCW, holes CW → outward normals are (dy, -dx).
    const rings = bld.r.map((ring, k) => {
      const ccw = ringSignedArea(ring) > 0;
      const wantCcw = k === 0;
      if (ccw === wantCcw) return ring;
      const rev: FlatCoords = [];
      for (let i = ring.length - 2; i >= 0; i -= 2) rev.push(ring[i], ring[i + 1]);
      return rev;
    });
    addPolygon(b, rings, h, roof);
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i += 2) {
        const ax = ring[i];
        const ay = ring[i + 1];
        const bx = ring[(i + 2) % n];
        const by = ring[(i + 3) % n];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 1e-6) continue;
        const nx = (by - ay) / len;
        const ny = -(bx - ax) / len;
        const v0 = b.v(ax, ay, 0, wall, nx, ny, 0);
        const v1 = b.v(bx, by, 0, wall, nx, ny, 0);
        const v2 = b.v(bx, by, h, wall, nx, ny, 0);
        const v3 = b.v(ax, ay, h, wall, nx, ny, 0);
        b.tri(v0, v1, v2);
        b.tri(v0, v2, v3);
      }
    }
  }
  const mesh = new THREE.Mesh(b.build(), new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.name = 'buildings';
  mesh.renderOrder = 100;
  return mesh;
}
