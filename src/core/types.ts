
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
  polygon: Vec2[];
  bbox: { x: number; y: number; w: number; h: number };
  area: number;
  role: PanelRole;
}

export interface Hinge {
  id: string;
  panelA: string;
  panelB: string;
  axisPoint: Vec2;
  axisDir: Vec2;
  length: number;
  kind: LineKind;
}

export interface FoldEdge {
  hinge: Hinge;
  parent: string;
  child: string;
  targetAngle: number;
  depth: number;
  start: number;
  duration: number;
}

export interface FoldSchedule {
  root: string;
  panels: Panel[];
  edges: FoldEdge[];
  nonTreeHinges: Hinge[];
  orphanPanels: string[];
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

  closureResidualExplainedByCaliper: boolean;
  isometryDriftMax: number | null;
  isometryPass: boolean;
  orphanPanels: string[];
}
