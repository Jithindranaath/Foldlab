# FoldLab — 2D Dieline → 3D Box

Upload a packaging dieline (PDF or SVG) and watch it fold from flat into a closed 3D box, with the
underlying geometry — panels, hinges, live dihedral angles, closure math — visible the whole time.

Built for SiviQuantLabs Build Challenge 01.

## 30-second setup

```bash
npm install
npm run dev       # http://localhost:5173
```

Click **"Load the sample carton"**, then **Fold**. Orbit with the mouse (drag to rotate, wheel to
zoom, right-drag to pan). Scrub the slider at the bottom to fold/unfold by hand.

Once closed, **click any panel** to swing it open on its own hinge — independent of the main fold —
while the camera flies to a POV looking straight at that face. Click it again (or the "✕ Close"
badge, or empty space) to close it and return.

Other scripts:

```bash
npm run build       # tsc --noEmit && vite build
npm test            # vitest, runs against the real sample_dieline.pdf
npm run typecheck   # tsc --noEmit only
```

## The sample file

`public/samples/sample_dieline.pdf` is the real dieline supplied with the brief (a straight
tuck-end carton, the standard cosmetics/pharma box shape) — not a synthetic stand-in. Measured
directly from it:

- PDF 1.4, 966.814 × 978.779 pt = 341.07 × 345.28 mm, no fonts, no raster images.
- 88 stroked path operators: 76 straight (`lineTo`) + 12 cubic Bézier (`curveTo`).
- Every stroke sets a `/Separation` colour space by name (`Schneiden` = cut, `Rillen` = crease, a
  third for the perforation) — but pdf.js resolves those to concrete device RGB *before* the
  operator list is built, so the colour space name never survives to the app. FoldLab's classifier
  is a three-strategy ranked chain for exactly this reason: try named colour space/layer first
  (fires for SVG uploads, where layer names *do* survive), fall through to stroke hue (fires here —
  verified against the sample's actual resolved colours, including a perforation stroke that sits
  at h≈197.5°, just outside a naive 200–260° band, which is why the hue bands are a little wider
  than the textbook red/green/blue split), and finally a topological fallback if neither finds a
  crease.
- Decomposes to **16 panels** (14 "clean" carton panels plus 2 extra fragments where a small
  thumb-notch cutout splits the snap-lock band's middle panel — see *Known simplifications* below),
  **17 crease lines + 1 perforation**, matching the brief's own stated facts exactly.
- Derived box: **154 × 95 × 16.5 mm**, exactly. The wall chain's perimeter identity
  `16 + 95 + 17 + 95 = 223 = 2 × (95 + 16.5)` holds to the last decimal — that's the check that
  proves the parse is right, not just plausible.
- The 16 vs 17 mm side-wall pair is genuine caliper compensation in the real die (the outer wall
  travels around the inner one's board thickness). FoldLab reconciles it to `D = 16.5` for the fold
  target angle, but *displays* the measured pair rather than silently averaging, and the audit
  drawer explains the resulting ~1 mm closure residual as exactly that gap, not a parse error.

`scripts/measure-real-sample.ts` re-derives every number above by running the real pdf.js
operator-list walk through the actual `src/core` pipeline (the same code the app runs) and writes
the result to `src/core/sampleExpectations.ts` — the audit drawer's "expected" column and the
vitest suite both come from that single source of truth, not a hand-typed table.

## The fold, in one paragraph

Every panel is two nested `THREE.Group`s: a `hingeFrame` sitting on the hinge line, oriented once
so the hinge direction becomes local +X, and a `foldGroup` inside it whose `.rotation.x` *is* the
entire animation — recomputed from a single scalar `t ∈ [0,1]` on every frame, never touched any
other way. Children are parented into their own parent's `foldGroup`, so nesting composes the fold
for free: fold the shoulder joint and everything past the wrist comes along automatically. Because
every rotation axis lies in both the parent and child planes, the shared edge is fixed pointwise
under the rotation — the fold is a rigid isometry for every `t`, and `core/audit.ts` measures that
drift continuously (it reads `~1e-13` on the sample, essentially machine precision, not just
"small"). `core/kinematics.ts` implements the exact same transform in plain TypeScript (no
Three.js), so the audit's numbers and what's on screen are the same computation, and both are
independently unit-tested against a from-scratch Rodrigues-rotation reimplementation, not against
each other.

**The hinge graph of a closed carton has cycles** — that's what closure means — but driving every
hinge independently over-constrains the system. FoldLab folds a BFS spanning tree and leaves the
rest as measurements: the closure residual above isn't cosmetic, it's what's left over.

Click-to-open a panel is the same mechanism with a second, independent scalar layered on top: every
hinge still follows the global `t`, except the clicked panel's own hinge, which blends from its
closed angle toward a wide door-like swing. Because it's still just one rotation per pivot recomputed
from scratch, opening a panel automatically carries its whole subtree open with it — no special-casing
needed for what's "attached" to it.

## Stack rationale

Raw Three.js, not react-three-fiber: the brief grades whether you understand your own fold logic,
and a JSX wrapper hides exactly the scene-graph construction worth showing. `pdf.js` is used for
document/operator-list access, but colour classification deliberately does **not** trust it to
preserve `/Separation` names (see above) — that's a real constraint of the library, worked around
with a ranked fallback chain rather than assumed away. `zustand` for state because the fold has
exactly one source of truth (`t`) and didn't need more. Plain CSS custom properties over Tailwind
because the glass aesthetic is four reusable rules, not a utility soup.

## Architecture

```
src/core/       pure TypeScript, zero React, zero Three.js — the fold math lives here
  extract/        PDF (pdfjs-dist) and SVG (DOMParser) → raw segments + colour/layer hints
  classify.ts     3-strategy ranked cut/crease/perf classifier
  panels.ts       lattice + union-find panel decomposition
  graph.ts        hinge detection (per-crease-segment, range-intersecting), BFS spanning tree
  solver.ts       wall-chain identification, dihedral targets, depth-based stagger timing
  kinematics.ts   pure-TS forward kinematics (Rodrigues rotation) — the audit's ground truth
  audit.ts        closure residual, isometry drift, perimeter identity
  pipeline.ts     orchestrates the above; shared by the main thread and the parse worker
src/three/      PanelTree.ts (the pivot pattern), Viewport.ts, Axes/Grid/HingeOverlay/Dimensions
src/ui/         React shell — DielineView, PanelList, FoldLedger, Scrubber, AuditDrawer
src/state/      one flat zustand store; t is owned by React, driven by one requestAnimationFrame
                loop in App.tsx
src/workers/    parse.worker.ts — same pipeline.ts, off the main thread for files over 2 MB
scripts/        measure-real-sample.ts (regenerates sampleExpectations.ts from the real PDF);
                generate-fixtures.ts (an earlier synthetic-fixture generator, superseded once the
                real sample arrived — kept as a self-contained example of driving the pipeline
                end-to-end and of the SVG extraction path)
```

`core/` never imports React or Three — that boundary is what makes the fold logic testable in
isolation and demonstrable during a code walkthrough without reaching into the render tree.

## The two bugs worth naming

Both were caught by cross-checking live Three.js world matrices against the pure-TS kinematics
reimplementation and a from-scratch Rodrigues rotation done independently in a throwaway script —
not by trusting that the math "looked right" or that the audit numbers passed (they did, the whole
time, because `audit.ts` never went through the buggy code path).

1. **pdf.js reports colour operator arguments as typed arrays** (`Uint8ClampedArray` for RGB), not
   plain `Array` — so an `Array.isArray` guard silently dropped every colour update, and every
   stroke classified as `null` → fell through to the topological fallback. Fixed by accepting
   anything array-like with the right length instead of requiring `Array.isArray`.
2. **`THREE.Quaternion.setFromUnitVectors` is ambiguous for exactly-antiparallel vectors.** Every
   hinge lies in the flat sheet's own plane, so aligning local +X to a hinge direction should
   always be a rotation about +Z — but for a hinge direction of exactly `(-1, 0)`, mapping `(1,0,0)`
   to `(-1,0,0)` is a 180° rotation with no unique axis, and three.js's fallback for that case picks
   an arbitrary perpendicular (often +Y). That silently rotated whole subtrees about the wrong axis
   — geometrically valid-looking output that was still wrong, which is why it took brute-force
   vertex-level verification, not a visual glance, to actually find. Fixed by constructing the
   quaternion directly as `setFromAxisAngle(Z, atan2(dir.y, dir.x))`.

A closely related, less exotic bug lived in `panels.ts`: pre-filtering lattice columns/rows thinner
than a "chamfer sliver" threshold *before* material/union-find testing deleted cells outright rather
than letting them merge into a neighbour — which fragmented an unrelated wall panel wherever the
sample's thumb-notch happened to inject a thin grid column elsewhere on the sheet. Fixed by keeping
every cell and letting union-find (which already handles "nothing separates these, merge them") and
the final minimum-panel-area filter do that job instead.

## Known simplifications

- The lock-band's Ø10.6 mm thumb notch splits `LOCK_2` into 3 lattice fragments that don't all
  re-merge into one concave panel (16 panels instead of a clean 14). This doesn't affect the fold:
  each fragment hinges correctly and the wall chain, perimeter identity, and closure/isometry
  numbers are unaffected. Documented rather than hidden, per the brief's own bar: "you may make
  reasonable assumptions about the box type to get a clean result."
- Panel decomposition assumes axis-aligned rectangles (the lattice + union-find approach). Curved
  or diagonal panel boundaries would degrade into stair-stepped regions — acceptable for this
  sample, and explicitly a stretch goal (generic dieline parsing) rather than a requirement.
- Raster uploads (PNG/JPG) are artwork only, never geometry — edge-detecting fold geometry from
  pixels is unreliable and would silently produce a wrong box. With a dieline already loaded, a
  raster upload is accepted but not yet UV-mapped onto the folded panels (a documented stretch
  goal, not implemented in this pass); without one, FoldLab shows the flat image and says plainly
  what it needs.
- Board thickness is modelled as zero (a flush fold, no 0.4 mm extrude).

## Recording

See `RECORDING.md` for the shot list.
