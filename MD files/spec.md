# spec.md — FoldLab

**Product:** FoldLab — a browser app that reads a 2D packaging dieline and folds it into a closed 3D
carton, with the underlying geometry visible throughout.
**Version:** 1.0
**Status:** Ready to build

---

## 1. Problem

A dieline is the flat cutting layout of a folding carton: an outer cut contour plus interior crease
lines that mark where the board hinges. A structural designer reads one and knows what box it makes.
Software mostly does not — it renders the artwork but has no model of the fold.

FoldLab closes that gap in the browser: upload a dieline, and it recovers the panel topology, builds
the 3D carton, and animates the fold so the relationship between flat and closed is visible rather
than asserted.

## 2. Scope

**In scope**
- Vector dieline ingest: PDF and SVG.
- Raster ingest (PNG/JPG) as face artwork only.
- Cut / crease / perforation classification.
- Panel recovery, hinge graph, fold tree, dihedral solver.
- Continuous, scrubbable fold animation from flat to closed.
- Orbit / rotate / zoom / pan.
- On-screen coordinate system, axes, dimensions, hinge vectors, live angles.
- Self-audit: closure residual, isometry check, perimeter identity.

**Out of scope (v1)**
- Editing or authoring dielines.
- Curved, conical, or gusseted panels (planar rectangles and simple polygons only).
- Board thickness simulation beyond an optional 0.4 mm extrude.
- Physical collision response between panels.
- Export to STEP / OBJ / glTF.
- Server-side anything. FoldLab is fully client-side.

## 3. Users

| User | Need | Success looks like |
|---|---|---|
| Structural packaging designer | Sanity-check a dieline before cutting a sample | Sees the box close and the closure residual read < 0.5 mm |
| Brand / marketing | Preview a carton without a prototype | Rotates a clean 3D box in under 15 seconds from upload |
| Engineer evaluating the build | Confirm the fold logic is understood, not borrowed | Reads the fold schedule and hinge math directly on screen |

## 4. Functional requirements

### FR-1 — Upload
- Drag-and-drop zone and a file picker. Both accept `.pdf`, `.svg`, `.png`, `.jpg`, `.jpeg`.
- A "Load the sample carton" action loads the bundled `sample_dieline.pdf`.
- Files above 2 MB are parsed in a Web Worker; the UI stays responsive and shows progress.
- Unsupported or corrupt files produce a specific, actionable message and leave the app usable.

### FR-2 — Parse
- Extract every stroked path as a list of straight segments; flatten cubic Béziers at 0.05 mm
  chord tolerance.
- Convert all coordinates to millimetres. PDF: `mm = pt / 2.834645669`. SVG: resolve `viewBox` and
  unit suffixes.
- Normalise to a Y-up frame with the origin at the artwork's bottom-left, exactly once, in the
  extractor.
- Classify each segment as `cut`, `crease`, or `perf` using the ranked strategy in §6.2.
- Snap endpoints to a 0.25 mm grid.

### FR-3 — Build
- Recover panels using the lattice + union-find decomposition (§6.3).
- Build the hinge graph, spanning tree, and fold schedule (§6.4, §6.5).
- Instantiate one Three.js pivot/mesh pair per panel, parented along the tree (§6.6).

### FR-4 — Fold and close
- One global parameter `t ∈ [0, 1]` drives every panel. Nothing animates independently of `t`.
- Default fold duration 5 s, staggered by tree depth, `easeInOutCubic`.
- The motion is continuous and never cuts between states.
- Play, pause, reset, and reverse are all available.

### FR-5 — View
- Orbit, zoom, pan via mouse, trackpad, and touch.
- Damped controls, clamped polar angle, sensible zoom limits (no clipping into the box).
- "Fit to view" reframes the box.

### FR-6 — Mathematics on screen
- World XYZ triad with labelled, billboarded arrows.
- Millimetre ground grid: 10 mm minor, 50 mm major.
- Per-panel local frames (toggleable).
- Live hinge axis vectors and dihedral angles for panels currently in motion.
- Dimension callouts on the closed box: `L`, `H`, `D` with leader lines.
- A linked 2D dieline view with millimetre rulers, colour-coded line types, and hover readouts of
  each panel's `x, y, w, h, area`.
- Cross-highlighting: the panel folding in 3D lights up in 2D at the same instant.

### FR-7 — Scrub
- A slider bound directly to `t`, draggable in both directions, with the numeric value shown.
- Keyboard: `Space` play/pause, `←` / `→` step `t` by 0.02, `R` reset.

### FR-8 — Audit
A collapsible drawer showing:
- Parsed counts: segments, cuts, creases, perforations, panels — measured against expected.
- Which classification strategy fired.
- Derived `L × H × D`.
- The perimeter identity with live numbers.
- Closure residual in mm at `t = 1`, with pass/warn state.
- Isometry drift across the animation.

### FR-9 — Artwork mode
- A raster upload becomes a face texture, not geometry.
- With geometry already loaded, it is UV-mapped onto the panels.
- Without geometry, the app shows the flat textured sheet and states plainly that cut and crease
  data are needed to fold.

## 5. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | 60 fps during the fold on a mid-range 2022 laptop; no frame over 33 ms. |
| NFR-2 | Sample PDF parses end-to-end in under 400 ms on that machine. |
| NFR-3 | Zero console errors or warnings on load, upload, or animation. |
| NFR-4 | `tsc --noEmit` and `vite build` both clean. TypeScript `strict`, no `any`. |
| NFR-5 | Usable at 390 px width. Layout collapses, no horizontal scroll. |
| NFR-6 | Visible keyboard focus on every interactive control; full keyboard operation. |
| NFR-7 | `prefers-reduced-motion: reduce` removes transitions; the fold remains scrubbable. |
| NFR-8 | No browser storage APIs. No network calls after initial asset load. |
| NFR-9 | Latest Chrome, Firefox, Safari, Edge. Graceful fallback where `backdrop-filter` is absent. |
| NFR-10 | Every WebGL resource disposed on unmount; HMR does not leak contexts. |

## 6. Technical specification

### 6.1 Data model

```ts
type Vec2 = { x: number; y: number };            // millimetres, Y-up
type LineKind = 'cut' | 'crease' | 'perf';

interface Segment { a: Vec2; b: Vec2; kind: LineKind; source: string }

interface Panel {
  id: string;
  polygon: Vec2[];        // CCW, collinear vertices collapsed
  bbox: { x: number; y: number; w: number; h: number };
  area: number;           // mm²
  role: PanelRole;        // assigned by the solver
}

type PanelRole = 'wall' | 'endClosure' | 'tuck' | 'lock' | 'glue' | 'unknown';

interface Hinge {
  id: string;
  panelA: string;
  panelB: string;
  axisPoint: Vec2;        // a point on the crease line
  axisDir: Vec2;          // unit vector along the crease
  length: number;         // mm
  kind: LineKind;
}

interface FoldEdge {
  hinge: Hinge;
  parent: string;
  child: string;
  targetAngle: number;    // radians, negative = folds inward
  depth: number;
  start: number;          // stagger start in normalised time
  duration: number;
}

interface FoldSchedule {
  root: string;
  edges: FoldEdge[];
  nonTreeHinges: Hinge[]; // closure constraints, measured not driven
  dims: { L: number; H: number; D: number };
}
```

### 6.2 Line classification

Strategies are tried in order; the first that yields at least one crease wins. The app records and
displays which one fired.

1. **Named colorspace or layer.** Decode PDF name escapes (`#20` → space) and lowercase, then match
   substrings:
   - cut: `schneiden`, `cut`, `cutline`, `die`, `contour`, `thru-cut`
   - crease: `rillen`, `crease`, `score`, `fold`, `rill`
   - perf: `rill-schnitt`, `perf`, `perforation`, `zipper`
2. **Stroke hue.** cut ≈ red (`h < 20°` or `h > 340°`), crease ≈ green (`90° < h < 160°`),
   perf ≈ blue (`200° < h < 260°`), with loose saturation and value tolerance.
3. **Topology.** The longest closed loop is the cut contour; interior segments lying wholly inside
   it are creases.

### 6.3 Panel decomposition

```
1. Snap every endpoint to a 0.25 mm grid.
2. Take unique X and unique Y values from all straight segments → an (n × m) cell lattice.
3. Discard lattice cells thinner than 0.4 mm in either axis (chamfer slivers).
4. A cell is material if its centre is inside the cut contour, tested by even-odd ray casting
   in +X against cut segments only.
5. Union-find merge orthogonally adjacent material cells whose shared edge is not covered by any
   cut, crease, or perforation segment.
6. Each union set is a panel. Discard panels under 3 mm².
7. Trace each panel's cell boundary; collapse collinear vertices to get its polygon.
```

This algorithm has been run against the sample file and reproduces the table in §7.2 exactly.

### 6.4 Hinge graph

- Panels A and B are hinged when they share a crease or perforation segment of length ≥ 5 mm.
- Root = the largest-area panel.
- BFS from the root produces the spanning tree; `depth` is the BFS depth.
- Remaining edges are cycle-closing constraints. They are **measured** at `t = 1` to produce the
  closure residual, never used to drive motion.
- If the graph is disconnected, orphaned panels are listed in the audit drawer rather than dropped.

### 6.5 Fold solver

| Panel situation | Target dihedral |
|---|---|
| Consecutive walls in the wall chain | −90° |
| End closure (`w ≈ D`, `h ≈ H`, hinged to a wall's short edge) | −90° |
| Tuck hinged to an end closure | −90° |
| Lock or glue flap | −90°, folded flat against its parent |

Sign convention: negative rotates toward the box interior (`−Z` in the root's local frame).

The wall chain is identified by walking the longest chain of large panels through the root and
testing whether their perpendicular widths satisfy `Σw = 2(a + b)` for some pair `(a, b)` drawn
from the chain's own widths. That check is what turns a pile of rectangles into a tube.

Per-panel timing: `start = depth × 0.12`, `duration = 0.55`, both in normalised time; clamp to
`[0, 1]`.

### 6.6 Fold transform

Each panel is a `pivot` Group positioned on its hinge line and oriented so the hinge direction is
local `+X`, containing a mesh offset by the negated hinge origin. Children are added to the parent's
pivot. Folding is then `pivot.rotation.x = θ(t)`.

```
M_child(t) = M_parent(t) · T(a) · R(û, θ(t)) · T(−a)

a    = point on the hinge line, in parent-local coordinates
û    = unit hinge direction
θ(t) = θ_target · easeInOutCubic( clamp((t − start) / duration, 0, 1) )
```

Because every rotation axis lies in both the parent and child planes, the shared edge is fixed
pointwise under the rotation. The fold is therefore a rigid isometry for all `t`: no edge length
changes, no panel stretches, and connectivity cannot break.

### 6.7 Rendering

- `MeshPhysicalMaterial`, `side: THREE.DoubleSide`, `roughness: 0.72`, `clearcoat: 0.18`.
- Interior faces tinted darker than exterior so the inside of the carton reads correctly.
- Three-point lighting plus a low-intensity environment for the clearcoat to catch.
- `renderer.outputColorSpace = THREE.SRGBColorSpace`,
  `renderer.toneMapping = THREE.ACESFilmicToneMapping`.
- `setPixelRatio(Math.min(devicePixelRatio, 2))`.
- Optional 0.4 mm extrude for board thickness, off by default.

## 7. The reference file

### 7.1 What was measured

`sample_dieline.pdf` — PDF 1.4, one page, 966.814 × 978.779 pt = **341.07 × 345.28 mm**. No fonts,
no raster images. **88 stroked segments: 76 straight, 12 cubic Bézier.**

Line function is encoded by `/Separation` colorspace, not by RGB:

| Colorspace | Meaning | Role | Count |
|---|---|---|---|
| `/Schneiden` | cut | `cut` | 70 (58 line, 12 curve) |
| `/Rillen` | crease / score | `crease` | 17 |
| `/Rill-Schnitt 10x10` | crease-cut 10×10 | `perf` | 1 |

After normalising by −0.035 mm in X and −0.256 mm in Y, every vertex lands on an exact millimetre
grid, which is why a 0.25 mm snap tolerance is safe.

### 7.2 Recovered panels

Origin bottom-left, Y-up, millimetres.

| ID | x | y | w | h | Area (mm²) | Role |
|---|---|---|---|---|---|---|
| `P_FRONT` | 93.5 | 124 | 154 | 95 | 14 630 | wall — fold-tree root |
| `P_BACK` | 93.5 | 236 | 154 | 95 | 14 630 | wall |
| `P_SIDE_A` | 93.5 | 219 | 154 | 17 | 2 618 | wall |
| `P_SIDE_B` | 93.5 | 108 | 154 | 16 | 2 402 | wall |
| `P_TAB_TOP` | 139.5 | 331 | 62 | 14 | 854 | tuck |
| `P_END_L` | 77 | 124 | 16.5 | 95 | 1 568 | endClosure |
| `P_END_R` | 247.5 | 124 | 16.5 | 95 | 1 568 | endClosure |
| `P_TUCK_L` | 0 | 124 | 77 | 91 | 7 015 | tuck (2 mm corner chamfers) |
| `P_TUCK_R` | 264 | 126 | 77 | 91 | 7 007 | tuck (2 mm corner chamfers) |
| `P_LOCK_1` | 93.5 | 68 | 153 | 40 | 5 849 | lock |
| `P_LOCK_2` | 94.5 | 52 | 152 | 16 | 1 559 | lock — split into 3 cells by a Ø10.6 mm thumb notch |
| `P_LOCK_3` | 94.5 | 23 | 152 | 29 | 2 994 | lock |
| `P_GLUE_1` | 94.5 | 7 | 51 | 16 | 776 | glue |
| `P_GLUE_2` | 94.5 | 0 | 43 | 7.2 | 311 | glue |

**14 panels.**

### 7.3 The closure identity

The four wall panels form one chain through the root:

```
P_SIDE_B (16) — P_FRONT (95) — P_SIDE_A (17) — P_BACK (95)

16 + 95 + 17 + 95 = 223 mm
2 × (95 + 16.5)   = 223 mm    ✓ exact
```

The carton is a rectangular tube of cross-section 95 × 16.5 mm and length 154 mm.

**Derived box: L = 154, H = 95, D = 16.5 mm.**

The 17 / 16 asymmetry is caliper compensation in the real die — the outer wall travels around the
board thickness of the inner one. Take `D = (17 + 16) / 2 = 16.5`, and show both the measured pair
and the reconciled value rather than averaging silently.

Independent cross-check: the end closures measure `16.5 × 95 = D × H`, exactly the tube's end
opening. If the parse is wrong, this identity fails. Assert it and surface the result.

### 7.4 Simplifications, stated openly

The sample is a real production carton and carries features the fold model does not simulate: a
snap-lock bottom assembly, a thumb notch, a perforated tear line, and 2 mm corner chamfers. FoldLab
parses and renders all of that geometry faithfully, then folds the lock and glue panels flat against
their parents rather than interlocking them. The brief permits reasonable assumptions about box
type; this is the assumption, and it is worth naming out loud during the walkthrough rather than
hiding.

## 8. Acceptance criteria

- [ ] `npx tsc --noEmit` clean; `npm run build` clean.
- [ ] Console empty on load, upload, and through a full fold cycle.
- [ ] Sample parses to 14 panels, 17 creases, 1 perforation.
- [ ] Derived dimensions read 154 × 95 × 16.5 mm.
- [ ] Perimeter identity displays `223 = 223 ✓`.
- [ ] Closure residual at `t = 1` is under 0.5 mm.
- [ ] Isometry drift under 1e-6 across the animation.
- [ ] Fold runs 4–6 s, staggered, continuous, and scrubs cleanly both directions.
- [ ] Orbit / zoom / pan on mouse and touch.
- [ ] Sample PNG shows artwork mode without crashing.
- [ ] Corrupt PDF shows a readable error and the app stays usable.
- [ ] Responsive to 390 px; focus visible; reduced motion respected.
- [ ] 60 fps sustained during the fold.

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| A dieline uses neither named layers nor colour coding | No creases found, nothing folds | Topological fallback (§6.2 strategy 3), plus an explicit message naming what is missing |
| Non-rectangular or curved panels | Lattice decomposition degrades | v1 scope excludes them; detect and warn rather than produce a wrong box |
| Fold graph has more cycles than expected | Over-constrained solve | Only the spanning tree drives motion; extra edges become measurements |
| Panels intersect mid-fold | Visual glitch | Depth-staggered timing avoids it on the sample; no collision solver in v1 |
| `backdrop-filter` unsupported | Glass reads flat | `@supports` fallback to an opaque tinted panel |
| pdf.js worker misconfigured | Blank screen | Explicit `?url` worker import; smoke test in CI |
