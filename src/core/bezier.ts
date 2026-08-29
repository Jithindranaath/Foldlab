import type { Vec2 } from './types.ts';

const CHORD_TOLERANCE_MM = 0.05;
const MAX_RECURSION = 8;

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function pointLineDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  const cross = Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy);
  return cross / Math.sqrt(lenSq);
}

function subdivide(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  depth: number,
  out: Vec2[]
): void {
  const flatEnoughByControls =
    pointLineDistance(p1, p0, p3) <= CHORD_TOLERANCE_MM &&
    pointLineDistance(p2, p0, p3) <= CHORD_TOLERANCE_MM;

  if (depth >= MAX_RECURSION || flatEnoughByControls) {
    out.push(p3);
    return;
  }

  const p01 = lerp(p0, p1, 0.5);
  const p12 = lerp(p1, p2, 0.5);
  const p23 = lerp(p2, p3, 0.5);
  const p012 = lerp(p01, p12, 0.5);
  const p123 = lerp(p12, p23, 0.5);
  const p0123 = lerp(p012, p123, 0.5);

  subdivide(p0, p01, p012, p0123, depth + 1, out);
  subdivide(p0123, p123, p23, p3, depth + 1, out);
}

export function flattenCubicBezier(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2): Vec2[] {
  const out: Vec2[] = [];
  subdivide(p0, p1, p2, p3, 0, out);
  return out;
}
