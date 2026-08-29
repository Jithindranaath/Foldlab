import type { AuditReport, FoldSchedule, Segment, Vec2 } from './types.ts';
import { buildEdgeIndex, worldPointForPanel } from './kinematics.ts';
import { CLOSURE_RESIDUAL_PASS_MM, ISOMETRY_EPS } from './units.ts';

export interface ExpectedFixture {
  segmentCounts: { total: number; cut: number; crease: number; perf: number };
  panelCount: number;
}

function countSegments(segments: Segment[]): AuditReport['segmentCounts'] {
  let cut = 0;
  let crease = 0;
  let perf = 0;
  for (const s of segments) {
    if (s.kind === 'cut') cut++;
    else if (s.kind === 'crease') crease++;
    else perf++;
  }
  return { total: segments.length, cut, crease, perf };
}

function polygonEdges(polygon: Vec2[]): { a: Vec2; b: Vec2 }[] {
  const edges: { a: Vec2; b: Vec2 }[] = [];
  for (let i = 0; i < polygon.length; i++) {
    edges.push({ a: polygon[i]!, b: polygon[(i + 1) % polygon.length]! });
  }
  return edges;
}

function computeClosureResidualMm(schedule: FoldSchedule): number | null {
  if (schedule.wallChain.length !== 4) return null;
  const ri = schedule.wallChain.indexOf(schedule.root);
  if (ri !== 1 && ri !== 2) return null;

  const panelsById = new Map(schedule.panels.map((p) => [p.id, p]));
  const { edgeByChild } = buildEdgeIndex(schedule);

  const oneHopId = ri === 1 ? schedule.wallChain[0]! : schedule.wallChain[3]!;
  const midId = ri === 1 ? schedule.wallChain[2]! : schedule.wallChain[1]!;
  const twoHopId = ri === 1 ? schedule.wallChain[3]! : schedule.wallChain[0]!;

  const oneHopEdge = edgeByChild.get(oneHopId);
  const twoHopEdge = edgeByChild.get(twoHopId);
  const oneHopPanel = panelsById.get(oneHopId);
  const twoHopPanel = panelsById.get(twoHopId);
  if (!oneHopEdge || !twoHopEdge || !oneHopPanel || !twoHopPanel) return null;
  if (oneHopEdge.parent !== schedule.root || twoHopEdge.parent !== midId) return null;

  const farPoint = (
    panel: { bbox: { x: number; y: number; w: number; h: number } },
    hingeAxisPoint: Vec2,
    hingeAxisDir: Vec2,
    hingeLength: number
  ): Vec2 => {
    const center: Vec2 = { x: panel.bbox.x + panel.bbox.w / 2, y: panel.bbox.y + panel.bbox.h / 2 };
    const mid: Vec2 = {
      x: hingeAxisPoint.x + hingeAxisDir.x * (hingeLength / 2),
      y: hingeAxisPoint.y + hingeAxisDir.y * (hingeLength / 2)
    };
    return { x: 2 * center.x - mid.x, y: 2 * center.y - mid.y };
  };

  const oneHopFar = farPoint(oneHopPanel, oneHopEdge.hinge.axisPoint, oneHopEdge.hinge.axisDir, oneHopEdge.hinge.length);
  const twoHopFar = farPoint(twoHopPanel, twoHopEdge.hinge.axisPoint, twoHopEdge.hinge.axisDir, twoHopEdge.hinge.length);

  const p1 = worldPointForPanel(oneHopId, oneHopFar, 1, edgeByChild);
  const p2 = worldPointForPanel(twoHopId, twoHopFar, 1, edgeByChild);

  return Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
}

function computeIsometryDriftMax(schedule: FoldSchedule): number | null {
  if (schedule.panels.length === 0) return null;
  const { edgeByChild } = buildEdgeIndex(schedule);
  const SAMPLES = 24;
  let maxDrift = 0;

  for (const panel of schedule.panels) {
    for (const edge of polygonEdges(panel.polygon)) {
      const flatLen = Math.hypot(edge.b.x - edge.a.x, edge.b.y - edge.a.y);
      if (flatLen < 1e-6) continue;
      for (let i = 0; i <= SAMPLES; i++) {
        const t = i / SAMPLES;
        const pa = worldPointForPanel(panel.id, edge.a, t, edgeByChild);
        const pb = worldPointForPanel(panel.id, edge.b, t, edgeByChild);
        const len = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
        const drift = Math.abs(len - flatLen) / flatLen;
        if (drift > maxDrift) maxDrift = drift;
      }
    }
  }
  return maxDrift;
}

export function computeAudit(schedule: FoldSchedule, expected: ExpectedFixture | null): AuditReport {
  const orphanPanels = schedule.orphanPanels;
  const segmentCounts = countSegments(schedule.segments);
  const closureResidualMm = computeClosureResidualMm(schedule);
  const isometryDriftMax = computeIsometryDriftMax(schedule);

  const caliperGapMm = Math.abs(schedule.dims.measuredPair[0] - schedule.dims.measuredPair[1]);
  const closureResidualExplainedByCaliper =
    closureResidualMm !== null && caliperGapMm > 0.05 && Math.abs(closureResidualMm - caliperGapMm) < 0.3;

  return {
    segmentCounts,
    expectedSegmentCounts: expected?.segmentCounts ?? null,
    panelCount: schedule.panels.length,
    expectedPanelCount: expected?.panelCount ?? null,
    classificationStrategy: schedule.classificationStrategy,
    dims: schedule.dims,
    perimeterIdentity: schedule.perimeterIdentity,
    closureResidualMm,
    closureResidualPass: closureResidualMm !== null && closureResidualMm < CLOSURE_RESIDUAL_PASS_MM,
    closureResidualExplainedByCaliper,
    isometryDriftMax,
    isometryPass: isometryDriftMax !== null && isometryDriftMax < ISOMETRY_EPS,
    orphanPanels
  };
}
