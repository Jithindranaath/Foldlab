import type { ClassificationStrategy, LineKind, Segment, Vec2 } from './types.ts';

const CUT_NAMES = ['schneiden', 'cut', 'cutline', 'die', 'contour', 'thru-cut'];
const CREASE_NAMES = ['rillen', 'crease', 'score', 'fold', 'rill'];
const PERF_NAMES = ['rill-schnitt', 'perf', 'perforation', 'zipper'];

export function decodePdfName(name: string): string {
  const decoded = name.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  return decoded.toLowerCase();
}

export function classifyByName(name: string): LineKind | null {
  const n = decodePdfName(name);
  if (PERF_NAMES.some((s) => n.includes(s))) return 'perf';
  if (CUT_NAMES.some((s) => n.includes(s))) return 'cut';
  if (CREASE_NAMES.some((s) => n.includes(s))) return 'crease';
  return null;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

function rgbToHsv(rgb: Rgb): { h: number; s: number; v: number } {
  const { r, g, b } = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h, s, v };
}

export function classifyByHue(rgb: Rgb): LineKind | null {
  const { h, s, v } = rgbToHsv(rgb);
  if (s < 0.25 || v < 0.2) return null;
  if (h < 25 || h > 335) return 'cut';
  if (h > 85 && h < 170) return 'crease';
  if (h > 180 && h < 265) return 'perf';
  return null;
}

function segLength(s: Segment): number {
  return Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
}

function keyOf(p: Vec2, eps = 1e-3): string {
  return `${Math.round(p.x / eps)}:${Math.round(p.y / eps)}`;
}

/** Even-odd point-in-polygon test using a boundary formed by an arbitrary segment set. */
function pointInSegmentSet(p: Vec2, segs: Segment[]): boolean {
  let crossings = 0;
  for (const s of segs) {
    const { a, b } = s;
    const cond = a.y > p.y !== b.y > p.y;
    if (!cond) continue;
    const xCross = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
    if (xCross > p.x) crossings++;
  }
  return crossings % 2 === 1;
}

/**
 * Builds an undirected adjacency graph over segment endpoints and finds the
 * longest simple closed loop by total length. That loop is taken as the cut
 * contour; every other segment lying strictly inside it becomes a crease.
 */
function findLongestClosedLoop(segments: Segment[]): Segment[] {
  const adjacency = new Map<string, { point: Vec2; segs: Segment[] }>();
  for (const s of segments) {
    for (const p of [s.a, s.b]) {
      const k = keyOf(p);
      if (!adjacency.has(k)) adjacency.set(k, { point: p, segs: [] });
      adjacency.get(k)!.segs.push(s);
    }
  }

  // Group segments into connected components; within the largest by total
  // perimeter length, treat the whole component boundary as the contour.
  const visited = new Set<Segment>();
  let best: Segment[] = [];
  let bestLength = -Infinity;

  for (const s of segments) {
    if (visited.has(s)) continue;
    const component: Segment[] = [];
    const stack = [s];
    visited.add(s);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      component.push(cur);
      for (const endpoint of [cur.a, cur.b]) {
        const bucket = adjacency.get(keyOf(endpoint));
        if (!bucket) continue;
        for (const next of bucket.segs) {
          if (!visited.has(next)) {
            visited.add(next);
            stack.push(next);
          }
        }
      }
    }
    const total = component.reduce((sum, seg) => sum + segLength(seg), 0);
    if (total > bestLength) {
      bestLength = total;
      best = component;
    }
  }

  return best;
}

export function classifyByTopology(segments: Segment[]): Map<Segment, LineKind> {
  const result = new Map<Segment, LineKind>();
  const contour = findLongestClosedLoop(segments);
  const contourSet = new Set(contour);
  for (const s of contour) result.set(s, 'cut');

  for (const s of segments) {
    if (contourSet.has(s)) continue;
    const mid: Vec2 = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
    result.set(s, pointInSegmentSet(mid, contour) ? 'crease' : 'cut');
  }

  return result;
}

// --- Orchestration -------------------------------------------------------------

export interface RawSegment {
  a: Vec2;
  b: Vec2;
  source: string; // colorspace / layer name, may be empty
  rgb: Rgb | null;
}

export interface ClassifyResult {
  segments: Segment[];
  strategy: ClassificationStrategy;
}

export function classifySegments(raw: RawSegment[]): ClassifyResult {
  // Strategy 1: named colorspace / layer.
  const byName = raw.map((r) => ({ r, kind: r.source ? classifyByName(r.source) : null }));
  if (byName.some((x) => x.kind === 'crease')) {
    const segments: Segment[] = byName.map(({ r, kind }) => ({
      a: r.a,
      b: r.b,
      kind: kind ?? 'cut',
      source: r.source
    }));
    return { segments, strategy: 'colorspace' };
  }

  // Strategy 2: stroke hue.
  const byHue = raw.map((r) => ({ r, kind: r.rgb ? classifyByHue(r.rgb) : null }));
  if (byHue.some((x) => x.kind === 'crease')) {
    const segments: Segment[] = byHue.map(({ r, kind }) => ({
      a: r.a,
      b: r.b,
      kind: kind ?? 'cut',
      source: r.source
    }));
    return { segments, strategy: 'hue' };
  }

  // Strategy 3: topological fallback.
  const asSegments: Segment[] = raw.map((r) => ({ a: r.a, b: r.b, kind: 'cut', source: r.source }));
  const topo = classifyByTopology(asSegments);
  const segments: Segment[] = asSegments.map((s) => ({ ...s, kind: topo.get(s) ?? 'cut' }));
  return { segments, strategy: 'topology' };
}
