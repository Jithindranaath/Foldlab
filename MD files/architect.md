# architect.md — FoldLab

System architecture, module boundaries, and the implementation patterns that keep the build
error-free. Read `context.md` first for the reasoning behind these choices.

---

## 1. Shape of the system

FoldLab is a fully client-side single-page app. No server, no persistence, no network after the
initial asset load. Everything happens in one tab.

```
 file ──► EXTRACT ──► CLASSIFY ──► PANELS ──► GRAPH ──► SOLVER ──► SCENE ──► RENDER
          (pdf/svg)   (cut/       (lattice+  (hinges,  (dihedral  (pivot
                       crease/     unionfind) spanning   targets,   tree)
                       perf)                  tree)      timing)
                                        │                   │           │
                                        └──────────► AUDIT ◄┘           │
                                                       │                │
                                                       ▼                ▼
                                                  audit drawer      2D + 3D views
```

Three layers, and the boundaries between them are load-bearing:

| Layer | Directory | Imports | Purpose |
|---|---|---|---|
| **Core** | `src/core/` | nothing but TS stdlib | All geometry and fold mathematics. Pure functions on plain data. |
| **Scene** | `src/three/` | `three`, `src/core` types | Turns a `FoldSchedule` into a scene graph and drives it from `t`. |
| **UI** | `src/ui/`, `src/state/` | React, framer-motion, zustand | Chrome, controls, readouts. Owns no geometry. |

**Core must never import React or Three.** This is the rule that makes the fold logic testable in
isolation and demonstrable during the code walkthrough. If a core module needs a vector type, it
defines its own `Vec2`; it does not reach for `THREE.Vector2`.

## 2. Directory layout

```
foldlab/
├── public/
│   └── samples/sample_dieline.pdf
├── src/
│   ├── core/
│   │   ├── types.ts             Vec2, Segment, Panel, Hinge, FoldEdge, FoldSchedule
│   │   ├── units.ts             PT_PER_MM, snap(), EPS constants
│   │   ├── bezier.ts            adaptive cubic flattening (0.05 mm chord tolerance)
│   │   ├── extract/
│   │   │   ├── index.ts         format sniffing → dispatch
│   │   │   ├── pdf.ts           pdf.js operator-list walk
│   │   │   ├── svg.ts           DOM walk + viewBox/unit resolution
│   │   │   └── raster.ts        PNG/JPG → ImageBitmap for artwork mode
│   │   ├── classify.ts          three ranked strategies
│   │   ├── panels.ts            lattice + union-find decomposition
│   │   ├── graph.ts             hinge detection, BFS spanning tree
│   │   ├── solver.ts            roles, dihedral targets, timing → FoldSchedule
│   │   └── audit.ts             closure residual, isometry, perimeter identity
│   ├── three/
│   │   ├── Viewport.ts          renderer, camera, OrbitControls, RAF loop, disposal
│   │   ├── PanelTree.ts         builds the pivot hierarchy; setFoldParameter(t)
│   │   ├── Materials.ts         board material, interior tint, edge lines
│   │   ├── Axes.ts              world triad + per-panel local frames
│   │   ├── Grid.ts              millimetre ground grid
│   │   ├── HingeOverlay.ts      axis vectors, dihedral arcs, angle labels
│   │   └── Dimensions.ts        L/H/D callouts with leader lines
│   ├── ui/
│   │   ├── App.tsx              layout shell
│   │   ├── TopBar.tsx           filename, audit toggle, actions
│   │   ├── Dropzone.tsx         drag-drop, picker, sample loader, errors
│   │   ├── DielineView.tsx      2D SVG with rulers and hover readouts
│   │   ├── PanelList.tsx        parsed panels with roles and dimensions
│   │   ├── FoldLedger.tsx       signature HUD: live hinge axes and angles
│   │   ├── Scrubber.tsx         t slider, transport, keyboard
│   │   └── AuditDrawer.tsx      counts, identities, residual, isometry
│   ├── state/store.ts           zustand: file, schedule, t, playing, toggles, error
│   ├── workers/parse.worker.ts  runs extract→solver off the main thread
│   ├── styles/
│   │   ├── tokens.css           colour, type, spacing custom properties
│   │   ├── glass.css            the .glass recipe and its @supports fallback
│   │   └── app.css              layout, responsive, focus, reduced motion
│   └── main.tsx
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## 3. Dependencies — pin these exact majors

```json
{
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "three": "^0.169.0",
    "pdfjs-dist": "^4.6.82",
    "framer-motion": "^11.5.4",
    "zustand": "^4.5.5"
  },
  "devDependencies": {
    "@types/react": "^18.3.5",
    "@types/react-dom": "^18.3.0",
    "@types/three": "^0.169.0",
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.5.4",
    "vite": "^5.4.2",
    "vitest": "^2.0.5"
  }
}
```

`tsconfig.json` runs `strict: true`, `noUncheckedIndexedAccess: true`,
`noUnusedLocals: true`, `noUnusedParameters: true`, `moduleResolution: "bundler"`. No `any`
anywhere; use `unknown` plus a narrowing guard at every external boundary (file input, pdf.js
operator arguments, DOM attributes).

## 4. Core pipeline

### 4.1 Extract

`extract/index.ts` sniffs the format by magic bytes, not by file extension:

```
%PDF        → pdf.ts
<?xml / <svg → svg.ts
\x89PNG, \xFF\xD8 → raster.ts
otherwise   → UnsupportedFormatError
```

**PDF.** Use `page.getOperatorList()` rather than rendering. Walk the operator stream maintaining
a CTM stack:

- `OPS.save` / `OPS.restore` → push/pop the transform stack.
- `OPS.transform` → multiply into the current CTM.
- `OPS.setStrokeColorSpace` / `OPS.setStrokeColorN` → record the active stroke colorspace name and
  the resolved RGB. Keep both; classification wants the name first and the colour as fallback.
- `OPS.constructPath` → decode the packed `[ops[], args[]]` pair into `moveTo` / `lineTo` /
  `curveTo` / `closePath` and emit segments under the current CTM.

Decode PDF name escapes before comparing: `Rill-Schnitt#2010x10` → `Rill-Schnitt 10x10`.

Convert to millimetres in the extractor (`mm = pt / 2.834645669`) and flip to a Y-up frame with the
origin at the artwork bounding box's bottom-left. **This is the only place either operation
happens.** Everything downstream is millimetres, Y-up.

**SVG.** Parse with `DOMParser`, resolve `viewBox` against `width`/`height` including unit suffixes
(`mm`, `cm`, `in`, `pt`, `px` at 96 dpi), then walk `path`, `line`, `polyline`, `polygon`, `rect`.
Collect `stroke` plus layer hints from `id`, `class`, and `inkscape:label`. SVG is Y-down, so flip
once here too.

**Béziers.** Flatten adaptively: subdivide while the control-point deviation from the chord exceeds
0.05 mm, capped at 8 levels of recursion so a degenerate curve cannot hang the parser.

### 4.2 Classify

Three strategies, tried in order, first one producing ≥ 1 crease wins. Record which fired and show
it in the audit drawer.

1. Named colorspace or layer — substring match against the dictionaries in `spec.md` §6.2.
2. Stroke hue — red/green/blue bands with loose saturation tolerance.
3. Topology — longest closed loop is the cut contour; interior segments are creases.

### 4.3 Panels

The lattice + union-find algorithm in `spec.md` §6.3. Notes that matter in implementation:

- Snap **before** building the lattice, or float noise creates thousands of one-micron columns.
- Discard lattice cells thinner than 0.4 mm before the inside test — those are chamfer slivers and
  they will otherwise fragment real panels.
- Even-odd ray casting must run against **cut segments only**. Including creases inverts the
  inside/outside parity and yields a hollow sheet.
- Cast the ray in `+X` from the cell centre. Cell centres never land exactly on a segment because
  they are half-way between lattice lines, so no degenerate-crossing handling is needed.
- Boundary tracing: walk the union set's outer cell edges, then collapse vertices whose incoming and
  outgoing directions are parallel within 1e-9.

Verified: this reproduces all 14 panels of the sample exactly.

### 4.4 Graph

- Two panels are hinged when they share a collinear crease or perforation segment of length ≥ 5 mm.
  Compute the shared span by projecting both panels' boundary edges onto the crease line and
  intersecting the intervals.
- Root = maximum area. BFS assigns parent, child, and depth.
- Non-tree edges go into `nonTreeHinges` — measured by the audit, never driven.
- Assert connectivity. Disconnected panels are reported, not dropped.

### 4.5 Solver

Assign roles, then dihedral targets, per `spec.md` §6.5. The wall chain is identified by walking the
longest chain of large panels through the root and testing the perimeter identity
`Σw = 2(a + b)` against widths drawn from the chain itself. On the sample this resolves to
`16 + 95 + 17 + 95 = 223 = 2 × (95 + 16.5)` and yields `L = 154, H = 95, D = 16.5`.

Timing: `start = depth × 0.12`, `duration = 0.55`, clamped into `[0, 1]`.

Output is a `FoldSchedule` — plain data. The UI renders it as a table. Nothing about the fold is
hidden in imperative code.

## 5. Scene construction — the pivot pattern

The single most important implementation detail. Do **not** compose matrices by hand each frame.

For each panel, build two nested objects:

```ts
// pivot sits ON the hinge line, expressed in the PARENT's local space
const pivot = new THREE.Group();
pivot.position.set(hinge.axisPoint.x, hinge.axisPoint.y, 0);
pivot.quaternion.setFromUnitVectors(
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(hinge.axisDir.x, hinge.axisDir.y, 0).normalize()
);

// mesh is offset back so the panel lands in its true flat position
const mesh = new THREE.Mesh(panelGeometry, boardMaterial);
mesh.position.set(-hinge.axisPoint.x, -hinge.axisPoint.y, 0);
mesh.applyQuaternion(pivot.quaternion.clone().invert());

pivot.add(mesh);
parentPivot.add(pivot);
```

Folding is then one scalar per panel:

```ts
pivot.rotation.x = edge.targetAngle * easeInOutCubic(
  clamp((t - edge.start) / edge.duration, 0, 1)
);
```

Children ride along automatically because they are descendants. That is the whole trick.

The formal statement, kept in a comment beside the code and rendered in the Fold Ledger:

```
M_child(t) = M_parent(t) · T(a) · R(û, θ(t)) · T(−a)

a    = a point on the hinge line, in parent-local coordinates
û    = the unit hinge direction
θ(t) = θ_target · easeInOutCubic( clamp((t − start) / duration, 0, 1) )
```

Because `û` lies in both the parent and child planes and passes through `a`, the shared edge is
fixed pointwise for every `θ`. The fold is therefore a rigid isometry: edge lengths are invariant,
panels never stretch, and connectivity cannot break. `audit.ts` measures this and it should read
below 1e-6.

**Single source of truth for time.** `PanelTree.setFoldParameter(t)` recomputes every pivot rotation
from `t` on each call. No panel holds its own animation state. This is why scrubbing backwards works
and why play/pause/reset can never desynchronise.

## 6. Rendering

```ts
renderer.outputColorSpace = THREE.SRGBColorSpace;      // r152+; outputEncoding is gone
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
```

- Board: `MeshPhysicalMaterial`, `side: THREE.DoubleSide`, `roughness: 0.72`, `clearcoat: 0.18`.
  Without `DoubleSide`, half the panels disappear once folded.
- Interior faces get a darker tint so the inside of the carton reads differently from the outside.
- Three-point lighting plus a low-intensity environment for the clearcoat to catch.
- `OrbitControls` imported as `three/examples/jsm/controls/OrbitControls.js` — **with** the `.js`
  extension. The extensionless path fails under Vite's ESM resolution.
- Camera framing: compute the schedule's bounding sphere and dolly to fit with a 1.25 margin.

## 7. State

Zustand, one store, flat:

```ts
interface AppState {
  fileName: string | null;
  status: 'idle' | 'parsing' | 'ready' | 'artworkOnly' | 'error';
  error: { title: string; detail: string } | null;
  schedule: FoldSchedule | null;
  audit: AuditReport | null;
  t: number;
  playing: boolean;
  hoveredPanel: string | null;
  show: { axes: boolean; grid: boolean; frames: boolean; dims: boolean };
}
```

React owns `t` as the source of truth. The RAF loop advances `t` while `playing` and pushes it into
`PanelTree.setFoldParameter`. The Scrubber writes `t` directly. Both paths converge on the same
setter, so there is exactly one way `t` changes.

The 3D scene is **not** re-created on state changes. `Viewport` mounts once; `PanelTree` is rebuilt
only when `schedule` changes identity.

## 8. Worker boundary

Files over 2 MB parse in `workers/parse.worker.ts`. The worker runs extract → classify → panels →
graph → solver and posts back a structured-cloneable `FoldSchedule` (plain objects and numbers
only — no class instances, no functions). The main thread builds the scene from it.

Below the threshold, the same pipeline runs inline. Identical code path, different host, so there is
only one implementation to keep correct.

## 9. UI architecture

```
┌──────────────────────────────────────────────────────────────┐
│  ◇ FOLDLAB           file.pdf            [ Audit ▾ ]  [ ⌘K ] │  glass top bar
├───────────────┬──────────────────────────────────────────────┤
│  2D DIELINE   │            3D VIEWPORT                       │
│  glass card   │            full-bleed canvas                 │
│  legend       │      ┌────────────────────┐                  │
│  panel list   │      │  FOLD LEDGER       │  floating glass  │
│               │      └────────────────────┘                  │
├───────────────┴──────────────────────────────────────────────┤
│  FLAT ●─────────────────────────○ CLOSED        t = 0.62     │  glass scrubber
│  [▶ Fold] [↺ Reset] [◱ Frames] [◈ Grid] [⛶ Fit]              │
└──────────────────────────────────────────────────────────────┘
```

Below 900 px the layout stacks and the 2D dieline becomes a bottom sheet. The canvas always keeps
the majority of the viewport.

**Glass recipe** (`styles/glass.css`):

```css
.glass {
  background: linear-gradient(180deg, var(--glass-hi) 0%, var(--glass) 42%);
  backdrop-filter: blur(22px) saturate(170%);
  -webkit-backdrop-filter: blur(22px) saturate(170%);
  border: 1px solid var(--hairline);
  border-radius: 18px;
  box-shadow:
    0 1px 0 0 rgba(255,255,255,0.09) inset,
    0 18px 48px -12px rgba(0,0,0,0.65),
    0 2px 8px -2px rgba(0,0,0,0.40);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .glass { background: rgba(12, 18, 32, 0.92); }
}
```

Glass only reads as glass when there is something behind it, so a slow ambient gradient sits behind
the canvas and the panels overlap the live 3D view rather than sitting in gutters beside it.

**Motion rules.** Animate `transform` and `opacity` only. Never animate `backdrop-filter`,
`box-shadow`, `filter`, or `border-radius` — each forces a repaint of the blurred backdrop and will
visibly stutter over a 60 fps canvas. Framer Motion drives UI chrome exclusively; the 3D scene runs
on its own RAF loop and is never touched by React render cycles.

## 10. Error handling

Every failure has a named type, a title, and a fix. No bare `throw new Error(msg)`.

| Condition | Message |
|---|---|
| Unrecognised format | "FoldLab reads PDF and SVG dielines. This file is *(type)*." |
| PDF has no vector paths | "This PDF has no line work — it may be a scan. Upload the vector original." |
| Cuts but no creases | "That dieline has cut lines but no crease lines. FoldLab needs creases to know where the card hinges." |
| Fewer than 2 panels | "Only one panel was found. The crease lines may be on a layer FoldLab didn't recognise." |
| Disconnected graph | "*(n)* panels aren't connected to the rest of the sheet. They're listed below and won't fold." |
| Raster, no geometry loaded | "This image has no cut or crease data. Upload the PDF or SVG to fold it." |
| WebGL unavailable | "This browser can't start WebGL. The 2D dieline view still works." |

Errors state what happened and what to do. They do not apologise and they are never vague. The app
stays usable after every one of them.

## 11. Pitfalls — all of these have a known failure signature

1. **pdf.js worker.** Misconfiguration gives a silent blank screen with no error.
   ```ts
   import * as pdfjsLib from 'pdfjs-dist';
   import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
   pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
   ```
2. **Y-axis flip.** PDF is Y-up, SVG and canvas are Y-down. Flip once, in the extractor. Flipping
   twice mirrors the sheet, which folds inside-out and looks almost right — the worst kind of bug.
3. **Units.** `mm = pt / 2.834645669`, applied in the extractor and nowhere else.
4. **OrbitControls path.** `three/examples/jsm/controls/OrbitControls.js`, with the extension.
5. **Colour management.** `outputColorSpace`, not the removed `outputEncoding`.
6. **DoubleSide.** Panels are planes. Without it, half of them vanish after folding.
7. **Pixel ratio.** Clamp to 2 or a 3× phone display will tank the frame rate.
8. **Resize.** `ResizeObserver` on the container, not `window.onresize`. Update `camera.aspect`,
   call `updateProjectionMatrix()`, and `renderer.setSize`.
9. **Cleanup.** Dispose geometries, materials, textures, call `renderer.dispose()`, and cancel the
   RAF in the effect teardown. Otherwise Vite HMR leaks a WebGL context per save until the browser
   refuses to create more.
10. **No browser storage.** No `localStorage`, no `sessionStorage`, anywhere.
11. **Float comparison.** 0.25 mm epsilon for snapping, 1e-6 for isometry. Never `===` on a
    coordinate.
12. **PDF name escapes.** `#20` is a space. Decode before matching colorspace names.
13. **Cyclic fold graph.** Fold the spanning tree; measure the rest.
14. **Short hinges.** Filter creases under 5 mm before building the graph or spurious hinges appear
    at chamfer corners.
15. **Worker payloads.** Structured clone only. A `FoldSchedule` containing a class instance or a
    function will throw a `DataCloneError`.
16. **`noUncheckedIndexedAccess`.** Array indexing yields `T | undefined`. Guard it; do not silence
    it with `!`.

## 12. Testing

`vitest`, targeting `src/core/` only — pure functions, no DOM, fast.

| Test | Asserts |
|---|---|
| `units` | `pt → mm` round-trips within 1e-9 |
| `bezier` | flattened polyline stays within 0.05 mm of the analytic curve |
| `extract.pdf` | sample yields 88 segments: 70 cut, 17 crease, 1 perf |
| `classify` | all three strategies resolve correctly on synthetic inputs |
| `panels` | sample yields exactly the 14 panels in `spec.md` §7.2 |
| `graph` | root is `P_FRONT`; graph is connected; wall chain has 4 members |
| `solver` | perimeter identity holds; dims are 154 / 95 / 16.5 |
| `audit` | closure residual < 0.5 mm; isometry drift < 1e-6 |

The sample PDF is the golden fixture. If any of these fail, the parse is wrong regardless of how the
render looks.

## 13. Performance budget

| Stage | Budget |
|---|---|
| Extract + classify | 120 ms |
| Panels + graph + solver | 80 ms |
| Scene build | 60 ms |
| First paint after drop | < 400 ms |
| Frame time during fold | < 16 ms |

Fourteen panels is a trivial scene; the budget exists so it stays trivial. If a future dieline
produces hundreds of panels, merge coplanar geometry and switch the hinge overlay to instanced
lines before anything else.
