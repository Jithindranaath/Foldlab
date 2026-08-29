import type { Hinge, Panel, Segment, Vec2 } from './types.ts';
import { MIN_HINGE_LENGTH_MM, SNAP_EPS_MM } from './units.ts';

function polygonEdges(polygon: Vec2[]): { a: Vec2; b: Vec2 }[] {
  const edges: { a: Vec2; b: Vec2 }[] = [];
  for (let i = 0; i < polygon.length; i++) {
    edges.push({ a: polygon[i]!, b: polygon[(i + 1) % polygon.length]! });
  }
  return edges;
}

export interface GraphResult {
  hinges: Hinge[];
  adjacency: Map<string, string[]>;
}

interface Claim {
  panelId: string;
  lo: number;
  hi: number;
}

export function buildHingeGraph(panels: Panel[], segments: Segment[]): GraphResult {
  const creaseSegs = segments.filter((s) => s.kind === 'crease' || s.kind === 'perf');
  const panelEdges = panels.map((p) => ({ id: p.id, edges: polygonEdges(p.polygon) }));

  const hinges: Hinge[] = [];
  const adjacency = new Map<string, string[]>();
  for (const p of panels) adjacency.set(p.id, []);

  let hingeIndex = 0;
  for (const c of creaseSegs) {
    const dx = c.b.x - c.a.x;
    const dy = c.b.y - c.a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const ux = dx / len;
    const uy = dy / len;

    const claims: Claim[] = [];
    for (const pe of panelEdges) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const e of pe.edges) {
        const crossA = Math.abs((e.a.x - c.a.x) * uy - (e.a.y - c.a.y) * ux);
        const crossB = Math.abs((e.b.x - c.a.x) * uy - (e.b.y - c.a.y) * ux);
        if (crossA > SNAP_EPS_MM || crossB > SNAP_EPS_MM) continue;

        const t0 = (e.a.x - c.a.x) * ux + (e.a.y - c.a.y) * uy;
        const t1 = (e.b.x - c.a.x) * ux + (e.b.y - c.a.y) * uy;
        const eLo = Math.max(0, Math.min(t0, t1));
        const eHi = Math.min(len, Math.max(t0, t1));
        if (eHi > eLo) {
          lo = Math.min(lo, eLo);
          hi = Math.max(hi, eHi);
        }
      }
      if (hi > lo) claims.push({ panelId: pe.id, lo, hi });
    }

    for (let i = 0; i < claims.length; i++) {
      for (let j = i + 1; j < claims.length; j++) {
        const a = claims[i]!;
        const b = claims[j]!;
        const lo = Math.max(a.lo, b.lo);
        const hi = Math.min(a.hi, b.hi);
        const overlapLen = hi - lo;
        if (overlapLen < MIN_HINGE_LENGTH_MM) continue;

        const axisPoint: Vec2 = { x: c.a.x + ux * lo, y: c.a.y + uy * lo };
        const hinge: Hinge = {
          id: `H${hingeIndex++}`,
          panelA: a.panelId,
          panelB: b.panelId,
          axisPoint,
          axisDir: { x: ux, y: uy },
          length: overlapLen,
          kind: c.kind
        };
        hinges.push(hinge);
        adjacency.get(a.panelId)!.push(b.panelId);
        adjacency.get(b.panelId)!.push(a.panelId);
      }
    }
  }

  return { hinges, adjacency };
}

export interface SpanningTreeResult {
  root: string;
  parentOf: Map<string, string>;
  depthOf: Map<string, number>;
  treeHinges: Hinge[];
  nonTreeHinges: Hinge[];
  orphanPanels: string[];
}

export function buildSpanningTree(panels: Panel[], graph: GraphResult): SpanningTreeResult {
  if (panels.length === 0) {
    return {
      root: '',
      parentOf: new Map(),
      depthOf: new Map(),
      treeHinges: [],
      nonTreeHinges: [],
      orphanPanels: []
    };
  }

  const root = panels.reduce((a, b) => (b.area > a.area ? b : a)).id;

  const hingeByPair = new Map<string, Hinge>();
  for (const h of graph.hinges) {
    hingeByPair.set(`${h.panelA}|${h.panelB}`, h);
    hingeByPair.set(`${h.panelB}|${h.panelA}`, h);
  }

  const parentOf = new Map<string, string>();
  const depthOf = new Map<string, number>([[root, 0]]);
  const visited = new Set<string>([root]);
  const treeHinges: Hinge[] = [];
  const queue: string[] = [root];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbour of graph.adjacency.get(current) ?? []) {
      if (visited.has(neighbour)) continue;
      visited.add(neighbour);
      parentOf.set(neighbour, current);
      depthOf.set(neighbour, (depthOf.get(current) ?? 0) + 1);
      const hinge = hingeByPair.get(`${current}|${neighbour}`);
      if (hinge) treeHinges.push(hinge);
      queue.push(neighbour);
    }
  }

  const treeHingeIds = new Set(treeHinges.map((h) => h.id));
  const nonTreeHinges = graph.hinges.filter((h) => !treeHingeIds.has(h.id));
  const orphanPanels = panels.filter((p) => !visited.has(p.id)).map((p) => p.id);

  return { root, parentOf, depthOf, treeHinges, nonTreeHinges, orphanPanels };
}
