// The pivot pattern (architect.md 5 / BUILD_PROMPT 4.7): every panel is a
// pair of nested Object3Ds.
//
//   hingeFrame  — sits ON the hinge line, in the PARENT's local space.
//                 position = hinge.axisPoint, quaternion rotates local +X to
//                 the hinge direction. Set once at construction; never
//                 touched again.
//   foldGroup   — child of hingeFrame. Its `.rotation.x` is the ENTIRE
//                 animation: folding is one scalar per panel, recomputed
//                 from `t` on every call to setFoldParameter. Children ride
//                 along automatically because they are descendants of this
//                 group, which is exactly why nesting composes the fold for
//                 free and why nothing needs its own animation state.
//
// Formally, for a point p living on a panel at flat/rest position `p`:
//
//   M_child(t) = M_parent(t) . T(a) . R(u, theta(t)) . T(-a)
//     a = hinge.axisPoint, u = hinge.axisDir, theta(t) = angleAtT(edge, t)
//
// which is exactly kinematics.ts's worldPointForPanel, so the audit's
// closure/isometry numbers and what's on screen are provably the same
// computation. Because `u` lies in both the parent and child planes and
// passes through `a`, the shared edge is fixed pointwise under the
// rotation: the fold is a rigid isometry for every t.
//
// Two subtleties that are easy to get numerically-close-but-wrong here,
// both caught by cross-checking live Three.js world matrices against a
// from-scratch Rodrigues reimplementation rather than trusting that
// "kinematics.ts agrees with itself" proves the *scene* is right:
//
// 1. hingeFrame's quaternion must be built as an explicit rotation about
//    +Z (`setFromAxisAngle(Z, atan2(dir.y, dir.x))`), never via
//    `setFromUnitVectors((1,0,0), dir)`. Every hinge direction here is a
//    2D vector in the flat sheet's own plane, so the alignment is always a
//    Z rotation — except setFromUnitVectors doesn't know that, and for the
//    (fairly common) case of `dir` landing on exactly -X it hits the
//    180-degree case, which has no unique axis; three.js's fallback there
//    picks an arbitrary perpendicular (often +Y), silently rotating that
//    whole subtree around the wrong axis.
// 2. A panel's mesh geometry is built relative to its own hinge
//    (`flatPoint - a`), but that offset is expressed in the WORLD-aligned
//    frame, while hingeFrame's quaternion re-bases local +X onto `dir` —
//    so geometry built straight from `flatPoint - a` is only correct for
//    the one hinge that happens to run exactly along +X. Every other
//    panel needs that offset un-rotated by `dir` first (toLocalPoint,
//    below) to cancel hingeFrame's own quaternion in advance. The same
//    correction has to be applied one level at a time when computing a
//    *child* hinge's position/direction relative to its parent's foldGroup
//    (parentNode.ownAxisPoint/ownAxisDir below) — composing arbitrarily
//    deep chains correctly without hand-tracking a cumulative rotation,
//    because each level's un-rotation cancels exactly what its own parent
//    contributed, and the scene graph composes the rest for free.
import * as THREE from 'three';
import type { FoldEdge, FoldSchedule, Panel, Vec2 } from '../core/types.ts';
import { angleAtT, easeInOutCubic } from '../core/kinematics.ts';
import { createBoardMaterials, disposeMaterials } from './Materials.ts';

/** How far a clicked-open panel swings past its closed -90 degree angle,
 * back through flat and out the other side — a generous, door-like open
 * sweep rather than just undoing the fold. */
export const PANEL_OPEN_ANGLE = (114 * Math.PI) / 180;

interface PanelNode {
  container: THREE.Group; // where this panel's children attach (its own foldGroup, or the tree root's container)
  meshes: THREE.Mesh[];
  geometry: THREE.BufferGeometry;
  // This node's own incoming hinge, in absolute flat-sheet coordinates —
  // (0,0)/(1,0) for the root, whose foldGroup basis IS the absolute frame.
  // Needed to re-express this node's CHILDREN's hinge info (which graph.ts
  // always reports in absolute coordinates) inside this node's own rotated
  // rest frame — see the comment above the BFS loop below.
  ownAxisPoint: Vec2;
  ownAxisDir: Vec2;
}

function buildGeometry(points: Vec2[]): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map((p) => new THREE.Vector2(p.x, p.y)));
  const geometry = new THREE.ShapeGeometry(shape);
  return geometry;
}

/** Un-rotates `p` by `dir`'s own angle (i.e. expresses `p` in the local
 * frame whose +X axis is `dir`) — the inverse of the alignment quaternion
 * `setFromUnitVectors((1,0,0), dir)` would produce, done here in 2D since
 * every hinge lies in the flat sheet's own plane. */
function toLocalDir(v: Vec2, dir: Vec2): Vec2 {
  return { x: v.x * dir.x + v.y * dir.y, y: -v.x * dir.y + v.y * dir.x };
}
function toLocalPoint(p: Vec2, origin: Vec2, dir: Vec2): Vec2 {
  return toLocalDir({ x: p.x - origin.x, y: p.y - origin.y }, dir);
}

export class PanelTree {
  readonly root: THREE.Group;
  private nodes = new Map<string, PanelNode>();
  private materials: { outer: THREE.MeshStandardMaterial; inner: THREE.MeshStandardMaterial };
  private edgeByChild = new Map<string, FoldEdge>();
  // Purely cosmetic panel-outline overlay (brutalist hairline look) — traces
  // the same ShapeGeometry each mesh already uses, never touches the fold
  // transform, and is disposed alongside it.
  private edgeLineMaterial = new THREE.LineBasicMaterial({ color: 0x0d0d0d });
  private edgeGeometries: THREE.BufferGeometry[] = [];

  constructor(schedule: FoldSchedule) {
    this.root = new THREE.Group();
    this.materials = createBoardMaterials();

    const panelsById = new Map<string, Panel>(schedule.panels.map((p) => [p.id, p]));
    for (const e of schedule.edges) this.edgeByChild.set(e.child, e);

    const rootPanel = panelsById.get(schedule.root);
    if (!rootPanel) return;

    const rootContainer = new THREE.Group();
    this.root.add(rootContainer);
    this.addPanelMeshes(rootContainer, rootPanel.polygon, rootPanel.id);
    this.nodes.set(rootPanel.id, {
      container: rootContainer,
      meshes: [...rootContainer.children] as THREE.Mesh[],
      geometry: (rootContainer.children[0] as THREE.Mesh).geometry,
      // Root never rotates, so its foldGroup basis IS the absolute frame —
      // the identity origin/direction below makes toLocalPoint/toLocalDir
      // a no-op for root's direct children, exactly as it should be.
      ownAxisPoint: { x: 0, y: 0 },
      ownAxisDir: { x: 1, y: 0 }
    });

    const edgesByParent = new Map<string, FoldEdge[]>();
    for (const e of schedule.edges) {
      if (!edgesByParent.has(e.parent)) edgesByParent.set(e.parent, []);
      edgesByParent.get(e.parent)!.push(e);
    }

    const queue: string[] = [rootPanel.id];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const parentNode = this.nodes.get(parentId);
      if (!parentNode) continue;

      for (const edge of edgesByParent.get(parentId) ?? []) {
        const childPanel = panelsById.get(edge.child);
        if (!childPanel) continue;

        // graph.ts reports every hinge's axisPoint/axisDir in absolute
        // flat-sheet coordinates, regardless of tree depth. But this
        // hingeFrame is nested inside the PARENT's foldGroup, whose own
        // rest basis is the absolute frame rotated by the parent's OWN
        // un-rotation (identity for root, non-identity for anything
        // deeper) — so the child's hinge must be re-expressed in that
        // parent-local basis before use, or every hinge past the first
        // level silently comes out wrong. One level of un-rotation is
        // sufficient at each step (not the whole ancestor chain): applying
        // parentNode's own (ownAxisPoint, ownAxisDir) transform here exactly
        // cancels the rotations parentNode itself absorbed from ITS parent,
        // by the same algebra as the geometry fix below.
        const a = toLocalPoint(edge.hinge.axisPoint, parentNode.ownAxisPoint, parentNode.ownAxisDir);
        const dirRaw = toLocalDir(edge.hinge.axisDir, parentNode.ownAxisDir);
        const dirLen = Math.hypot(dirRaw.x, dirRaw.y) || 1;
        const dir = { x: dirRaw.x / dirLen, y: dirRaw.y / dirLen };

        const hingeFrame = new THREE.Group();
        hingeFrame.position.set(a.x, a.y, 0);
        // Every hinge lies in the flat sheet's own XY plane, so aligning
        // local +X to `dir` is always a rotation about +Z — construct it
        // directly as one, rather than via setFromUnitVectors(X, dir).
        // setFromUnitVectors is ambiguous whenever dir is exactly -X (a
        // 180 degree rotation has no unique axis): three.js's fallback for
        // that case picks an arbitrary perpendicular axis (often +Y, not
        // +Z), which silently rotates the whole subtree about the wrong
        // axis and was the actual cause of every panel past the first
        // coming out in the wrong plane.
        hingeFrame.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan2(dir.y, dir.x));

        const foldGroup = new THREE.Group();
        hingeFrame.add(foldGroup);

        // The mesh itself un-rotates by the hinge's OWN (raw, absolute)
        // axis — self-contained to this panel's own frame, independent of
        // how deep it sits in the tree (see the derivation in PanelTree's
        // module comment / README for why the parent's contribution cancels
        // out here).
        const ownA = edge.hinge.axisPoint;
        const ownDir = edge.hinge.axisDir;
        const relativePolygon = childPanel.polygon.map((p) => toLocalPoint(p, ownA, ownDir));
        this.addPanelMeshes(foldGroup, relativePolygon, edge.child);

        parentNode.container.add(hingeFrame);
        this.nodes.set(edge.child, {
          ownAxisPoint: ownA,
          ownAxisDir: ownDir,
          container: foldGroup,
          meshes: [...foldGroup.children] as THREE.Mesh[],
          geometry: (foldGroup.children[0] as THREE.Mesh).geometry
        });
        queue.push(edge.child);
      }
    }
  }

  private addPanelMeshes(container: THREE.Group, points: Vec2[], panelId: string): void {
    const geometry = buildGeometry(points);
    const outer = new THREE.Mesh(geometry, this.materials.outer);
    const inner = new THREE.Mesh(geometry, this.materials.inner);
    outer.userData.panelId = panelId;
    inner.userData.panelId = panelId;
    container.add(outer, inner);

    const edgeGeometry = new THREE.EdgesGeometry(geometry);
    const outline = new THREE.LineSegments(edgeGeometry, this.edgeLineMaterial);
    outline.renderOrder = 2;
    this.edgeGeometries.push(edgeGeometry);
    container.add(outline);
  }

  /** Single source of truth for time: recomputes every hinge rotation from
   * `t` on each call. No panel holds its own animation state, which is why
   * scrubbing backwards and play/pause/reset can never desynchronise.
   *
   * `openedPanelId`/`openProgress` are an independent override on top of
   * that: while a panel is "open" (clicked), its OWN hinge blends from the
   * normal closed angle toward a generous door-like swing, while every
   * other hinge keeps following `t` exactly as before. Because folding is
   * still just "one rotation per pivot, recomputed from scratch", opening
   * a panel automatically carries its whole subtree with it — no extra
   * bookkeeping needed, the same nesting that makes the base fold work.
   */
  setFoldParameter(t: number, openedPanelId: string | null = null, openProgress = 0): void {
    for (const [childId, edge] of this.edgeByChild) {
      const node = this.nodes.get(childId);
      if (!node) continue;
      const closedAngle = angleAtT(edge, t);
      if (childId === openedPanelId && openProgress > 0) {
        const eased = easeInOutCubic(openProgress);
        node.container.rotation.x = closedAngle + (PANEL_OPEN_ANGLE - closedAngle) * eased;
      } else {
        node.container.rotation.x = closedAngle;
      }
    }
  }

  /** Panel id for a mesh hit by a raycast against `this.root`, or null if
   * the hit object isn't one of ours (or is the root panel, which has no
   * hinge of its own and so can't be "opened"). */
  panelIdForObject(object: THREE.Object3D): string | null {
    const id = object.userData['panelId'];
    return typeof id === 'string' && this.edgeByChild.has(id) ? id : null;
  }

  getPanelWorldMatrix(panelId: string): THREE.Matrix4 | null {
    const node = this.nodes.get(panelId);
    if (!node) return null;
    node.container.updateWorldMatrix(true, false);
    return node.container.matrixWorld;
  }

  getContainer(panelId: string): THREE.Group | null {
    return this.nodes.get(panelId)?.container ?? null;
  }

  dispose(): void {
    const seenGeometries = new Set<THREE.BufferGeometry>();
    for (const node of this.nodes.values()) {
      if (!seenGeometries.has(node.geometry)) {
        node.geometry.dispose();
        seenGeometries.add(node.geometry);
      }
    }
    for (const edgeGeometry of this.edgeGeometries) edgeGeometry.dispose();
    this.edgeGeometries = [];
    this.edgeLineMaterial.dispose();
    disposeMaterials(this.materials);
    this.nodes.clear();
  }
}
