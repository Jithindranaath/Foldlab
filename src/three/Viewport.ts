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
// How close to fully closed the dimension callouts start fading in — a
// smooth crossfade instead of a hard visibility flip, which used to pop in
// abruptly right at the end of the fold.
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
  // Tighter than defaultCameraTarget, which has to stay wide enough to fit
  // the FLAT sheet too (usually much bigger than the folded box). Framed
  // from the closed box's own bounding sphere alone, so the box actually
  // fills the viewport once it's done folding instead of sitting small in
  // the middle of the wide flat-sheet framing.
  private closedCameraTarget: CameraTarget | null = null;

  // Auto-rotate kicks in the moment the fold finishes (t crosses 1) and
  // stops the instant the user takes the camera themselves — it should
  // never fight a manual orbit. `wasClosed` (not `lastT === 1` directly)
  // is what gates re-arming it: without that edge check, autoRotate would
  // re-enable itself on every frame the box happens to sit at t=1, undoing
  // the very pointerdown handler that just turned it off.
  private wasClosed = false;

  // Click-to-open state: an independent scalar per opened panel, animated
  // over real time and fed into PanelTree.setFoldParameter as an override —
  // see the doc comment there for why this doesn't disturb the main fold.
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

    // Harder-edged, higher-contrast lighting than the old soft/even setup —
    // one dominant key light (brutalist look wants a visible light
    // direction, not an evenly-lit product shot), a light ambient/fill floor
    // so the far side never goes fully black.
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

  /** Called whenever the open/closed panel changes (including the click
   * that opened it, and the moment a close animation actually finishes) —
   * lets the UI show a "close" affordance without polling every frame. */
  setOnOpenedPanelChange(cb: ((panelId: string | null) => void) | null): void {
    this.onOpenedPanelChange = cb;
  }

  private handlePointerDown = (ev: PointerEvent): void => {
    this.pointerDownPos = { x: ev.clientX, y: ev.clientY };
    this.controls.autoRotate = false; // any manual touch takes control, permanently until the next fold
  };

  private handlePointerUp = (ev: PointerEvent): void => {
    const down = this.pointerDownPos;
    this.pointerDownPos = null;
    if (!down) return;
    const dx = ev.clientX - down.x;
    const dy = ev.clientY - down.y;
    if (Math.hypot(dx, dy) > CLICK_MOVE_TOLERANCE_PX) return; // was a drag/orbit, not a click

    const panelId = this.pickPanelAt(ev.clientX, ev.clientY);
    if (panelId) this.toggleOpenPanel(panelId);
    else if (this.openedPanelId) this.closeOpenedPanel();
  };

  private handlePointerMove = (ev: PointerEvent): void => {
    if (this.pointerDownPos) return; // mid-drag/orbit — don't fight OrbitControls' own cursor
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

  /** Click a panel to swing it open on its own hinge (independent of the
   * main fold) and fly the camera to a POV looking straight at that face;
   * click the same panel again (or empty space) to close it and return. */
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

    // Panels only open once the box is closed, so return to the tight
    // closed framing (not the wide flat-sheet one) — otherwise closing a
    // panel would visibly shrink the box back out for no reason.
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

    // Frame for the WHOLE closed box's scale from this vantage, not just the
    // clicked panel's own size — otherwise a small flap fills the entire
    // screen and there's no box left to see it open against.
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

    // Always 0, not this.lastT: reusing a previous file's t here (e.g. 1,
    // if the last box was closed) would fire updateFoldCompletionEffects'
    // "just closed" branch against the OLD schedule's closedCameraTarget,
    // one line before fitToView below computes the new one.
    this.setFoldParameter(0);
    this.fitToView(schedule);
  }

  setFoldParameter(t: number): void {
    this.lastT = t;
    this.panelTree?.setFoldParameter(t, this.openedPanelId, this.openProgress);
    this.updateDimsFade();
    this.updateFoldCompletionEffects();
  }

  /** Fires on the rising/falling edge of "just finished closing" (not on
   * every frame t happens to equal 1 — that would also fire while the user
   * is mid-drag at a closed box, undoing their own input): arms auto-rotate
   * and zooms the camera in to the tight closed-box framing, or on the way
   * back out (scrub/reset) zooms back to the wide flat-sheet framing so the
   * whole sheet is visible again. Re-folding after that earns a fresh spin
   * and a fresh zoom instead of picking up stale state. */
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

  /** Keeps the world-axes triad glued to the box's own live geometry — not
   * a fixed/flat reference point. Earlier this was pinned to the ROOT
   * panel's flat bbox: since the root never rotates, that point never
   * moved for the whole animation (jumped to one spot at load and just
   * sat there while everything else folded around it), and its z was a
   * bare margin constant, never actually reaching schedule.dims.D — so the
   * triad neither tracked the fold nor sat at a geometrically correct
   * corner.
   *
   * Fixed here by re-deriving the corner every frame from the SAME rigid
   * transform chain that moves the panels themselves
   * (kinematics.worldPointForPanel — Rodrigues rotation about each hinge,
   * composed innermost-first; the identical math backing PanelTree's scene
   * graph and audit.ts's closure/isometry checks). Each panel's flat-sheet
   * bbox corners are pushed through that chain at the CURRENT `t`, and we
   * take the live axis-aligned bounds of the result. This has no
   * dependency on which panel is "root" or what the dieline's shape is —
   * any panel topology produces a valid live bbox — so the anchor tracks
   * the fold in real time and always sits at the true (min-x, min-y,
   * max-z) corner of whatever is actually on screen right now, offset
   * outward by a fixed margin so the arrows point away from, never
   * through, the box's own volume. */
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

  /** Crossfades the L/H/D callouts in as the box finishes closing, instead
   * of a hard visibility flip — one continuous motion, no pop. */
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

  // A shallow angle against the sheet's long (L) axis grazes every long
  // panel edge-on and foreshortens it into a thin diagonal streak — bias
  // the default view toward the shorter H/D axes instead, closer to a
  // classic 3/4 product-shot angle. Shared by both the wide (flat-sheet-fit)
  // and tight (closed-box-fit) framings so zooming between them reads as
  // one continuous push-in, not a cut to a different angle.
  private static readonly VIEW_DIR = new THREE.Vector3(0.55, -0.95, 1.25).normalize();

  private frameCameraAt(cx: number, cy: number, cz: number, radius: number, multiplier: number): CameraTarget {
    // Distance needed for a perspective camera of this FOV to fit a sphere
    // of `radius`: distance >= radius / sin(FOV/2). A tighter multiplier
    // here clips/distorts geometry near the frame edges under a wide FOV.
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

    // Frame for whichever is larger: the closed box's own bounding sphere,
    // or the flat sheet's footprint (every panel lives at t=0 too, and the
    // flat sheet is usually much wider than the folded result) — otherwise
    // the flat state opens badly cropped by a camera sized only for the
    // closed box.
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

  /** Same centre as computeDefaultCamera, but framed to the closed box's
   * own bounding sphere ONLY — no flat-sheet allowance — so the box fills
   * noticeably more of the viewport once folding finishes. */
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
