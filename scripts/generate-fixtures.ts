
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { decomposePanels } from '../src/core/panels.ts';
import { solveFoldSchedule } from '../src/core/solver.ts';
import { computeAudit } from '../src/core/audit.ts';
import { flattenCubicBezier } from '../src/core/bezier.ts';
import { PT_PER_MM } from '../src/core/units.ts';
import type { LineKind, Segment, Vec2 } from '../src/core/types.ts';

interface PanelSpec {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const PANELS: PanelSpec[] = [
  { id: 'P_FRONT', x: 93.5, y: 124.5, w: 154, h: 95 },
  { id: 'P_SIDE_A', x: 93.5, y: 219.5, w: 154, h: 16.5 },
  { id: 'P_BACK', x: 93.5, y: 236, w: 154, h: 95 },
  { id: 'P_SIDE_B', x: 93.5, y: 108, w: 154, h: 16.5 },
  { id: 'P_TAB_TOP', x: 139.5, y: 331, w: 62, h: 14 },
  { id: 'P_END_L', x: 77, y: 124.5, w: 16.5, h: 95 },
  { id: 'P_END_R', x: 247.5, y: 124.5, w: 16.5, h: 95 },
  { id: 'P_TUCK_L', x: 0, y: 126, w: 77, h: 91 },
  { id: 'P_TUCK_R', x: 264, y: 126, w: 77, h: 91 },
  { id: 'P_LOCK_1', x: 93.5, y: 68, w: 153, h: 40 },
  { id: 'P_LOCK_2', x: 94.5, y: 52, w: 152, h: 16 },
  { id: 'P_LOCK_3', x: 94.5, y: 23, w: 152, h: 29 },
  { id: 'P_GLUE_1', x: 94.5, y: 7, w: 51, h: 16 },
  { id: 'P_GLUE_2', x: 94.5, y: 0, w: 43, h: 7 }
];

const SHEET_W = 341;
const SHEET_H = 345;

function uniq(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || Math.abs(v - out[out.length - 1]!) > 1e-6) out.push(v);
  }
  return out;
}

const xs = uniq(PANELS.flatMap((p) => [p.x, p.x + p.w]));
const ys = uniq(PANELS.flatMap((p) => [p.y, p.y + p.h]));

interface Cell {
  col: number;
  row: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  owner: string | null;
}

const cells: Cell[][] = [];
for (let col = 0; col < xs.length - 1; col++) {
  const x0 = xs[col]!;
  const x1 = xs[col + 1]!;
  const colCells: Cell[] = [];
  for (let row = 0; row < ys.length - 1; row++) {
    const y0 = ys[row]!;
    const y1 = ys[row + 1]!;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const owner = PANELS.find((p) => cx > p.x && cx < p.x + p.w && cy > p.y && cy < p.y + p.h);
    colCells.push({ col, row, x0, x1, y0, y1, owner: owner ? owner.id : null });
  }
  cells.push(colCells);
}

function cellAt(col: number, row: number): Cell | null {
  if (col < 0 || col >= cells.length) return null;
  const colCells = cells[col];
  if (!colCells || row < 0 || row >= colCells.length) return null;
  return colCells[row]!;
}

interface RawEdge {
  a: Vec2;
  b: Vec2;
  kind: 'cut' | 'crease';
}

const rawEdges: RawEdge[] = [];
const dedupe = new Set<string>();

function edgeKey(a: Vec2, b: Vec2): string {
  const pts = [a, b].sort((p, q) => p.x - q.x || p.y - q.y);
  return `${pts[0]!.x.toFixed(3)},${pts[0]!.y.toFixed(3)}|${pts[1]!.x.toFixed(3)},${pts[1]!.y.toFixed(3)}`;
}

for (const col of cells) {
  for (const cell of col) {
    if (!cell.owner) continue;

    const neighbours: { dir: [number, number]; a: Vec2; b: Vec2 }[] = [
      { dir: [1, 0], a: { x: cell.x1, y: cell.y0 }, b: { x: cell.x1, y: cell.y1 } }, // right
      { dir: [-1, 0], a: { x: cell.x0, y: cell.y0 }, b: { x: cell.x0, y: cell.y1 } }, // left
      { dir: [0, 1], a: { x: cell.x0, y: cell.y1 }, b: { x: cell.x1, y: cell.y1 } }, // top
      { dir: [0, -1], a: { x: cell.x0, y: cell.y0 }, b: { x: cell.x1, y: cell.y0 } } // bottom
    ];

    for (const n of neighbours) {
      const neighbourCell = cellAt(cell.col + n.dir[0], cell.row + n.dir[1]);
      const neighbourOwner = neighbourCell?.owner ?? null;
      if (neighbourOwner === cell.owner) continue;

      const key = edgeKey(n.a, n.b);
      if (dedupe.has(key)) continue;
      dedupe.add(key);

      rawEdges.push({ a: n.a, b: n.b, kind: neighbourOwner ? 'crease' : 'cut' });
    }
  }
}

/** Merge contiguous collinear raw edges of the same kind along a shared grid
 * line into longer runs, matching how a real die would draw one long line
 * rather than many one-cell fragments. */
function mergeEdges(edges: RawEdge[]): RawEdge[] {
  const horizontal = edges.filter((e) => Math.abs(e.a.y - e.b.y) < 1e-6);
  const vertical = edges.filter((e) => Math.abs(e.a.x - e.b.x) < 1e-6);

  function mergeGroup(group: RawEdge[], axis: 'h' | 'v'): RawEdge[] {
    const byLine = new Map<string, RawEdge[]>();
    for (const e of group) {
      const fixed = axis === 'h' ? e.a.y : e.a.x;
      const key = `${fixed.toFixed(3)}|${e.kind}`;
      if (!byLine.has(key)) byLine.set(key, []);
      byLine.get(key)!.push(e);
    }
    const out: RawEdge[] = [];
    for (const line of byLine.values()) {
      const sorted = line.sort((p, q) => {
        const pv = axis === 'h' ? Math.min(p.a.x, p.b.x) : Math.min(p.a.y, p.b.y);
        const qv = axis === 'h' ? Math.min(q.a.x, q.b.x) : Math.min(q.a.y, q.b.y);
        return pv - qv;
      });
      let run: RawEdge | null = null;
      for (const e of sorted) {
        const lo = axis === 'h' ? Math.min(e.a.x, e.b.x) : Math.min(e.a.y, e.b.y);
        const hi = axis === 'h' ? Math.max(e.a.x, e.b.x) : Math.max(e.a.y, e.b.y);
        if (!run) {
          run = { ...e };
          continue;
        }
        const runHi = axis === 'h' ? Math.max(run.a.x, run.b.x) : Math.max(run.a.y, run.b.y);
        if (Math.abs(lo - runHi) < 1e-6) {
          if (axis === 'h') {
            run.b = { x: hi, y: run.a.y };
          } else {
            run.b = { x: run.a.x, y: hi };
          }
        } else {
          out.push(run);
          run = { ...e };
        }
      }
      if (run) out.push(run);
    }
    return out;
  }

  return [...mergeGroup(horizontal, 'h'), ...mergeGroup(vertical, 'v')];
}

const mergedEdges = mergeEdges(rawEdges);

// ---------------------------------------------------------------------------
// 4. One perforation: the P_LOCK_3 / P_GLUE_1 border becomes a tear line.
// ---------------------------------------------------------------------------

type FinalKind = LineKind;
interface StraightSeg {
  kind: FinalKind;
  a: Vec2;
  b: Vec2;
}
interface CurveSeg {
  kind: FinalKind;
  p0: Vec2;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
}

const straights: StraightSeg[] = mergedEdges.map((e) => ({ kind: e.kind, a: e.a, b: e.b }));

const perfTarget = straights.find(
  (s) => Math.abs(s.a.y - 23) < 1e-3 && Math.abs(s.b.y - 23) < 1e-3 && Math.min(s.a.x, s.b.x) > 90 && Math.max(s.a.x, s.b.x) < 150
);
if (!perfTarget) throw new Error('Could not locate the P_LOCK_3 / P_GLUE_1 border to mark as perforation');
perfTarget.kind = 'perf';

// ---------------------------------------------------------------------------
// 5. Rounded corners on P_TAB_TOP's two outer top corners (12 cubic Beziers)
// ---------------------------------------------------------------------------

const CORNER_RADIUS = 3;
const ARC_SEGMENTS = 6;

function arcToBeziers(center: Vec2, r: number, a0: number, a1: number, n: number): CurveSeg[] {
  const out: CurveSeg[] = [];
  const delta = (a1 - a0) / n;
  for (let i = 0; i < n; i++) {
    const s0 = a0 + delta * i;
    const s1 = a0 + delta * (i + 1);
    const p0 = { x: center.x + r * Math.cos(s0), y: center.y + r * Math.sin(s0) };
    const p3 = { x: center.x + r * Math.cos(s1), y: center.y + r * Math.sin(s1) };
    const kappa = (4 / 3) * Math.tan((s1 - s0) / 4);
    const p1 = { x: p0.x - kappa * r * Math.sin(s0), y: p0.y + kappa * r * Math.cos(s0) };
    const p2 = { x: p3.x + kappa * r * Math.sin(s1), y: p3.y - kappa * r * Math.cos(s1) };
    out.push({ kind: 'cut', p0, p1, p2, p3 });
  }
  return out;
}

function findSeg(ax: number, ay: number, bx: number, by: number): StraightSeg {
  const found = straights.find(
    (s) =>
      (Math.abs(s.a.x - ax) < 1e-3 && Math.abs(s.a.y - ay) < 1e-3 && Math.abs(s.b.x - bx) < 1e-3 && Math.abs(s.b.y - by) < 1e-3) ||
      (Math.abs(s.a.x - bx) < 1e-3 && Math.abs(s.a.y - by) < 1e-3 && Math.abs(s.b.x - ax) < 1e-3 && Math.abs(s.b.y - ay) < 1e-3)
  );
  if (!found) throw new Error(`Could not locate segment (${ax},${ay})-(${bx},${by}) for corner rounding`);
  return found;
}

const curves: CurveSeg[] = [];

{
  // Top-left corner of P_TAB_TOP at (139.5, 345).
  const left = findSeg(139.5, 331, 139.5, 345); // vertical
  const top = findSeg(139.5, 345, 201.5, 345); // horizontal
  left.b = { x: 139.5, y: 345 - CORNER_RADIUS };
  top.a = { x: 139.5 + CORNER_RADIUS, y: 345 };
  const center = { x: 139.5 + CORNER_RADIUS, y: 345 - CORNER_RADIUS };
  curves.push(...arcToBeziers(center, CORNER_RADIUS, Math.PI, Math.PI / 2, ARC_SEGMENTS));
}
{
  // Top-right corner of P_TAB_TOP at (201.5, 345).
  const top = findSeg(139.5 + CORNER_RADIUS, 345, 201.5, 345); // horizontal, already trimmed above at its start
  const right = findSeg(201.5, 331, 201.5, 345); // vertical
  top.b = { x: 201.5 - CORNER_RADIUS, y: 345 };
  right.b = { x: 201.5, y: 345 - CORNER_RADIUS };
  const center = { x: 201.5 - CORNER_RADIUS, y: 345 - CORNER_RADIUS };
  curves.push(...arcToBeziers(center, CORNER_RADIUS, Math.PI / 2, 0, ARC_SEGMENTS));
}

if (curves.length !== 12) throw new Error(`Expected 12 curve segments, got ${curves.length}`);

// ---------------------------------------------------------------------------
// 6. Validate against the real core pipeline before writing anything.
// ---------------------------------------------------------------------------

function flattenForPipeline(): Segment[] {
  const out: Segment[] = [];
  for (const s of straights) {
    out.push({ a: s.a, b: s.b, kind: s.kind, source: s.kind });
  }
  for (const c of curves) {
    const poly = flattenCubicBezier(c.p0, c.p1, c.p2, c.p3);
    let prev = c.p0;
    for (const pt of poly) {
      out.push({ a: prev, b: pt, kind: c.kind, source: c.kind });
      prev = pt;
    }
  }
  return out;
}

const pipelineSegments = flattenForPipeline();
const { panels } = decomposePanels(pipelineSegments);

if (panels.length !== 14) {
  throw new Error(`Fixture validation failed: expected 14 panels, decomposed ${panels.length}`);
}

const schedule = solveFoldSchedule({
  panels,
  segments: pipelineSegments,
  classificationStrategy: 'hue'
});

const audit = computeAudit(schedule, null);

console.log('--- Fixture validation ---');
console.log('Panels:', audit.panelCount);
console.log('Segments:', audit.segmentCounts);
console.log('Dims:', schedule.dims);
console.log('Perimeter identity:', schedule.perimeterIdentity);
console.log('Closure residual (mm):', audit.closureResidualMm);
console.log('Isometry drift (max):', audit.isometryDriftMax);
console.log('Orphan panels:', schedule.orphanPanels);

if (audit.panelCount !== 14) throw new Error('Panel count check failed');
if (!schedule.perimeterIdentity?.holds) throw new Error('Perimeter identity does not hold');
if (audit.closureResidualMm === null || !audit.closureResidualPass) {
  throw new Error(`Closure residual check failed: ${audit.closureResidualMm}`);
}
if (audit.isometryDriftMax === null || !audit.isometryPass) {
  throw new Error(`Isometry drift check failed: ${audit.isometryDriftMax}`);
}
if (schedule.orphanPanels.length > 0) throw new Error('Fold graph is not connected');

console.log('Fixture validation PASSED.\n');

// ---------------------------------------------------------------------------
// 7. Write src/core/sampleExpectations.ts (single source of truth).
// ---------------------------------------------------------------------------

const expectationsSource = `

export const SAMPLE_EXPECTATIONS = {
  segmentCounts: ${JSON.stringify(audit.segmentCounts)},
  panelCount: ${audit.panelCount},
  dims: { L: ${schedule.dims.L}, H: ${round(schedule.dims.H)}, D: ${round(schedule.dims.D)} }
} as const;
`;

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

mkdirSync('src/core', { recursive: true });
writeFileSync('src/core/sampleExpectations.ts', expectationsSource);

// ---------------------------------------------------------------------------
// 8. Write the PDF fixture.
// ---------------------------------------------------------------------------

function mmToPt(v: number): number {
  return round4(v * PT_PER_MM);
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

const HUE: Record<FinalKind, [number, number, number]> = {
  cut: [0.85, 0.08, 0.08],
  crease: [0.1, 0.75, 0.25],
  perf: [0.15, 0.3, 0.85]
};
const SEP_NAME: Record<FinalKind, string> = {
  cut: 'Schneiden',
  crease: 'Rillen',
  perf: 'Rill-Schnitt#2010x10' // decodes to "Rill-Schnitt 10x10"
};
const CS_OBJ: Record<FinalKind, number> = { cut: 5, crease: 6, perf: 7 };
const FN_OBJ: Record<FinalKind, number> = { cut: 8, crease: 9, perf: 10 };

function buildContentStream(): string {
  const kinds: FinalKind[] = ['cut', 'crease', 'perf'];
  let content = '';
  for (const kind of kinds) {
    const segs = straights.filter((s) => s.kind === kind);
    const crvs = curves.filter((c) => c.kind === kind);
    if (segs.length === 0 && crvs.length === 0) continue;

    content += `q\n/CS${kind} CS\n1 SCN\n0.5 w\n`;
    for (const s of segs) {
      content += `${mmToPt(s.a.x)} ${mmToPt(s.a.y)} m\n${mmToPt(s.b.x)} ${mmToPt(s.b.y)} l\n`;
    }
    for (const c of crvs) {
      content += `${mmToPt(c.p0.x)} ${mmToPt(c.p0.y)} m\n`;
      content += `${mmToPt(c.p1.x)} ${mmToPt(c.p1.y)} ${mmToPt(c.p2.x)} ${mmToPt(c.p2.y)} ${mmToPt(c.p3.x)} ${mmToPt(c.p3.y)} c\n`;
    }
    content += `S\nQ\n`;
  }
  return content;
}

function buildPdf(): string {
  const contentStream = buildContentStream();
  const wPt = mmToPt(SHEET_W);
  const hPt = mmToPt(SHEET_H);

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Contents 4 0 R /Resources << /ColorSpace << /CScut 5 0 R /CScrease 6 0 R /CSperf 7 0 R >> >> >>`;
  objects[4] = `<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream`;
  for (const kind of ['cut', 'crease', 'perf'] as FinalKind[]) {
    const [r, g, b] = HUE[kind];
    objects[CS_OBJ[kind]] = `[/Separation /${SEP_NAME[kind]} /DeviceRGB ${FN_OBJ[kind]} 0 R]`;
    objects[FN_OBJ[kind]] = `<< /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [${r} ${g} ${b}] /N 1 >>`;
  }

  let out = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = out.length;
  const count = objects.length;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += xref;
  out += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return out;
}

mkdirSync('public/samples', { recursive: true });
writeFileSync('public/samples/sample_dieline.pdf', buildPdf(), 'latin1');

// ---------------------------------------------------------------------------
// 9. Write the SVG fixture (Y flipped; layer ids carry the classification).
// ---------------------------------------------------------------------------

const SVG_COLOR: Record<FinalKind, string> = { cut: '#ff5c5c', crease: '#4ade80', perf: '#5b8cff' };

function flipY(y: number): number {
  return SHEET_H - y;
}

function buildSvg(): string {
  const kinds: FinalKind[] = ['cut', 'crease', 'perf'];
  let body = '';
  for (const kind of kinds) {
    const segs = straights.filter((s) => s.kind === kind);
    const crvs = curves.filter((c) => c.kind === kind);
    if (segs.length === 0 && crvs.length === 0) continue;
    body += `  <g id="${kind}" stroke="${SVG_COLOR[kind]}" fill="none" stroke-width="0.3">\n`;
    for (const s of segs) {
      body += `    <line x1="${round4(s.a.x)}" y1="${round4(flipY(s.a.y))}" x2="${round4(s.b.x)}" y2="${round4(flipY(s.b.y))}" />\n`;
    }
    for (const c of crvs) {
      body += `    <path d="M ${round4(c.p0.x)},${round4(flipY(c.p0.y))} C ${round4(c.p1.x)},${round4(flipY(c.p1.y))} ${round4(c.p2.x)},${round4(flipY(c.p2.y))} ${round4(c.p3.x)},${round4(flipY(c.p3.y))}" />\n`;
    }
    body += `  </g>\n`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_W}mm" height="${SHEET_H}mm" viewBox="0 0 ${SHEET_W} ${SHEET_H}">\n${body}</svg>\n`;
}

writeFileSync('public/samples/sample_dieline.svg', buildSvg(), 'utf8');

// ---------------------------------------------------------------------------
// 10. Write a small placeholder PNG for artwork-mode testing.
// ---------------------------------------------------------------------------

let crc32Table: Int32Array | null = null;

function crc32(buf: Uint8Array): number {
  if (!crc32Table) {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    crc32Table = table;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = crc32Table[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function u32be(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function pngChunk(type: string, data: number[]): number[] {
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  const body = [...typeBytes, ...data];
  const crc = crc32(new Uint8Array(body));
  return [...u32be(data.length), ...typeBytes, ...data, ...u32be(crc)];
}

function buildPng(): Uint8Array {
  const w = 320;
  const h = 240;
  const raw: number[] = [];
  for (let y = 0; y < h; y++) {
    raw.push(0); // filter: none
    for (let x = 0; x < w; x++) {
      const t = x / w;
      raw.push(Math.round(30 + 60 * t)); // R
      raw.push(Math.round(90 + 60 * (1 - t))); // G
      raw.push(Math.round(160 + 40 * (y / h))); // B
    }
  }
  const idatData = deflateSync(Uint8Array.from(raw));

  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  const ihdr = pngChunk('IHDR', [...u32be(w), ...u32be(h), 8, 2, 0, 0, 0]);
  const idat = pngChunk('IDAT', Array.from(idatData));
  const iend = pngChunk('IEND', []);
  return Uint8Array.from([...signature, ...ihdr, ...idat, ...iend]);
}

writeFileSync('public/samples/sample_artwork.png', buildPng());

console.log('Wrote src/core/sampleExpectations.ts');
console.log('Wrote public/samples/sample_dieline.pdf');
console.log('Wrote public/samples/sample_dieline.svg');
console.log('Wrote public/samples/sample_artwork.png');
