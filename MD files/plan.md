# plan.md — FoldLab

Build order, checkpoints, and exit criteria. Nine phases, roughly 16–20 focused hours. Each phase
ends in something verifiable — do not start the next one until the current gate passes.

The sequencing rule: **prove the geometry before building any interface.** The panel table is the
foundation; a beautiful UI over a wrong parse is worth nothing, and the fold logic is what actually
gets graded.

---

## Phase 0 — Scaffold · 45 min

- `npm create vite@latest foldlab -- --template react-ts`
- Install the pinned dependencies from `architect.md` §3.
- `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`,
  `moduleResolution: "bundler"`.
- Create the full directory tree from `architect.md` §2 with stub files.
- Copy `sample_dieline.pdf` into `public/samples/`.
- Wire the pdf.js worker (`architect.md` §11 item 1) and log a page count to prove it resolves.

**Gate:** `npm run dev` serves a blank page. `npx tsc --noEmit` is clean. The console prints
`pages: 1` for the sample PDF.

---

## Phase 1 — Extraction · 2 h

- `core/units.ts` — `PT_PER_MM = 2.834645669`, `snap()`, epsilon constants.
- `core/bezier.ts` — adaptive cubic flattening, 0.05 mm chord tolerance, recursion capped at 8.
- `core/extract/pdf.ts` — operator-list walk with a CTM stack, colorspace tracking, PDF name-escape
  decoding, pt → mm, single Y-up flip.
- `core/extract/svg.ts` — DOM walk, `viewBox` and unit resolution, stroke and layer capture.
- `core/extract/index.ts` — magic-byte format sniffing.

**Gate:** extracting the sample returns **88 segments — 76 straight, 12 Bézier before flattening**,
carrying colorspace names `Schneiden`, `Rillen`, `Rill-Schnitt 10x10`. Bounding box measures
**341.07 × 345.28 mm**.

---

## Phase 2 — Classification and panels · 3 h

*This is the highest-risk phase. Budget accordingly.*

- `core/classify.ts` — three ranked strategies, records which fired.
- `core/panels.ts` — snap → lattice → sliver discard → even-odd inside test → union-find merge →
  boundary trace → collinear collapse.
- `vitest` fixture asserting the panel table.

**Gate:** the sample classifies as **70 cut / 17 crease / 1 perf** and decomposes to **exactly the
14 panels in `spec.md` §7.2**, each within 0.25 mm of the listed `x, y, w, h`.

If the count is wrong, stop and fix it here. Every later phase depends on this being right.

Common causes of a wrong count: ray casting against creases as well as cuts (inverts parity);
snapping after building the lattice instead of before; not discarding sub-0.4 mm chamfer slivers.

---

## Phase 3 — Graph and solver · 2.5 h

- `core/graph.ts` — shared-crease detection with interval projection, 5 mm minimum hinge, BFS
  spanning tree, non-tree edges collected separately, connectivity assertion.
- `core/solver.ts` — role assignment, wall-chain detection via the perimeter identity, dihedral
  targets, depth-based timing → `FoldSchedule`.
- `core/audit.ts` — closure residual, isometry drift, perimeter identity, counts.

**Gate:** root resolves to `P_FRONT`. The wall chain is
`P_SIDE_B — P_FRONT — P_SIDE_A — P_BACK`. The identity prints `16 + 95 + 17 + 95 = 223` and
`2 × (95 + 16.5) = 223`. Derived dims read **154 × 95 × 16.5 mm**. End closures verify as
`16.5 × 95 = D × H`. Graph is connected.

At this point the entire fold is solved and nothing has been rendered. That is the intended state.

---

## Phase 4 — 3D scene and the fold · 3 h

- `three/Viewport.ts` — renderer, camera, OrbitControls, RAF loop, `ResizeObserver`, full disposal.
- `three/Materials.ts` — board material with `DoubleSide`, interior tint, edge lines.
- `three/PanelTree.ts` — the pivot pattern, `setFoldParameter(t)` recomputing every rotation from
  `t` alone.
- Temporary `<input type="range">` bound to `t`, no styling.

**Gate:** the sample folds flat → closed and back, smoothly, at 60 fps. Closure residual under
0.5 mm. Isometry drift under 1e-6. Orbit, zoom, and pan work. Console clean. Saving a file during
HMR does not leak a WebGL context.

**This is the milestone that satisfies the brief.** Everything after it is quality, not scope.

---

## Phase 5 — Mathematics overlay · 2 h

- `three/Axes.ts` — world XYZ triad, billboarded labels, per-panel local frames.
- `three/Grid.ts` — 10 mm minor / 50 mm major, distance fade.
- `three/HingeOverlay.ts` — axis vectors, swept dihedral arcs, live degree labels for hinges in
  motion.
- `three/Dimensions.ts` — `L` / `H` / `D` callouts with leader lines on the closed box.

**Gate:** at any `t`, the visible hinge axes and angles match the `FoldSchedule` values. Every
overlay toggles independently and none of them cost more than 2 ms per frame.

---

## Phase 6 — Interface · 4 h

- `styles/tokens.css`, `glass.css`, `app.css` — the token set and glass recipe from
  `architect.md` §9, plus the `@supports` fallback.
- `state/store.ts` — the flat zustand store from `architect.md` §7.
- `Dropzone.tsx` — drag-drop, picker, "Load the sample carton", typed errors.
- `DielineView.tsx` — 2D SVG, millimetre rulers, colour-coded line types, hover readouts,
  cross-highlighting with the 3D view.
- `PanelList.tsx`, `TopBar.tsx`, `AuditDrawer.tsx`.
- `FoldLedger.tsx` — the signature HUD: monospace, one row per active hinge, axis vector and live
  angle.
- `Scrubber.tsx` — styled `t` slider, transport controls, keyboard bindings.

**Gate:** the full layout renders. Glass panels visibly refract the 3D scene behind them. The 2D and
3D views highlight the same panel simultaneously. Every control is keyboard-reachable with a visible
focus ring.

---

## Phase 7 — Polish and stretch · 2.5 h

- Load sequence: staggered glass rise, 420 ms, `cubic-bezier(0.22, 1, 0.36, 1)`.
- Parse reveal: the dieline draws itself in via `stroke-dashoffset` — cuts first, then creases,
  ~900 ms. This is the shot that sells the demo; spend the time here.
- Flat sheet lifts off the plane, camera dollies out.
- Artwork mode: raster upload UV-maps onto the panels *(stretch goal 2)*.
- `prefers-reduced-motion` honoured throughout.
- Responsive down to 390 px; 2D view becomes a bottom sheet.
- Web Worker path for files over 2 MB.

**Gate:** the reveal sequence reads as one orchestrated moment rather than scattered effects.
Reduced motion removes transitions and the fold remains scrubbable. No layout breaks at 390 px.

---

## Phase 8 — Hardening · 1.5 h

Walk the acceptance checklist in `spec.md` §8 line by line and fix everything that fails.

Adversarial passes:
- Upload the sample **PNG** → artwork-mode message, no crash.
- Upload a truncated PDF → readable error, app still usable.
- Upload an SVG with no creases → the "cut lines but no crease lines" message.
- Upload a 5 MB PDF → worker path, UI stays responsive.
- Scrub violently while playing → no desynchronisation.
- Resize the window mid-fold → no distortion, no stretched canvas.
- Double-click the sample loader → no double-parse, no duplicate scene.
- Hard-reload ten times → no accumulating WebGL contexts.

**Gate:** `npx tsc --noEmit` clean, `npm run build` clean with no warnings, console empty in every
scenario above.

---

## Phase 9 — Deliverables · 1 h

- `README.md` — 30-second setup, the fold-math explanation, stack rationale.
- `RECORDING.md` — the shot list below.
- Record, review, re-record if the audio rambles. One take that lands beats four that don't.

---

## The recording

Roughly 60 seconds, talking over it. Rehearse twice, then record. Watch the clock — the brief asks
for clarity, and running long reads as not knowing what matters.

**0:00–0:30 · Demo**
1. Drop `sample_dieline.pdf`. The dieline draws itself in. *"88 vector segments, three separation
   colorspaces — Schneiden is cut, Rillen is crease."*
2. The panel list populates. *"Fourteen panels recovered."*
3. Hit Fold. Let it run. *"One parameter drives every hinge."*
4. Orbit the closed box. *"154 by 95 by 16.5 millimetres, derived from the sheet."*

**0:30–1:00 · Code**
5. `src/core/` — *"All the geometry is pure TypeScript. No React, no Three.js in here."*
6. `panels.ts` — *"Build a lattice from every unique X and Y, test each cell against the cut
   contour, then union-find merge cells that aren't separated by a line. That gives the panels."*
7. `solver.ts` — *"The four wall widths sum to 223, which is exactly twice 95 plus 16.5. That
   identity is how the app knows it's a tube and what its cross-section is."*
8. `PanelTree.ts` — *"Each panel is a group sitting on its hinge line, oriented so the hinge is
   local X. Folding is one rotation. Children are descendants, so nesting composes the transforms
   for free — and because every axis lies in both planes, the fold is a rigid isometry. Nothing
   stretches."*
9. **The hard part:** *"The hinge graph of a closed box has cycles. You can't drive every hinge
   independently — it tears. So I fold a spanning tree and use the leftover edges as a measurement:
   closure residual, 0.3 millimetres."*

Close on the audit drawer. Say nothing over it; let the numbers land.

---

## Time budget

| Phase | Hours | Cumulative |
|---|---|---|
| 0 · Scaffold | 0.75 | 0.75 |
| 1 · Extraction | 2.0 | 2.75 |
| 2 · Classification and panels | 3.0 | 5.75 |
| 3 · Graph and solver | 2.5 | 8.25 |
| 4 · Scene and fold | 3.0 | 11.25 |
| 5 · Maths overlay | 2.0 | 13.25 |
| 6 · Interface | 4.0 | 17.25 |
| 7 · Polish and stretch | 2.5 | 19.75 |
| 8 · Hardening | 1.5 | 21.25 |
| 9 · Deliverables | 1.0 | 22.25 |

**If time runs short,** cut in this order: Phase 7 stretch items, then the per-panel local frames in
Phase 5, then the audit drawer's presentation (keep the numbers, drop the styling). Never cut
Phases 1–4 or the hardening pass. A clean, correct fold with a plain slider scores far better than a
beautiful app that tears at `t = 0.7`.

---

## Definition of done

- Every box in `spec.md` §8 ticked.
- `npx tsc --noEmit` and `npm run build` both clean.
- Console empty in all eight adversarial scenarios from Phase 8.
- The recording is under 70 seconds and the fold logic is explained without hedging.
