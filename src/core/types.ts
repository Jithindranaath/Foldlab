// Pure geometry/data types for the FoldLab core pipeline.
// This module (and everything else under src/core) must never import React or Three.js.

export interface Vec2 {
  x: number;
  y: number;
}

export type LineKind = 'cut' | 'crease' | 'perf';

export interface Segment {
  a: Vec2;
  b: Vec2;
  kind: LineKind;
  source: string;
}

export type PanelRole = 'wall' | 'endClosure' | 'tuck' | 'lock' | 'glue' | 'unknown';

export interface Panel {
  id: string;
  polygon: Vec2[]; // CCW, collinear vertices collapsed
  bbox: { x: number; y: number; w: number; h: number };
  area: number; // mm^2
  role: PanelRole;
}

export interface Hinge {
  id: string;
  panelA: string;
  panelB: string;
  axisPoint: Vec2; // a point on the crease line, in world (sheet) space
  axisDir: Vec2; // unit vector along the crease
  length: number; // mm
  kind: LineKind;
}

export interface FoldEdge {
  hinge: Hinge;
  parent: string;
  child: string;
  targetAngle: number; // radians, negative = folds inward (toward -Z of parent local frame)
  depth: number;
  start: number; // stagger start, normalised time [0,1]
  duration: number; // normalised time
}

export interface FoldSchedule {
  root: string;
  panels: Panel[];
  edges: FoldEdge[];
  nonTreeHinges: Hinge[]; // closure constraints — measured, never driven
  orphanPanels: string[]; // panels the hinge graph never reached
  dims: { L: number; H: number; D: number; measuredPair: [number, number] };
  perimeterIdentity: {
    sumOfWidths: number;
    twiceAPlusB: number;
    a: number;
    b: number;
    holds: boolean;
  } | null;
  wallChain: string[];
  classificationStrategy: ClassificationStrategy;
  segments: Segment[];
}

export type ClassificationStrategy = 'colorspace' | 'hue' | 'topology';

export interface ExtractResult {
  segments: Segment[];
  bbox: { x: number; y: number; w: number; h: number };
  raw: { straight: number; curve: number };
}

export interface AuditReport {
  segmentCounts: { total: number; cut: number; crease: number; perf: number };
  expectedSegmentCounts: { total: number; cut: number; crease: number; perf: number } | null;
  panelCount: number;
  expectedPanelCount: number | null;
  classificationStrategy: ClassificationStrategy;
  dims: { L: number; H: number; D: number; measuredPair: [number, number] };
  perimeterIdentity: {
    sumOfWidths: number;
    twiceAPlusB: number;
    a: number;
    b: number;
    holds: boolean;
  } | null;
  closureResidualMm: number | null;
  closureResidualPass: boolean;
  /** True when the residual is fully accounted for by the measured pair's
   * own caliper asymmetry (|measuredPair[0] - measuredPair[1]|) rather than
   * being an unexplained parse/fold error. */
  closureResidualExplainedByCaliper: boolean;
  isometryDriftMax: number | null;
  isometryPass: boolean;
  orphanPanels: string[];
}
