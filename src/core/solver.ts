import type { FoldEdge, FoldSchedule, Hinge, Panel, PanelRole, Segment, Vec2 } from './types.ts';
import type { ClassificationStrategy } from './types.ts';
import { buildHingeGraph, buildSpanningTree } from './graph.ts';
import { approxEqual } from './units.ts';

function bboxCenter(panel: Panel): Vec2 {
  return { x: panel.bbox.x + panel.bbox.w / 2, y: panel.bbox.y + panel.bbox.h / 2 };
}

/**
 * Orients the hinge so that a negative rotation about it moves `child`'s
 * centroid toward -Z — i.e. "inward" — in the flat/rest frame shared by
 * every panel before folding. When the direction must flip, axisPoint is
 * moved to the opposite end of the hinge span too, so that
 * `axisPoint + axisDir * length` still identifies the same physical segment
 * (audit.ts relies on that invariant to find a hinge's far/near endpoints).
 */
function orientAxisForInwardFold(hinge: Hinge, child: Panel): { axisPoint: Vec2; axisDir: Vec2 } {
  const centroid = bboxCenter(child);
  const vx = centroid.x - hinge.axisPoint.x;
  const vy = centroid.y - hinge.axisPoint.y;
  const crossZ = hinge.axisDir.x * vy - hinge.axisDir.y * vx;
  if (crossZ >= 0) return { axisPoint: hinge.axisPoint, axisDir: hinge.axisDir };
  return {
    axisPoint: {
      x: hinge.axisPoint.x + hinge.axisDir.x * hinge.length,
      y: hinge.axisPoint.y + hinge.axisDir.y * hinge.length
    },
    axisDir: { x: -hinge.axisDir.x, y: -hinge.axisDir.y }
  };
}

interface ChainMember {
  panel: Panel;
  width: number; // extent perpendicular to the chain's length axis
}

const MAX_ARM_DEPTH = 4;

/** Extends outward from `startId` (excluding root) through hinges whose axis
 * is parallel to `lengthAxis` and whose span closely matches `rootLen`,
 * always stepping away from where we came from. Stops at MAX_ARM_DEPTH or
 * when no further qualifying neighbour exists. */
function walkArm(
  startId: string,
  cameFromId: string,
  lengthAlongX: boolean,
  lengthAxis: Vec2,
  rootLo: number,
  rootHi: number,
  rootLen: number,
  panelsById: Map<string, Panel>,
  adjacency: Map<string, string[]>,
  hingeByPair: Map<string, Hinge>
): ChainMember[] {
  const arm: ChainMember[] = [];
  let currentId: string | null = startId;
  let cameFrom = cameFromId;

  while (currentId && arm.length < MAX_ARM_DEPTH) {
    const panel = panelsById.get(currentId);
    if (!panel) break;
    arm.push({ panel, width: lengthAlongX ? panel.bbox.h : panel.bbox.w });

    let next: string | null = null;
    for (const neighbourId of adjacency.get(currentId) ?? []) {
      if (neighbourId === cameFrom) continue;
      const hinge = hingeByPair.get(`${currentId}|${neighbourId}`);
      const neighbour = panelsById.get(neighbourId);
      if (!hinge || !neighbour) continue;
      const dot = Math.abs(hinge.axisDir.x * lengthAxis.x + hinge.axisDir.y * lengthAxis.y);
      if (dot < 0.98) continue;
      const nLo = lengthAlongX ? neighbour.bbox.x : neighbour.bbox.y;
      const nHi = lengthAlongX ? neighbour.bbox.x + neighbour.bbox.w : neighbour.bbox.y + neighbour.bbox.h;
      const overlap = Math.min(rootHi, nHi) - Math.max(rootLo, nLo);
      if (overlap < rootLen * 0.85) continue;
      next = neighbourId;
      break;
    }
    cameFrom = currentId;
    currentId = next;
  }

  return arm;
}

/** Splits sorted widths into "small" (D-ish) and "large" (H-ish) clusters at
 * the single largest gap in the sorted sequence — robust to a bimodal
 * alternating D,H,D,H pattern regardless of how far apart D and H are. */
function splitByLargestGap(widths: number[]): { small: number[]; large: number[] } {
  const sorted = [...widths].sort((a, b) => a - b);
  if (sorted.length < 2) return { small: sorted, large: sorted };
  let splitIndex = 1;
  let maxGap = -Infinity;
  for (let k = 1; k < sorted.length; k++) {
    const gap = sorted[k]! - sorted[k - 1]!;
    if (gap > maxGap) {
      maxGap = gap;
      splitIndex = k;
    }
  }
  return { small: sorted.slice(0, splitIndex), large: sorted.slice(splitIndex) };
}

function testIdentity(
  members: ChainMember[]
): { sumOfWidths: number; twiceAPlusB: number; a: number; b: number; holds: boolean } {
  const widths = members.map((m) => m.width);
  const sumOfWidths = widths.reduce((s, w) => s + w, 0);
  const { small, large } = splitByLargestGap(widths);
  const smallVals = small.length > 0 ? small : widths;
  const largeVals = large.length > 0 ? large : widths;
  const D = smallVals.reduce((s, w) => s + w, 0) / smallVals.length;
  const H = largeVals.reduce((s, w) => s + w, 0) / largeVals.length;
  const twiceAPlusB = 2 * (H + D);
  return { sumOfWidths, twiceAPlusB, a: H, b: D, holds: approxEqual(sumOfWidths, twiceAPlusB, 0.6) };
}

/**
 * Identifies the wall chain by growing two arms out from the root along
 * hinges parallel to its longer bbox dimension, then picking the smallest
 * combination of (root + arm-one-prefix + arm-two-prefix) whose perpendicular
 * widths satisfy the tube's own perimeter identity Sum(w) = 2(a+b). That
 * identity — not just "looks wide and parallel" — is what tells a wall chain
 * apart from an equally wide, equally parallel flap chain (e.g. a snap-lock
 * bottom assembly) elsewhere on the same sheet.
 */
function identifyWallChain(
  root: Panel,
  panelsById: Map<string, Panel>,
  adjacency: Map<string, string[]>,
  hingeByPair: Map<string, Hinge>
): { chain: string[]; dims: { L: number; H: number; D: number; measuredPair: [number, number] } | null; identity: { sumOfWidths: number; twiceAPlusB: number; a: number; b: number; holds: boolean } | null } {
  const lengthAlongX = root.bbox.w >= root.bbox.h;
  const lengthAxis: Vec2 = lengthAlongX ? { x: 1, y: 0 } : { x: 0, y: 1 };
  const rootLo = lengthAlongX ? root.bbox.x : root.bbox.y;
  const rootHi = lengthAlongX ? root.bbox.x + root.bbox.w : root.bbox.y + root.bbox.h;
  const rootLen = rootHi - rootLo;
  const rootMember: ChainMember = { panel: root, width: lengthAlongX ? root.bbox.h : root.bbox.w };

  const directNeighbours = (adjacency.get(root.id) ?? []).filter((neighbourId) => {
    const hinge = hingeByPair.get(`${root.id}|${neighbourId}`);
    const neighbour = panelsById.get(neighbourId);
    if (!hinge || !neighbour) return false;
    const dot = Math.abs(hinge.axisDir.x * lengthAxis.x + hinge.axisDir.y * lengthAxis.y);
    if (dot < 0.98) return false;
    const nLo = lengthAlongX ? neighbour.bbox.x : neighbour.bbox.y;
    const nHi = lengthAlongX ? neighbour.bbox.x + neighbour.bbox.w : neighbour.bbox.y + neighbour.bbox.h;
    const overlap = Math.min(rootHi, nHi) - Math.max(rootLo, nLo);
    return overlap >= rootLen * 0.85;
  });

  const armA = directNeighbours[0]
    ? walkArm(directNeighbours[0], root.id, lengthAlongX, lengthAxis, rootLo, rootHi, rootLen, panelsById, adjacency, hingeByPair)
    : [];
  const armB = directNeighbours[1]
    ? walkArm(directNeighbours[1], root.id, lengthAlongX, lengthAxis, rootLo, rootHi, rootLen, panelsById, adjacency, hingeByPair)
    : [];

  let best: { members: ChainMember[]; identity: ReturnType<typeof testIdentity> } | null = null;
  for (let i = 0; i <= armA.length; i++) {
    for (let j = 0; j <= armB.length; j++) {
      const members = [...armA.slice(0, i), rootMember, ...armB.slice(0, j)];
      if (members.length < 3) continue;
      const identity = testIdentity(members);
      if (identity.holds && (!best || members.length < best.members.length)) {
        best = { members, identity };
      }
    }
  }

  if (!best) {
    const fallback = [...armA, rootMember, ...armB];
    if (fallback.length < 3) return { chain: fallback.map((m) => m.panel.id), dims: null, identity: null };
    best = { members: fallback, identity: testIdentity(fallback) };
  }

  const ordered = [...best.members].sort((a, b) => {
    const av = lengthAlongX ? a.panel.bbox.y : a.panel.bbox.x;
    const bv = lengthAlongX ? b.panel.bbox.y : b.panel.bbox.x;
    return av - bv;
  });

  const widths = ordered.map((m) => m.width);
  const { small: smallVals } = splitByLargestGap(widths);

  const measuredPair: [number, number] =
    smallVals.length >= 2 ? [smallVals[0]!, smallVals[1]!] : [best.identity.b, best.identity.b];

  return {
    chain: ordered.map((m) => m.panel.id),
    dims: { L: rootLen, H: best.identity.a, D: best.identity.b, measuredPair },
    identity: best.identity
  };
}

function assignRole(
  panelId: string,
  wallChain: Set<string>,
  parentOf: Map<string, string>,
  rolesById: Map<string, PanelRole>,
  panelsById: Map<string, Panel>,
  hingeByPair: Map<string, Hinge>,
  dims: { L: number; H: number; D: number } | null
): PanelRole {
  if (rolesById.has(panelId)) return rolesById.get(panelId)!;
  if (wallChain.has(panelId)) {
    rolesById.set(panelId, 'wall');
    return 'wall';
  }

  const parentId = parentOf.get(panelId);
  const panel = panelsById.get(panelId)!;

  if (parentId && wallChain.has(parentId) && dims) {
    const w = panel.bbox.w;
    const h = panel.bbox.h;
    const matchesEndClosure =
      (approxEqual(w, dims.D, 2) && approxEqual(h, dims.H, 2)) ||
      (approxEqual(w, dims.H, 2) && approxEqual(h, dims.D, 2));
    if (matchesEndClosure) {
      rolesById.set(panelId, 'endClosure');
      return 'endClosure';
    }
    const hinge = hingeByPair.get(`${parentId}|${panelId}`);
    const parentSpan = wallChain.has(parentId) ? dims.L : Infinity;
    if (hinge && hinge.length < parentSpan * 0.9) {
      rolesById.set(panelId, 'tuck');
      return 'tuck';
    }
    rolesById.set(panelId, 'lock');
    return 'lock';
  }

  if (parentId) {
    const parentRole = assignRole(parentId, wallChain, parentOf, rolesById, panelsById, hingeByPair, dims);
    if (parentRole === 'endClosure') {
      rolesById.set(panelId, 'tuck');
      return 'tuck';
    }
    if (parentRole === 'lock' || parentRole === 'glue') {
      // Small deep panels at the end of the lock chain are glue tabs.
      const parentArea = panelsById.get(parentId)!.area;
      const role: PanelRole = panel.area < parentArea * 0.6 ? 'glue' : 'lock';
      rolesById.set(panelId, role);
      return role;
    }
  }

  rolesById.set(panelId, 'unknown');
  return 'unknown';
}

export interface SolveInput {
  panels: Panel[];
  segments: Segment[];
  classificationStrategy: ClassificationStrategy;
}

export function solveFoldSchedule(input: SolveInput): FoldSchedule {
  const { panels, segments } = input;
  const panelsById = new Map(panels.map((p) => [p.id, p]));
  const graph = buildHingeGraph(panels, segments);
  const tree = buildSpanningTree(panels, graph);

  const hingeByPair = new Map<string, Hinge>();
  for (const h of graph.hinges) {
    hingeByPair.set(`${h.panelA}|${h.panelB}`, h);
    hingeByPair.set(`${h.panelB}|${h.panelA}`, h);
  }

  const rootPanel = panelsById.get(tree.root);

  let wallChain: string[] = [];
  let dims = { L: 0, H: 0, D: 0, measuredPair: [0, 0] as [number, number] };
  let perimeterIdentity: FoldSchedule['perimeterIdentity'] = null;

  if (rootPanel) {
    const result = identifyWallChain(rootPanel, panelsById, graph.adjacency, hingeByPair);
    wallChain = result.chain;
    if (result.dims) dims = result.dims;
    perimeterIdentity = result.identity;
  }

  const wallChainSet = new Set(wallChain);
  const rolesById = new Map<string, PanelRole>();
  for (const p of panels) {
    assignRole(p.id, wallChainSet, tree.parentOf, rolesById, panelsById, hingeByPair, rootPanel ? dims : null);
  }

  const rolePanels: Panel[] = panels.map((p) => ({ ...p, role: rolesById.get(p.id) ?? 'unknown' }));

  // Stagger timing must fit entirely inside t in [0,1] regardless of how
  // deep the fold tree goes (a snap-lock bottom's lock/glue chain can run
  // 5-6 hinges deep). A fixed per-level step + duration overruns t=1 for
  // deep chains, leaving the last few hinges visibly mid-fold at "closed" —
  // so both are derived from the schedule's own max depth, keeping a floor
  // on duration so even a very deep chain stays clearly visible.
  const maxDepth = Math.max(1, ...[...tree.depthOf.values()]);
  const DURATION_DEFAULT = 0.55;
  const STEP_DEFAULT = 0.12;
  const DURATION_FLOOR = 0.22;
  const neededSpan = (maxDepth - 1) * STEP_DEFAULT + DURATION_DEFAULT;
  let timingStep = STEP_DEFAULT;
  let timingDuration = DURATION_DEFAULT;
  if (neededSpan > 1 && maxDepth > 1) {
    timingDuration = Math.max(DURATION_FLOOR, DURATION_DEFAULT - (neededSpan - 1));
    timingStep = (1 - timingDuration) / (maxDepth - 1);
  }

  const edges: FoldEdge[] = tree.treeHinges.map((hinge) => {
    const childId = tree.parentOf.get(hinge.panelA) === hinge.panelB ? hinge.panelA : hinge.panelB;
    const parentId = childId === hinge.panelA ? hinge.panelB : hinge.panelA;
    const child = panelsById.get(childId)!;
    const depth = tree.depthOf.get(childId) ?? 1;
    const { axisPoint, axisDir } = orientAxisForInwardFold(hinge, child);
    const orientedHinge: Hinge = { ...hinge, axisPoint, axisDir };
    const start = Math.min(1 - timingDuration, (depth - 1) * timingStep);
    return {
      hinge: orientedHinge,
      parent: parentId,
      child: childId,
      targetAngle: -Math.PI / 2,
      depth,
      start,
      duration: timingDuration
    };
  });

  return {
    root: tree.root,
    panels: rolePanels,
    edges,
    nonTreeHinges: tree.nonTreeHinges,
    orphanPanels: tree.orphanPanels,
    dims,
    perimeterIdentity,
    wallChain,
    classificationStrategy: input.classificationStrategy,
    segments
  };
}
