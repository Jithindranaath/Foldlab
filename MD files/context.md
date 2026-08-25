# context.md — FoldLab

Background, domain knowledge, and the reasoning behind the decisions in `spec.md`. Read this before
`architect.md` if you are new to the project.

---

## 1. Where this came from

Sivi Quant Labs, Build Challenge 01 (Frontend + 3D). The brief asks for a web app that takes a 2D
box cutting — a dieline — and turns it into a 3D box, folding it closed on screen.

Five stated requirements: upload, parse, build, fold and close with a clearly visible animation, and
orbit/rotate/zoom the result. Stack is free. Deliverable is a ~60-second screen recording: roughly
30 seconds of demo and 30 seconds of code walkthrough.

What they say they grade:
- It works on the sample dieline.
- You understand your own code — the fold logic, not "the library did it".
- You learn fast. Clean beats over-engineered.
- Clarity in the 60 seconds.

Optional stretch goals: generic cut-vs-crease parsing for unseen dielines, realistic materials and
artwork mapped onto faces, and a scrub slider from flat to closed.

Two things in the brief shape the whole design. First: *"make it work end-to-end on this sample box.
You may make reasonable assumptions about the box type to get a clean result. Handling arbitrary,
unseen dielines is a stretch goal, not a requirement."* Second, from their own copy: they ship things
that are *"measurable, auditable, and fast."*

Together those say: correctness on one file, demonstrably, with the workings shown. Not a
half-working general solver.

## 2. Dieline primer

A folding carton starts as one flat piece of board. The die that cuts it carries two kinds of rule:

- **Cut rule** — a sharp blade. Cuts through. Forms the outer contour and any interior slots.
- **Crease rule** — a blunt rule. Compresses the board without severing it, creating a hinge.
  Nothing about a carton works without these; they are where the fold lives.

A third rule, **perforation** (crease-cut), alternates cut and crease along its length to make a
tear line.

Prepress files encode this as line colour or as named spot colours. Red for cut and green for crease
is the common convention, but the sample file uses German trade names as separation colorspaces
instead. Both must be handled.

The vocabulary worth knowing:

| Term | Meaning |
|---|---|
| Panel | A region of board bounded by cuts and creases. Becomes one face or flap. |
| Wall | A panel that forms a side of the closed box. |
| Flap | A panel that folds in to close an opening or to be glued. |
| Glue flap | The narrow panel that overlaps another to close the tube. |
| Dust flap | A small flap that closes the gap at an end. |
| Tuck flap | A flap with a tab that tucks inside to hold the box shut. |
| Dieline | The complete flat cutting layout. |
| Caliper | Board thickness. Why nominally equal panels differ by a millimetre. |

## 3. What the sample file actually is

Measured directly from `sample_dieline.pdf`, not assumed:

- PDF 1.4, one page, 966.814 × 978.779 pt = 341.07 × 345.28 mm.
- No fonts, no raster images. Pure vector line work.
- 88 stroked segments: 76 straight, 12 cubic Bézier.
- Three separation colorspaces, no RGB strokes at all:
  - `/Schneiden` — German for "cutting" → cut, 70 segments.
  - `/Rillen` — German for "creasing / scoring" → crease, 17 segments.
  - `/Rill-Schnitt 10x10` — "crease-cut 10×10" → perforation, 1 segment.
- After a small normalisation offset, every vertex sits on an exact millimetre grid.

The panel decomposition recovers 14 panels. Four of them form a wall chain whose widths sum to
223 mm, which equals `2 × (95 + 16.5)` exactly — the perimeter of a 95 × 16.5 mm rectangle. So the
carton is a tube of that cross-section, 154 mm long. The two end-closure panels measure
16.5 × 95 mm, precisely the end opening. Those two facts agree, which is what makes the
interpretation trustworthy rather than plausible.

**Derived box: 154 × 95 × 16.5 mm.** A flat carton — roughly the proportions of a blister-pack or
cosmetics box.

## 4. Reading the file honestly

The brief's primer describes an idealised straight tuck-end carton: a central band of four wall
panels plus a glue flap, with tuck and dust flaps hanging off the walls.

The real file is more than that. It also carries a snap-lock bottom assembly (three stacked lock
panels, a thumb notch cut as a 10.6 mm circle, and a stepped glue tab), 2 mm chamfers on the tuck
corners, and one perforated tear line. Those are production features, not fold topology.

The decision: **parse and render everything faithfully; fold the wall chain and closures properly;
fold the lock and glue panels flat against their parents.** The geometry on screen is the real
geometry. The fold model is the simplified one. That distinction is stated in the UI and should be
stated on camera — it is exactly the "reasonable assumption about the box type" the brief invites,
and naming it is a stronger signal than pretending the simplification isn't there.

## 5. Decisions and why

### D-1 — Raw Three.js, not react-three-fiber
The brief grades whether you understand your own fold logic. A wrapper library hides scene graph
construction behind JSX, which is exactly the part worth showing. Raw Three keeps the pivot
hierarchy explicit and legible in the walkthrough. Cost: more imperative code, more manual cleanup.
Accepted.

### D-2 — Pivot groups, not hand-composed matrices
A fold is a rotation about an arbitrary line in a plane. You can build that by composing
`T(a) · R(û, θ) · T(−a)` yourself every frame, or you can encode it once in the scene graph: a Group
sitting on the hinge line, oriented so the hinge is local `+X`, with the mesh offset inside it.
Then folding is `pivot.rotation.x = θ`, and nesting handles composition for free. Same mathematics,
far fewer places to introduce a sign error. The formal expression stays in a comment and on screen,
so the maths is still visible even though Three does the multiplication.

### D-3 — Lattice + union-find for panel recovery
Alternatives considered: half-edge planar arrangement (correct and general, but heavy and fiddly to
get right under time pressure), or hardcoding the sample's rectangles (fast, but abandons the
stretch goal and reads as a cheat).

The lattice approach sits between them. Build a grid from every unique X and Y, test each cell for
being inside the cut contour, then merge neighbouring cells that aren't separated by a line. It is
about sixty lines, it generalises to any orthogonal dieline, and it has already been verified
against the sample: it reproduces all 14 panels. Limitation: it assumes axis-aligned panels.
Diagonal or curved boundaries degrade into stair-stepped bounding regions. That is acceptable for
v1 and is documented rather than hidden.

### D-4 — Spanning tree drives motion; cycles become measurements
The hinge graph of a closed carton has cycles — that's what closure *means*. Driving every hinge
independently over-constrains the system and produces tearing. So: fold a BFS spanning tree, and
use the leftover edges to measure how close the mating faces come at `t = 1`. That number is the
closure residual, and it turns "it looks closed" into "it closes to 0.3 mm". This is the single most
interesting thing to say during the code walkthrough.

### D-5 — Rigid isometry as a stated invariant
Every hinge axis lies in both the parent and child planes, so the shared edge is pointwise fixed
under the rotation. Edge lengths therefore cannot change at any `t`. The app measures this drift
continuously and displays it. It should read below 1e-6. Board does not stretch, and the model
shouldn't either — asserting it is cheap and it is a strong correctness signal.

### D-6 — Raster uploads are artwork, not geometry
A PNG has no cut or crease data. Recovering it by edge detection is possible in principle and
unreliable in practice — it would produce a subtly wrong box and undermine the whole premise. So
raster files become face textures, which also delivers stretch goal #2. When no geometry is loaded,
the app says plainly what it needs. Refusing to guess is the right call, and saying why is better
than a silent failure.

### D-7 — Glassmorphism over a live canvas
Requested, and it happens to fit: translucent panels floating over the 3D viewport mean the carton
is visibly refracting behind the controls, which ties the interface to the subject instead of
decorating it. The discipline is to spend the boldness once. The signature element is the Fold
Ledger — a monospace live readout of hinge axes and dihedral angles. Everything else stays quiet:
hairline borders, restrained type, no gradients competing with the scene.

### D-8 — Line colours borrowed from the dieline's own vocabulary
Red for cut, green for crease, blue for perforation. Not arbitrary accent colours — the prepress
convention, used consistently in the 2D view, the 3D hinge overlays, and the axis triad. The
interface speaks the domain's language.

### D-9 — `core/` never imports React or Three
The parsing, decomposition, graph, and solver are pure TypeScript on plain data. That boundary is
what makes the fold logic unit-testable, and it is what you point at during the walkthrough to show
the maths is yours rather than the library's.

## 6. Vocabulary for the interface

Consistent naming across UI, code, and the recording. A control keeps the same name through the
whole flow.

| Use | Avoid |
|---|---|
| Fold | Animate, Play animation |
| Flat → Closed | Start / End, 0 / 1 |
| Cut line, Crease line, Perforation | Red line, green line |
| Panel | Face, polygon, mesh |
| Hinge | Joint, edge, axis of rotation |
| Closure residual | Error, gap score |
| Dieline | File, drawing, artwork |

## 7. Open questions

1. Should the fold order be author-controllable, or always derived from tree depth? Derived is
   simpler and reads well on the sample; a manual override is a plausible v1.1.
2. Board thickness is modelled as zero. A 0.4 mm extrude is implemented but off by default — worth
   revisiting if the closure residual proves sensitive to it.
3. DXF is the other common dieline format and maps cleanly onto the same extractor interface
   (layer names carry cut/crease). Deliberately out of scope for v1; the seam is left in place.
4. The perforated tear line is currently treated as a crease for graph purposes. If a future dieline
   uses perforations to separate panels that genuinely detach, that assumption needs revisiting.
