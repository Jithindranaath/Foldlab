import type { LineKind, Panel, Segment, Vec2 } from './types.ts';
import { MIN_PANEL_AREA_MM2, SNAP_EPS_MM, snap } from './units.ts';

interface SnappedSegment {
  a: Vec2;
  b: Vec2;
  kind: LineKind;
}

function snapSegments(segments: Segment[]): SnappedSegment[] {
  return segments
    .filter((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) > 1e-6)
    .map((s) => ({
      a: { x: snap(s.a.x), y: snap(s.a.y) },
      b: { x: snap(s.b.x), y: snap(s.b.y) },
      kind: s.kind
    }))
    .filter((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) > 1e-6);
}

function uniqueSorted(values: number[]): number[] {
  const out: number[] = [];
  const sorted = [...values].sort((a, b) => a - b);
  for (const v of sorted) {
    if (out.length === 0 || Math.abs(v - out[out.length - 1]!) > SNAP_EPS_MM / 2) {
      out.push(v);
    }
  }
  return out;
}

function pointInside(p: Vec2, segments: SnappedSegment[]): boolean {
  let crossings = 0;
  for (const s of segments) {
    const { a, b } = s;
    const crosses = a.y > p.y !== b.y > p.y;
    if (!crosses) continue;
    const xAtY = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
    if (xAtY > p.x) crossings++;
  }
  return crossings % 2 === 1;
}

function edgeCovered(
  p0: Vec2,
  p1: Vec2,
  segments: SnappedSegment[]
): boolean {
  const horizontal = Math.abs(p0.y - p1.y) < 1e-6;
  const lo = horizontal ? Math.min(p0.x, p1.x) : Math.min(p0.y, p1.y);
  const hi = horizontal ? Math.max(p0.x, p1.x) : Math.max(p0.y, p1.y);
  const fixed = horizontal ? p0.y : p0.x;

  for (const s of segments) {
    const sHorizontal = Math.abs(s.a.y - s.b.y) < 1e-6;
    const sVertical = Math.abs(s.a.x - s.b.x) < 1e-6;
    if (horizontal && sHorizontal && Math.abs(s.a.y - fixed) < 1e-6) {
      const sLo = Math.min(s.a.x, s.b.x);
      const sHi = Math.max(s.a.x, s.b.x);
      if (sLo <= lo + 1e-6 && sHi >= hi - 1e-6) return true;
    } else if (!horizontal && sVertical && Math.abs(s.a.x - fixed) < 1e-6) {
      const sLo = Math.min(s.a.y, s.b.y);
      const sHi = Math.max(s.a.y, s.b.y);
      if (sLo <= lo + 1e-6 && sHi >= hi - 1e-6) return true;
    }
  }
  return false;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      const p = this.parent[i]!;
      this.parent[i] = this.parent[p]!;
      i = p;
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

function collapseCollinear(polygon: Vec2[]): Vec2[] {
  if (polygon.length < 3) return polygon;
  const out: Vec2[] = [];
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const prev = polygon[(i - 1 + n) % n]!;
    const cur = polygon[i]!;
    const next = polygon[(i + 1) % n]!;
    const d1x = cur.x - prev.x;
    const d1y = cur.y - prev.y;
    const d2x = next.x - cur.x;
    const d2y = next.y - cur.y;
    const cross = d1x * d2y - d1y * d2x;
    const len1 = Math.hypot(d1x, d1y);
    const len2 = Math.hypot(d2x, d2y);
    if (len1 < 1e-9 || len2 < 1e-9) continue;
    if (Math.abs(cross) / (len1 * len2) < 1e-9) continue;
    out.push(cur);
  }
  return out.length >= 3 ? out : polygon;
}

function traceBoundary(cellRects: { x0: number; x1: number; y0: number; y1: number }[]): Vec2[] {
  type Edge = { a: Vec2; b: Vec2 };
  const edgeKey = (a: Vec2, b: Vec2): string =>
    `${a.x.toFixed(4)},${a.y.toFixed(4)}->${b.x.toFixed(4)},${b.y.toFixed(4)}`;

  const allEdges: Edge[] = [];
  for (const r of cellRects) {
    allEdges.push({ a: { x: r.x0, y: r.y0 }, b: { x: r.x1, y: r.y0 } }); // bottom
    allEdges.push({ a: { x: r.x1, y: r.y0 }, b: { x: r.x1, y: r.y1 } }); // right
    allEdges.push({ a: { x: r.x1, y: r.y1 }, b: { x: r.x0, y: r.y1 } }); // top
    allEdges.push({ a: { x: r.x0, y: r.y1 }, b: { x: r.x0, y: r.y0 } }); // left
  }

  // An edge with a reverse counterpart elsewhere in the set is shared between
  // two cells (internal); keep only edges whose reverse is absent.
  const forwardKeys = new Set(allEdges.map((e) => edgeKey(e.a, e.b)));
  const outerEdges = allEdges.filter((e) => !forwardKeys.has(edgeKey(e.b, e.a)));

  // Walk outerEdges into an ordered polygon (they form one or more loops;
  // take the largest by point count — panels here are simply connected).
  const byStart = new Map<string, Edge[]>();
  const ptKey = (p: Vec2): string => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
  for (const e of outerEdges) {
    const k = ptKey(e.a);
    if (!byStart.has(k)) byStart.set(k, []);
    byStart.get(k)!.push(e);
  }

  const used = new Set<Edge>();
  let bestLoop: Vec2[] = [];
  for (const start of outerEdges) {
    if (used.has(start)) continue;
    const loop: Vec2[] = [start.a];
    let current = start;
    used.add(current);
    for (let guard = 0; guard < outerEdges.length + 1; guard++) {
      loop.push(current.b);
      if (ptKey(current.b) === ptKey(start.a)) break;
      const candidates = (byStart.get(ptKey(current.b)) ?? []).filter((e) => !used.has(e));
      const next = candidates[0];
      if (!next) break;
      used.add(next);
      current = next;
    }
    if (loop.length > bestLoop.length) bestLoop = loop;
  }

  bestLoop.pop(); // drop the closing duplicate of the start point
  return collapseCollinear(bestLoop);
}

export interface DecomposeResult {
  panels: Panel[];
  cellsPerPanel: number[];
}

export function decomposePanels(segments: Segment[]): DecomposeResult {
  const snapped = snapSegments(segments);
  const cutSegs = snapped.filter((s) => s.kind === 'cut');
  const allSegs = snapped;

  const xs = uniqueSorted(snapped.flatMap((s) => [s.a.x, s.b.x]));
  const ys = uniqueSorted(snapped.flatMap((s) => [s.a.y, s.b.y]));

  interface Cell {
    col: number;
    row: number;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
  }
  // Every column/row is kept here, even ones thinner than
  // MIN_CELL_THICKNESS_MM (a chamfer or a notch elsewhere on the sheet
  // injects thin grid lines that are irrelevant far away in Y or X — e.g. a
  // thumb-notch circle mid-sheet creates thin X columns that also slice
  // through an unrelated wall panel's row). Dropping thin columns/rows
  // outright — instead of just letting union-find merge them away where
  // nothing actually separates them — used to leave real panels missing
  // cells and split into disconnected fragments. Genuine chamfer slivers
  // are still excluded, just later: either the material test rejects them
  // (outside the cut contour) or MIN_PANEL_AREA_MM2 drops them if they
  // truly don't merge into anything larger.
  const cells: Cell[] = [];
  for (let col = 0; col < xs.length - 1; col++) {
    const x0 = xs[col]!;
    const x1 = xs[col + 1]!;
    for (let row = 0; row < ys.length - 1; row++) {
      const y0 = ys[row]!;
      const y1 = ys[row + 1]!;
      cells.push({ col, row, x0, x1, y0, y1 });
    }
  }

  const materialCells = cells.filter((c) => {
    const center = { x: (c.x0 + c.x1) / 2, y: (c.y0 + c.y1) / 2 };
    return pointInside(center, cutSegs);
  });

  const uf = new UnionFind(materialCells.length);
  const cellIndexByKey = new Map<string, number>();
  materialCells.forEach((c, i) => cellIndexByKey.set(`${c.col}:${c.row}`, i));

  for (let i = 0; i < materialCells.length; i++) {
    const c = materialCells[i]!;
    // Right neighbour
    const rightKey = `${c.col + 1}:${c.row}`;
    const rightIdx = cellIndexByKey.get(rightKey);
    if (rightIdx !== undefined) {
      const shared = edgeCovered({ x: c.x1, y: c.y0 }, { x: c.x1, y: c.y1 }, allSegs);
      if (!shared) uf.union(i, rightIdx);
    }
    // Top neighbour
    const topKey = `${c.col}:${c.row + 1}`;
    const topIdx = cellIndexByKey.get(topKey);
    if (topIdx !== undefined) {
      const shared = edgeCovered({ x: c.x0, y: c.y1 }, { x: c.x1, y: c.y1 }, allSegs);
      if (!shared) uf.union(i, topIdx);
    }
  }

  const groups = new Map<number, Cell[]>();
  for (let i = 0; i < materialCells.length; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(materialCells[i]!);
  }

  const panels: Panel[] = [];
  const cellsPerPanel: number[] = [];
  let index = 0;
  for (const group of groups.values()) {
    const area = group.reduce((sum, c) => sum + (c.x1 - c.x0) * (c.y1 - c.y0), 0);
    if (area < MIN_PANEL_AREA_MM2) continue;

    const xMin = Math.min(...group.map((c) => c.x0));
    const xMax = Math.max(...group.map((c) => c.x1));
    const yMin = Math.min(...group.map((c) => c.y0));
    const yMax = Math.max(...group.map((c) => c.y1));

    const polygon = traceBoundary(group.map((c) => ({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 })));

    panels.push({
      id: `PANEL_${index}`,
      polygon,
      bbox: { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin },
      area,
      role: 'unknown'
    });
    cellsPerPanel.push(group.length);
    index++;
  }

  return { panels, cellsPerPanel };
}
