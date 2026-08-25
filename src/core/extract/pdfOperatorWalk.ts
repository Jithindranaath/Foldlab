// Pure conversion from a pdf.js operator list to raw segments: CTM tracking,
// path construction, colour tracking. Deliberately takes `opList`/`OPS` as
// plain data/parameters rather than importing pdfjs-dist itself, so it has
// no dependency on Vite's `?url` worker import — extract/pdf.ts (browser,
// via pdfjs-dist + a real worker) and scripts/measure-real-sample.ts
// (Node, via pdfjs-dist's Node build) both call this same function after
// obtaining an operator list their own way. One implementation either way.
import { flattenCubicBezier } from '../bezier.ts';
import { ptToMm } from '../units.ts';
import type { Vec2 } from '../types.ts';
import type { RawSegment, Rgb } from '../classify.ts';

type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function multiply(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}

function applyMat(m: Mat, x: number, y: number): Vec2 {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'number');
}

/** pdf.js emits colour operator args as typed arrays (e.g. Uint8ClampedArray
 * for RGB), not plain Array — Array.isArray is false for those, so a plain
 * isNumberArray check silently drops every colour update. Accept anything
 * indexable with the right length instead. */
function asNumericTuple(v: unknown, length: number): number[] | null {
  if (v == null || typeof v !== 'object') return null;
  const arrLike = v as ArrayLike<unknown>;
  if (typeof arrLike.length !== 'number' || arrLike.length !== length) return null;
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    const n = arrLike[i];
    if (typeof n !== 'number') return null;
    out.push(n);
  }
  return out;
}

export interface PdfOpCodes {
  save: number;
  restore: number;
  transform: number;
  setStrokeRGBColor: number;
  setStrokeGray: number;
  setStrokeCMYKColor: number;
  constructPath: number;
  moveTo: number;
  lineTo: number;
  curveTo: number;
  curveTo2: number;
  curveTo3: number;
  closePath: number;
  rectangle: number;
  stroke: number;
  closeStroke: number;
  fill: number;
  eoFill: number;
  fillStroke: number;
  eoFillStroke: number;
  endPath: number;
}

export interface PdfOperatorList {
  fnArray: number[];
  argsArray: unknown[];
}

export interface WalkResult {
  raw: RawSegment[];
  rawCounts: { straight: number; curve: number };
  bbox: { x: number; y: number; w: number; h: number };
}

export function walkPdfOperatorList(opList: PdfOperatorList, OPS: PdfOpCodes): WalkResult {
  interface GState {
    ctm: Mat;
    rgb: Rgb | null;
  }
  const stack: GState[] = [];
  let state: GState = { ctm: IDENTITY, rgb: null };

  const raw: RawSegment[] = [];
  let straightCount = 0;
  let curveCount = 0;

  let currentPoint: Vec2 = { x: 0, y: 0 };
  let subpathStart: Vec2 = { x: 0, y: 0 };
  let pending: { a: Vec2; b: Vec2; isCurve: boolean }[] = [];

  function emitLine(a: Vec2, b: Vec2): void {
    pending.push({ a, b, isCurve: false });
  }
  function emitCurve(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2): void {
    const poly = flattenCubicBezier(p0, p1, p2, p3);
    let prev = p0;
    for (const pt of poly) {
      pending.push({ a: prev, b: pt, isCurve: true });
      prev = pt;
    }
  }
  function ptToVec(p: Vec2): Vec2 {
    return { x: ptToMm(p.x), y: ptToMm(p.y) };
  }
  function commitPending(): void {
    for (const seg of pending) {
      raw.push({ a: ptToVec(seg.a), b: ptToVec(seg.b), source: '', rgb: state.rgb });
      if (seg.isCurve) curveCount++;
      else straightCount++;
    }
    pending = [];
  }

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];

    switch (fn) {
      case OPS.save:
        stack.push(state);
        state = { ctm: state.ctm, rgb: state.rgb };
        break;
      case OPS.restore:
        state = stack.pop() ?? state;
        break;
      case OPS.transform: {
        if (isNumberArray(args) && args.length === 6) {
          const m: Mat = [args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!];
          state = { ctm: multiply(state.ctm, m), rgb: state.rgb };
        }
        break;
      }
      case OPS.setStrokeRGBColor: {
        const tuple = asNumericTuple(args, 3);
        if (tuple) {
          state = { ctm: state.ctm, rgb: { r: tuple[0]! / 255, g: tuple[1]! / 255, b: tuple[2]! / 255 } };
        }
        break;
      }
      case OPS.setStrokeGray: {
        const tuple = asNumericTuple(args, 1);
        if (tuple) {
          const g = tuple[0]!;
          state = { ctm: state.ctm, rgb: { r: g, g, b: g } };
        }
        break;
      }
      case OPS.setStrokeCMYKColor: {
        const tuple = asNumericTuple(args, 4);
        if (tuple) {
          const [c, m, y, k] = tuple as [number, number, number, number];
          state = {
            ctm: state.ctm,
            rgb: { r: (1 - c) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k) }
          };
        }
        break;
      }
      case OPS.constructPath: {
        if (!Array.isArray(args) || args.length < 2) break;
        const subOps = args[0] as number[];
        const subArgs = args[1] as number[];
        let cursor = 0;
        for (const op of subOps) {
          if (op === OPS.moveTo) {
            const x = subArgs[cursor++]!;
            const y = subArgs[cursor++]!;
            currentPoint = applyMat(state.ctm, x, y);
            subpathStart = currentPoint;
          } else if (op === OPS.lineTo) {
            const x = subArgs[cursor++]!;
            const y = subArgs[cursor++]!;
            const next = applyMat(state.ctm, x, y);
            emitLine(currentPoint, next);
            currentPoint = next;
          } else if (op === OPS.curveTo) {
            const x1 = subArgs[cursor++]!,
              y1 = subArgs[cursor++]!,
              x2 = subArgs[cursor++]!,
              y2 = subArgs[cursor++]!,
              x3 = subArgs[cursor++]!,
              y3 = subArgs[cursor++]!;
            const p1 = applyMat(state.ctm, x1, y1);
            const p2 = applyMat(state.ctm, x2, y2);
            const p3 = applyMat(state.ctm, x3, y3);
            emitCurve(currentPoint, p1, p2, p3);
            currentPoint = p3;
          } else if (op === OPS.curveTo2) {
            const x2 = subArgs[cursor++]!,
              y2 = subArgs[cursor++]!,
              x3 = subArgs[cursor++]!,
              y3 = subArgs[cursor++]!;
            const p1 = currentPoint;
            const p2 = applyMat(state.ctm, x2, y2);
            const p3 = applyMat(state.ctm, x3, y3);
            emitCurve(currentPoint, p1, p2, p3);
            currentPoint = p3;
          } else if (op === OPS.curveTo3) {
            const x1 = subArgs[cursor++]!,
              y1 = subArgs[cursor++]!,
              x3 = subArgs[cursor++]!,
              y3 = subArgs[cursor++]!;
            const p1 = applyMat(state.ctm, x1, y1);
            const p3 = applyMat(state.ctm, x3, y3);
            emitCurve(currentPoint, p1, p3, p3);
            currentPoint = p3;
          } else if (op === OPS.closePath) {
            emitLine(currentPoint, subpathStart);
            currentPoint = subpathStart;
          } else if (op === OPS.rectangle) {
            const x = subArgs[cursor++]!,
              y = subArgs[cursor++]!,
              w = subArgs[cursor++]!,
              h = subArgs[cursor++]!;
            const p0 = applyMat(state.ctm, x, y);
            const p1 = applyMat(state.ctm, x + w, y);
            const p2 = applyMat(state.ctm, x + w, y + h);
            const p3 = applyMat(state.ctm, x, y + h);
            emitLine(p0, p1);
            emitLine(p1, p2);
            emitLine(p2, p3);
            emitLine(p3, p0);
            currentPoint = p0;
            subpathStart = p0;
          }
        }
        break;
      }
      case OPS.stroke:
      case OPS.closeStroke:
        commitPending();
        break;
      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.endPath:
        pending = [];
        break;
      default:
        break;
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of raw) {
    for (const p of [s.a, s.b]) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (raw.length === 0) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }

  const normalized: RawSegment[] = raw.map((s) => ({
    ...s,
    a: { x: s.a.x - minX, y: s.a.y - minY },
    b: { x: s.b.x - minX, y: s.b.y - minY }
  }));

  return {
    raw: normalized,
    bbox: { x: 0, y: 0, w: maxX - minX, h: maxY - minY },
    rawCounts: { straight: straightCount, curve: curveCount }
  };
}
