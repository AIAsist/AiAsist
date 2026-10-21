// Three.js view of the game. «2D» = orthographic camera straight down; «3D» = tilted perspective
// camera following the courier. Both look at the same scene: buildings are real extrusions.

import * as THREE from 'three';
import type { GameMapData } from '../data/mapFormat';
import type { Game } from '../world/game';
import { ARRIVE_RADIUS } from '../world/game';
import { buildCourierModel, makeIconSprite, RouteLine, TargetMarker } from './actors';
import { buildMapLayers, type MapLayers } from './mapMeshes';
import { COLORS } from './palette';

export type ViewMode = '2d' | '3d';

const MIN_VIEW = 50;
const MAX_VIEW = 1500;

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 3000);
  private readonly persp = new THREE.PerspectiveCamera(50, 1, 1, 6000);
  private readonly layers: MapLayers;
  private courierModel: THREE.Group;
  private courierKey = '';
  private readonly marker = new TargetMarker(ARRIVE_RADIUS);
  private readonly route = new RouteLine();
  private readonly poiIcons = new THREE.Group();
  private routeKey = '';
  private routeTimer = 0;
  private mode: ViewMode = '2d';
  /** Visible height of the 2D view in metres (zoom). */
  viewHeight = 170;
  private camX = 0;
  private camY = 0;
  private width = 1;
  private height = 1;

  constructor(
    private readonly container: HTMLElement,
    map: GameMapData,
    private readonly game: Game,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(COLORS.land);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb8b0a0, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-0.5, 0.6, 1).normalize();
    this.scene.add(sun);

    this.layers = buildMapLayers(map);
    this.scene.add(this.layers.group);

    // Small icons of every pickup point: the town's real cafés and shops.
    for (const p of game.board.pickups) {
      const s = makeIconSprite(p.icon, '#ffffff', 64);
      s.position.set(p.x, p.y, 4);
      s.renderOrder = 200;
      s.userData.place = p;
      this.poiIcons.add(s);
    }
    this.scene.add(this.poiIcons);

    this.scene.add(this.route.mesh, this.marker.group);
    this.courierModel = new THREE.Group();
    this.scene.add(this.courierModel);

    this.ortho.up.set(0, 1, 0);
    this.persp.up.set(0, 0, 1);
    this.camX = game.courier.x;
    this.camY = game.courier.y;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  get viewMode(): ViewMode {
    return this.mode;
  }

  setViewMode(mode: ViewMode): void {
    this.mode = mode;
    for (const o of this.layers.topDownOnly) o.visible = mode === '2d';
    this.scene.background = new THREE.Color(mode === '3d' ? COLORS.sky : COLORS.land);
    this.scene.fog = mode === '3d' ? new THREE.Fog(COLORS.sky, 350, 1600) : null;
  }

  zoomBy(factor: number): void {
    this.viewHeight = Math.min(MAX_VIEW, Math.max(MIN_VIEW, this.viewHeight * factor));
  }

  resize(): void {
    this.width = this.container.clientWidth || window.innerWidth;
    this.height = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(this.width, this.height);
    this.persp.aspect = this.width / this.height;
    this.persp.updateProjectionMatrix();
  }

  private get camera(): THREE.Camera {
    return this.mode === '2d' ? this.ortho : this.persp;
  }

  /** Screen position (CSS px) of a world point, and whether it is in front of the camera. */
  project(x: number, y: number, z = 0): { x: number; y: number; visible: boolean } {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height, visible: v.z < 1 };
  }

  update(dt: number): void {
    const game = this.game;
    const c = game.courier;
    const vehicle = game.vehicle;

    // Courier model (rebuilt when the vehicle changes).
    const key = vehicle.id;
    if (key !== this.courierKey) {
      this.scene.remove(this.courierModel);
      this.courierModel = buildCourierModel(vehicle.id, vehicle.color);
      // Flat map layers skip the depth test, so the courier must be drawn after them.
      this.courierModel.traverse((o) => (o.renderOrder = 150));
      this.scene.add(this.courierModel);
      this.courierKey = key;
    }
    const speed = Math.hypot(c.vx, c.vy);
    // The view zooms out a little with speed.
    const zoomOut = 1 + (speed / Math.max(vehicle.maxSpeed, 1)) * 0.25;
    const vh = this.viewHeight * zoomOut;
    // In the top-down view the courier is drawn larger than life so it reads on a phone screen.
    const scale = this.mode === '2d' ? Math.max(2.5, vh / 32) : 2.2;
    this.courierModel.scale.setScalar(scale);
    this.courierModel.position.set(c.x, c.y, 0);
    this.courierModel.rotation.z = c.heading;
    this.courierModel.position.z = vehicle.id === 'foot' && speed > 0.5 ? Math.abs(Math.sin(game.time * 12)) * 0.08 * scale : 0;

    // Camera follows with a little look-ahead in the direction of travel.
    const look = this.mode === '2d' ? 0.9 : 0.5;
    const tx = c.x + c.vx * look;
    const ty = c.y + c.vy * look;
    const k = Math.min(1, dt * 4);
    this.camX += (tx - this.camX) * k;
    this.camY += (ty - this.camY) * k;
    if (this.mode === '2d') {
      const aspect = this.width / this.height;
      this.ortho.left = (-vh * aspect) / 2;
      this.ortho.right = (vh * aspect) / 2;
      this.ortho.top = vh / 2;
      this.ortho.bottom = -vh / 2;
      this.ortho.position.set(this.camX, this.camY, 1500);
      this.ortho.lookAt(this.camX, this.camY, 0);
      this.ortho.updateProjectionMatrix();
    } else {
      const dist = Math.max(35, vh * 0.55);
      const pitch = (52 * Math.PI) / 180;
      this.persp.position.set(this.camX, this.camY - dist * Math.cos(pitch), dist * Math.sin(pitch));
      this.persp.lookAt(this.camX, this.camY + dist * 0.12, 0);
    }

    // Target marker and route.
    const target = game.target();
    const order = game.active;
    if (target && order) {
      this.marker.show(target.x, target.y, order.stage === 'toPickup' ? 'pickup' : 'drop', target.icon);
    } else {
      this.marker.hide();
    }
    const iconSize = this.mode === '2d' ? vh * 0.07 : 9;
    this.marker.update(dt, iconSize, this.mode === '2d' ? 10 : 22);

    this.routeTimer -= dt;
    if (this.routeTimer <= 0) {
      this.routeTimer = 0.1;
      const r = game.route();
      const rk = r ? `${order?.id}:${order?.stage}:${r.startNode}:${Math.round(c.x)}:${Math.round(c.y)}` : '';
      if (rk !== this.routeKey) {
        this.routeKey = rk;
        this.route.set(r ? r.points : null, Math.max(1.6, vh * 0.009));
      }
    }

    // Pickup icons: shown when zoomed in enough, hidden for the active pickup (it has a big marker).
    const showIcons = vh < 700;
    this.poiIcons.visible = showIcons;
    if (showIcons) {
      const s = this.mode === '2d' ? vh * 0.035 : 5;
      for (const o of this.poiIcons.children) {
        const sprite = o as THREE.Sprite;
        sprite.scale.set(s, s, 1);
        sprite.visible = !(order && order.stage === 'toPickup' && sprite.userData.place === order.pickup);
      }
    }
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}

