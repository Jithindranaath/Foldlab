
import type { FoldEdge, FoldSchedule, Vec2 } from './types.ts';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function embed(v: Vec2): Vec3 {
  return { x: v.x, y: v.y, z: 0 };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

export function vec3Length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

export function rotateAroundAxis(
  point: Vec3,
  axisPoint: Vec3,
  axisDir: Vec3,
  angle: number
): Vec3 {
  const v = sub(point, axisPoint);
  const cosT = Math.cos(angle);
  const sinT = Math.sin(angle);
  const term1 = scale(v, cosT);
  const term2 = scale(cross(axisDir, v), sinT);
  const term3 = scale(axisDir, dot(axisDir, v) * (1 - cosT));
  return add(axisPoint, add(term1, add(term2, term3)));
}

export function easeInOutCubic(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

export function angleAtT(edge: FoldEdge, t: number): number {
  const progress = (t - edge.start) / edge.duration;
  return edge.targetAngle * easeInOutCubic(progress);
}

export function buildEdgeIndex(schedule: FoldSchedule): {
  edgeByChild: Map<string, FoldEdge>;
} {
  const edgeByChild = new Map<string, FoldEdge>();
  for (const e of schedule.edges) edgeByChild.set(e.child, e);
  return { edgeByChild };
}

export function pathToRoot(
  panelId: string,
  edgeByChild: Map<string, FoldEdge>
): FoldEdge[] {
  const path: FoldEdge[] = [];
  let current = panelId;
  const edge = edgeByChild.get(current);
  let cursor = edge;
  while (cursor) {
    path.push(cursor);
    current = cursor.parent;
    cursor = edgeByChild.get(current);
  }
  return path;
}

export function worldPointForPanel(
  panelId: string,
  flatPoint: Vec2,
  t: number,
  edgeByChild: Map<string, FoldEdge>
): Vec3 {
  const path = pathToRoot(panelId, edgeByChild);
  let p = embed(flatPoint);
  for (const edge of path) {
    const theta = angleAtT(edge, t);
    p = rotateAroundAxis(p, embed(edge.hinge.axisPoint), embed(edge.hinge.axisDir), theta);
  }
  return p;
}

export function worldDirectionForPanel(
  panelId: string,
  flatDir: Vec3,
  t: number,
  edgeByChild: Map<string, FoldEdge>
): Vec3 {
  const path = pathToRoot(panelId, edgeByChild);
  const origin: Vec3 = { x: 0, y: 0, z: 0 };
  let d = flatDir;
  for (const edge of path) {
    const theta = angleAtT(edge, t);
    d = rotateAroundAxis(d, origin, embed(edge.hinge.axisDir), theta);
  }
  return d;
}
