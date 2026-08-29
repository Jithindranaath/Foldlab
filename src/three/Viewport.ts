import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { FoldEdge, FoldSchedule, Vec2 } from '../core/types.ts';
import { buildEdgeIndex, worldDirectionForPanel, worldPointForPanel, easeInOutCubic } from '../core/kinematics.ts';
import { PanelTree } from './PanelTree.ts';
import { createWorldAxes, createLocalFrame, disposeAxesGroup } from './Axes.ts';
import { createGroundGrid, disposeGrid } from './Grid.ts';
import { createDimensionCallouts, type DimensionsHandle } from './Dimensions.ts';

export interface ShowFlags {
  axes: boolean;
  grid: boolean;
  frames: boolean;
  dims: boolean;
}

const DEFAULT_SHOW: ShowFlags = { axes: false, grid: false, frames: false, dims: true };

const DIMS_FADE_START_T = 0.82;

const OPEN_ANIM_MS = 650;
const CAMERA_ANIM_MS = 900;
const CLICK_MOVE_TOLERANCE_PX = 6;

interface CameraTarget {
  position: THREE.Vector3;
  target: THREE.Vector3;
  near: number;
  far: number;
}

export class Viewport {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private resizeObserver: ResizeObserver;
  private rafId: number | null = null;
  private container: HTMLElement;

  private panelTree: PanelTree | null = null;
  private dimensions: DimensionsHandle | null = null;
  private localFrames: THREE.Group[] = [];
  private worldAxes: THREE.Group;
  private grid: THREE.Group;
  private show: ShowFlags = { ...DEFAULT_SHOW };
  private lastT = 0;
  private disposed = false;

  private schedule: FoldSchedule | null = null;
  private edgeByChild = new Map<string, FoldEdge>();
  private defaultCameraTarget: CameraTarget | null = null;

  private closedCameraTarget: CameraTarget | null = null;

  private wasClosed = false;

  private openedPanelId: string | null = null;
  private openProgress = 0;
  private openAnimActive = false;
  private openAnimStartMs = 0;
  private openAnimFrom = 0;
  private openAnimTo = 0;

  private cameraAnim: { from: CameraTarget; to: CameraTarget; startMs: number } | null = null;

  private pointerDownPos: { x: number; y: number } | null = null;
  private onOpenedPanelChange: ((panelId: string | null) => void) | null = null;
  private raycaster = new THREE.Raycaster();

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 8000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(420, -520, 340);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.97;
    this.controls.minDistance = 30;
    this.controls.maxDistance = 3000;
    this.controls.target.set(170, 170, -20);
    this.controls.autoRotate = false;
    this.controls.autoRotateSpeed = 1.2;
    this.controls.update();

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(420, -260, 210);
    const fill = new THREE.DirectionalLight(0xffffff, 0.32);
    fill.position.set(-300, 220, 150);
    const rim = new THREE.DirectionalLight(0xffffff, 0.22);
    rim.position.set(0, 400, -260);
    this.scene.add(ambient, key, fill, rim);

    this.worldAxes = createWorldAxes();
    this.grid = createGroundGrid();
    this.scene.add(this.worldAxes, this.grid);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);
    this.handleResize();

    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.handlePointerUp);
    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.style.cursor = 'grab';

    this.rafId = requestAnimationFrame(this.animate);
  }

  setOnOpenedPanelChange(cb: ((panelId: string | null) => void) | null): void {
    this.onOpenedPanelChange = cb;
  }

  private handlePointerDown = (ev: PointerEvent): void => {
    this.pointerDownPos = { x: ev.clientX, y: ev.clientY };
    this.controls.autoRotate = false;
  };

  private handlePointerUp = (ev: PointerEvent): void => {
    const down = this.pointerDownPos;
    this.pointerDownPos = null;
    if (!down) return;
    const dx = ev.clientX - down.x;
    const dy = ev.clientY - down.y;
    if (Math.hypot(dx, dy) > CLICK_MOVE_TOLERANCE_PX) return;

    const panelId = this.pickPanelAt(ev.clientX, ev.clientY);
    if (panelId) this.toggleOpenPanel(panelId);
    else if (this.openedPanelId) this.closeOpenedPanel();
  };

  private handlePointerMove = (ev: PointerEvent): void => {
    if (this.pointerDownPos) return;
    const panelId = this.pickPanelAt(ev.clientX, ev.clientY);
    this.renderer.domElement.style.cursor = panelId ? 'pointer' : 'grab';
  };

  private pickPanelAt(clientX: number, clientY: number): string | null {
    if (!this.panelTree) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.panelTree.root, true);
    for (const hit of hits) {
      const id = this.panelTree.panelIdForObject(hit.object);
      if (id) return id;
    }
    return null;
  }

  toggleOpenPanel(panelId: string): void {
    if (this.openedPanelId === panelId && this.openProgress > 0.05) {
      this.closeOpenedPanel();
      return;
    }
    this.openedPanelId = panelId;
    this.openAnimActive = true;
    this.openAnimStartMs = performance.now();
    this.openAnimFrom = this.openProgress;
    this.openAnimTo = 1;
    this.onOpenedPanelChange?.(panelId);

    const target = this.computePanelPovCamera(panelId);
    if (target) this.startCameraAnim(target);
  }

  closeOpenedPanel(): void {
    if (!this.openedPanelId) return;
    this.openAnimActive = true;
    this.openAnimStartMs = performance.now();
    this.openAnimFrom = this.openProgress;
    this.openAnimTo = 0;

    const returnTarget = this.closedCameraTarget ?? this.defaultCameraTarget;
    if (returnTarget) this.startCameraAnim(returnTarget);
  }

  private computePanelPovCamera(panelId: string): CameraTarget | null {
    if (!this.schedule) return null;
    const root = this.schedule.panels.find((p) => p.id === this.schedule!.root);
    const panel = this.schedule.panels.find((p) => p.id === panelId);
    if (!panel || !root) return null;

    const centroidFlat = { x: panel.bbox.x + panel.bbox.w / 2, y: panel.bbox.y + panel.bbox.h / 2 };
    const worldCentroid = worldPointForPanel(panelId, centroidFlat, 1, this.edgeByChild);
    const n = worldDirectionForPanel(panelId, { x: 0, y: 0, z: 1 }, 1, this.edgeByChild);
    const nLen = Math.hypot(n.x, n.y, n.z) || 1;

    const boxRadius = Math.hypot(root.bbox.w / 2, root.bbox.h / 2, this.schedule.dims.D / 2);
    const distance = Math.max(boxRadius / Math.sin((this.camera.fov * Math.PI) / 360), 90) * 1.35;

    const position = new THREE.Vector3(
      worldCentroid.x + (n.x / nLen) * distance,
      worldCentroid.y + (n.y / nLen) * distance,
      worldCentroid.z + (n.z / nLen) * distance
    );
    const target = new THREE.Vector3(worldCentroid.x, worldCentroid.y, worldCentroid.z);
    return { position, target, near: Math.max(1, distance * 0.01), far: distance * 40 };
  }

  private startCameraAnim(to: CameraTarget): void {
    this.cameraAnim = {
      from: {
        position: this.camera.position.clone(),
        target: this.controls.target.clone(),
        near: this.camera.near,
        far: this.camera.far
      },
      to,
      startMs: performance.now()
    };
  }

  private handleResize = (): void => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private animate = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.animate);

    this.tickOpenAnimation();
    this.tickCameraAnimation();
    this.updateAxesPosition();

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private tickOpenAnimation(): void {
    if (!this.openAnimActive) return;
    const raw = Math.min(1, (performance.now() - this.openAnimStartMs) / OPEN_ANIM_MS);
    this.openProgress = this.openAnimFrom + (this.openAnimTo - this.openAnimFrom) * raw;
    this.panelTree?.setFoldParameter(this.lastT, this.openedPanelId, this.openProgress);
    if (raw >= 1) {
      this.openAnimActive = false;
      if (this.openAnimTo === 0) {
        const closedId = this.openedPanelId;
        this.openedPanelId = null;
        if (closedId) this.onOpenedPanelChange?.(null);
      }
    }
  }

  private tickCameraAnimation(): void {
    const anim = this.cameraAnim;
    if (!anim) return;
    const raw = Math.min(1, (performance.now() - anim.startMs) / CAMERA_ANIM_MS);
    const eased = easeInOutCubic(raw);
    this.camera.position.lerpVectors(anim.from.position, anim.to.position, eased);
    this.controls.target.lerpVectors(anim.from.target, anim.to.target, eased);
    this.camera.near = anim.from.near + (anim.to.near - anim.from.near) * eased;
    this.camera.far = anim.from.far + (anim.to.far - anim.from.far) * eased;
    this.camera.updateProjectionMatrix();
    if (raw >= 1) this.cameraAnim = null;
  }

  loadSchedule(schedule: FoldSchedule): void {
    this.disposeSchedule();
    this.schedule = schedule;
    this.edgeByChild = buildEdgeIndex(schedule).edgeByChild;
    this.openedPanelId = null;
    this.openProgress = 0;
    this.openAnimActive = false;
    this.cameraAnim = null;
    this.wasClosed = false;
    this.controls.autoRotate = false;

    this.panelTree = new PanelTree(schedule);
    this.scene.add(this.panelTree.root);

    this.dimensions = createDimensionCallouts(schedule);
    this.setDimsOpacity(0);
    this.scene.add(this.dimensions.group);

    for (const panel of schedule.panels) {
      const container = this.panelTree.getContainer(panel.id);
      if (!container) continue;
      const frame = createLocalFrame(10);
      frame.visible = this.show.frames;
      container.add(frame);
      this.localFrames.push(frame);
    }

    this.setFoldParameter(0);
    this.fitToView(schedule);
  }

  setFoldParameter(t: number): void {
    this.lastT = t;
    this.panelTree?.setFoldParameter(t, this.openedPanelId, this.openProgress);
    this.updateDimsFade();
    this.updateFoldCompletionEffects();
  }

  private updateFoldCompletionEffects(): void {
    const isClosed = this.lastT >= 0.999;
    if (isClosed && !this.wasClosed && !this.openedPanelId) {
      this.controls.autoRotate = true;
      if (this.closedCameraTarget) this.startCameraAnim(this.closedCameraTarget);
    } else if (!isClosed) {
      this.controls.autoRotate = false;
      if (this.wasClosed && !this.openedPanelId && this.defaultCameraTarget) {
        this.startCameraAnim(this.defaultCameraTarget);
      }
    }
    this.wasClosed = isClosed;
  }

  setShow(next: Partial<ShowFlags>): void {
    this.show = { ...this.show, ...next };
    this.worldAxes.visible = this.show.axes;
    this.grid.visible = this.show.grid;
    for (const frame of this.localFrames) frame.visible = this.show.frames;
    this.updateDimsFade();
  }

  private updateAxesPosition(): void {
    if (!this.show.axes || !this.schedule) return;
    const t = this.lastT;
    let minX = Infinity;
    let minY = Infinity;
    let maxZ = -Infinity;
    for (const panel of this.schedule.panels) {
      const corners: Vec2[] = [
        { x: panel.bbox.x, y: panel.bbox.y },
        { x: panel.bbox.x + panel.bbox.w, y: panel.bbox.y },
        { x: panel.bbox.x + panel.bbox.w, y: panel.bbox.y + panel.bbox.h },
        { x: panel.bbox.x, y: panel.bbox.y + panel.bbox.h }
      ];
      for (const c of corners) {
        const w = worldPointForPanel(panel.id, c, t, this.edgeByChild);
        if (w.x < minX) minX = w.x;
        if (w.y < minY) minY = w.y;
        if (w.z > maxZ) maxZ = w.z;
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxZ)) return;
    const margin = 10;
    this.worldAxes.position.set(minX - margin, minY - margin, maxZ + margin);
  }

  private updateDimsFade(): void {
    if (!this.show.dims) {
      this.setDimsOpacity(0);
      return;
    }
    const raw = (this.lastT - DIMS_FADE_START_T) / (1 - DIMS_FADE_START_T);
    this.setDimsOpacity(easeInOutCubic(raw));
  }

  private setDimsOpacity(opacity: number): void {
    if (!this.dimensions) return;
    this.dimensions.group.visible = opacity > 0.003;
    this.dimensions.setOpacity(opacity);
  }

  fitToView(schedule: FoldSchedule): void {
    const target = this.computeDefaultCamera(schedule);
    if (!target) return;
    this.defaultCameraTarget = target;
    this.closedCameraTarget = this.computeClosedCamera(schedule);
    this.controls.target.copy(target.target);
    this.camera.position.copy(target.position);
    this.camera.near = target.near;
    this.camera.far = target.far;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private static readonly VIEW_DIR = new THREE.Vector3(0.55, -0.95, 1.25).normalize();

  private frameCameraAt(cx: number, cy: number, cz: number, radius: number, multiplier: number): CameraTarget {

    const fitDistance = radius / Math.sin((this.camera.fov * Math.PI) / 360);
    const position = Viewport.VIEW_DIR.clone()
      .multiplyScalar(fitDistance * multiplier)
      .add(new THREE.Vector3(cx, cy, cz));
    return {
      position,
      target: new THREE.Vector3(cx, cy, cz),
      near: Math.max(1, radius * 0.01),
      far: radius * 40
    };
  }

  private computeDefaultCamera(schedule: FoldSchedule): CameraTarget | null {
    const root = schedule.panels.find((p) => p.id === schedule.root);
    if (!root) return null;
    const cx = root.bbox.x + root.bbox.w / 2;
    const cy = root.bbox.y + root.bbox.h / 2;
    const cz = -schedule.dims.D / 2;

    const closedRadius = Math.hypot(root.bbox.w / 2, root.bbox.h / 2, schedule.dims.D / 2);
    let flatMaxDist = 0;
    for (const p of schedule.panels) {
      for (const corner of [
        { x: p.bbox.x, y: p.bbox.y },
        { x: p.bbox.x + p.bbox.w, y: p.bbox.y + p.bbox.h }
      ]) {
        flatMaxDist = Math.max(flatMaxDist, Math.hypot(corner.x - cx, corner.y - cy));
      }
    }
    const radius = Math.max(closedRadius, flatMaxDist) + 15;
    return this.frameCameraAt(cx, cy, cz, radius, 1.15);
  }

  private computeClosedCamera(schedule: FoldSchedule): CameraTarget | null {
    const root = schedule.panels.find((p) => p.id === schedule.root);
    if (!root) return null;
    const cx = root.bbox.x + root.bbox.w / 2;
    const cy = root.bbox.y + root.bbox.h / 2;
    const cz = -schedule.dims.D / 2;
    const closedRadius = Math.hypot(root.bbox.w / 2, root.bbox.h / 2, schedule.dims.D / 2) + 8;
    return this.frameCameraAt(cx, cy, cz, closedRadius, 1.02);
  }

  private disposeSchedule(): void {
    if (this.panelTree) {
      this.scene.remove(this.panelTree.root);
      this.panelTree.dispose();
      this.panelTree = null;
    }
    if (this.dimensions) {
      this.scene.remove(this.dimensions.group);
      this.dimensions.dispose();
      this.dimensions = null;
    }
    for (const frame of this.localFrames) {
      frame.parent?.remove(frame);
      frame.traverse((obj) => {
        if (obj instanceof THREE.ArrowHelper) obj.dispose();
      });
    }
    this.localFrames = [];
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp);
    this.renderer.domElement.removeEventListener('pointermove', this.handlePointerMove);
    this.disposeSchedule();
    disposeAxesGroup(this.worldAxes);
    disposeGrid(this.grid);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
