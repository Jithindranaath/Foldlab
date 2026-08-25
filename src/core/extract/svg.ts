// SVG vector extraction: DOMParser walk, resolving viewBox/unit scale to mm
// and flipping the Y-down SVG frame to Y-up exactly once, here. Layer/id/
// class hints are captured per segment as `source` for classify.ts strategy 1
// (named colorspace/layer); the `stroke` attribute is resolved to Rgb for
// strategy 2 (hue) as a fallback.
import { flattenCubicBezier } from '../bezier.ts';
import type { Vec2 } from '../types.ts';
import type { RawSegment, Rgb } from '../classify.ts';
import type { ExtractResult } from '../types.ts';
import { ParseFailedError, NoVectorPathsError } from '../errors.ts';

const UNIT_TO_MM: Record<string, number> = {
  mm: 1,
  cm: 10,
  in: 25.4,
  pt: 25.4 / 72,
  px: 25.4 / 96,
  '': 25.4 / 96 // unitless SVG user units default to px at 96dpi
};

function parseLength(value: string | null): { value: number; unit: string } | null {
  if (!value) return null;
  const match = /^(-?[\d.]+)\s*([a-z%]*)$/i.exec(value.trim());
  if (!match) return null;
  return { value: parseFloat(match[1]!), unit: match[2]!.toLowerCase() };
}

function parseColor(value: string | null): Rgb | null {
  if (!value || value === 'none') return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    return { r, g, b };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(value.trim());
  if (rgb) {
    return { r: parseFloat(rgb[1]!) / 255, g: parseFloat(rgb[2]!) / 255, b: parseFloat(rgb[3]!) / 255 };
  }
  return null;
}

function nearestSourceLabel(el: Element): string {
  let cur: Element | null = el;
  while (cur) {
    const label = cur.getAttribute('inkscape:label') ?? cur.getAttribute('id') ?? cur.getAttribute('class');
    if (label) return label;
    cur = cur.parentElement;
  }
  return '';
}

function nearestStroke(el: Element): Rgb | null {
  let cur: Element | null = el;
  while (cur) {
    const stroke = cur.getAttribute('stroke');
    const color = parseColor(stroke);
    if (color) return color;
    cur = cur.parentElement;
  }
  return null;
}

interface PathToken {
  cmd: string;
  args: number[];
}

function tokenizePath(d: string): PathToken[] {
  const tokens: PathToken[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    const cmd = m[1]!;
    const nums = (m[2] ?? '')
      .trim()
      .split(/[\s,]+/)
      .filter((s) => s.length > 0)
      .map(Number);
    tokens.push({ cmd, args: nums });
  }
  return tokens;
}

function walkPathData(d: string): { a: Vec2; b: Vec2; isCurve: boolean }[] {
  const segments: { a: Vec2; b: Vec2; isCurve: boolean }[] = [];
  let cur: Vec2 = { x: 0, y: 0 };
  let start: Vec2 = { x: 0, y: 0 };

  for (const { cmd, args } of tokenizePath(d)) {
    const isRelative = cmd === cmd.toLowerCase();
    const upper = cmd.toUpperCase();

    if (upper === 'M') {
      for (let i = 0; i + 1 < args.length; i += 2) {
        const next: Vec2 = isRelative
          ? { x: cur.x + args[i]!, y: cur.y + args[i + 1]! }
          : { x: args[i]!, y: args[i + 1]! };
        if (i === 0) {
          cur = next;
          start = next;
        } else {
          segments.push({ a: cur, b: next, isCurve: false });
          cur = next;
        }
      }
    } else if (upper === 'L') {
      for (let i = 0; i + 1 < args.length; i += 2) {
        const next: Vec2 = isRelative
          ? { x: cur.x + args[i]!, y: cur.y + args[i + 1]! }
          : { x: args[i]!, y: args[i + 1]! };
        segments.push({ a: cur, b: next, isCurve: false });
        cur = next;
      }
    } else if (upper === 'H') {
      for (const v of args) {
        const next: Vec2 = isRelative ? { x: cur.x + v, y: cur.y } : { x: v, y: cur.y };
        segments.push({ a: cur, b: next, isCurve: false });
        cur = next;
      }
    } else if (upper === 'V') {
      for (const v of args) {
        const next: Vec2 = isRelative ? { x: cur.x, y: cur.y + v } : { x: cur.x, y: v };
        segments.push({ a: cur, b: next, isCurve: false });
        cur = next;
      }
    } else if (upper === 'C') {
      for (let i = 0; i + 5 < args.length; i += 6) {
        const c1: Vec2 = isRelative ? { x: cur.x + args[i]!, y: cur.y + args[i + 1]! } : { x: args[i]!, y: args[i + 1]! };
        const c2: Vec2 = isRelative
          ? { x: cur.x + args[i + 2]!, y: cur.y + args[i + 3]! }
          : { x: args[i + 2]!, y: args[i + 3]! };
        const end: Vec2 = isRelative
          ? { x: cur.x + args[i + 4]!, y: cur.y + args[i + 5]! }
          : { x: args[i + 4]!, y: args[i + 5]! };
        for (const pt of flattenCubicBezier(cur, c1, c2, end)) {
          segments.push({ a: cur, b: pt, isCurve: true });
          cur = pt;
        }
        cur = end;
      }
    } else if (upper === 'Z') {
      segments.push({ a: cur, b: start, isCurve: false });
      cur = start;
    }
    // Q/S/T/A are uncommon in dieline exports; not supported in v1.
  }

  return segments;
}

export async function extractFromSvg(text: string): Promise<{
  raw: RawSegment[];
  bbox: ExtractResult['bbox'];
  rawCounts: { straight: number; curve: number };
}> {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new ParseFailedError('That SVG could not be parsed — it may be malformed XML.');
  }
  const svg = doc.querySelector('svg');
  if (!svg) throw new ParseFailedError('No <svg> root element found.');

  const viewBoxAttr = svg.getAttribute('viewBox');
  const widthAttr = parseLength(svg.getAttribute('width'));
  const heightAttr = parseLength(svg.getAttribute('height'));

  let viewBoxW = 0;
  let viewBoxH = 0;
  if (viewBoxAttr) {
    const parts = viewBoxAttr.trim().split(/[\s,]+/).map(Number);
    viewBoxW = parts[2] ?? 0;
    viewBoxH = parts[3] ?? 0;
  }

  const widthMm = widthAttr ? widthAttr.value * (UNIT_TO_MM[widthAttr.unit] ?? UNIT_TO_MM['']!) : viewBoxW;
  const heightMm = heightAttr ? heightAttr.value * (UNIT_TO_MM[heightAttr.unit] ?? UNIT_TO_MM['']!) : viewBoxH;

  const scaleX = viewBoxW > 0 ? widthMm / viewBoxW : 1;
  const scaleY = viewBoxH > 0 ? heightMm / viewBoxH : 1;
  const totalHeightMm = heightMm > 0 ? heightMm : viewBoxH * scaleY;

  const raw: RawSegment[] = [];
  let straightCount = 0;
  let curveCount = 0;

  function toMm(p: Vec2): Vec2 {
    // Flip Y-down (SVG) to Y-up here, exactly once.
    return { x: p.x * scaleX, y: totalHeightMm - p.y * scaleY };
  }

  function pushSegments(el: Element, segs: { a: Vec2; b: Vec2; isCurve: boolean }[]): void {
    const source = nearestSourceLabel(el);
    const rgb = nearestStroke(el);
    for (const s of segs) {
      if (Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) < 1e-9) continue;
      raw.push({ a: toMm(s.a), b: toMm(s.b), source, rgb });
      if (s.isCurve) curveCount++;
      else straightCount++;
    }
  }

  for (const el of Array.from(doc.querySelectorAll('path'))) {
    const d = el.getAttribute('d');
    if (!d) continue;
    pushSegments(el, walkPathData(d));
  }
  for (const el of Array.from(doc.querySelectorAll('line'))) {
    const x1 = parseFloat(el.getAttribute('x1') ?? '0');
    const y1 = parseFloat(el.getAttribute('y1') ?? '0');
    const x2 = parseFloat(el.getAttribute('x2') ?? '0');
    const y2 = parseFloat(el.getAttribute('y2') ?? '0');
    pushSegments(el, [{ a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, isCurve: false }]);
  }
  for (const el of Array.from(doc.querySelectorAll('polyline, polygon'))) {
    const pointsAttr = el.getAttribute('points') ?? '';
    const nums = pointsAttr.trim().split(/[\s,]+/).filter((s) => s.length > 0).map(Number);
    const pts: Vec2[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i]!, y: nums[i + 1]! });
    const segs: { a: Vec2; b: Vec2; isCurve: boolean }[] = [];
    for (let i = 0; i + 1 < pts.length; i++) segs.push({ a: pts[i]!, b: pts[i + 1]!, isCurve: false });
    if (el.tagName.toLowerCase() === 'polygon' && pts.length > 1) {
      segs.push({ a: pts[pts.length - 1]!, b: pts[0]!, isCurve: false });
    }
    pushSegments(el, segs);
  }
  for (const el of Array.from(doc.querySelectorAll('rect'))) {
    const x = parseFloat(el.getAttribute('x') ?? '0');
    const y = parseFloat(el.getAttribute('y') ?? '0');
    const w = parseFloat(el.getAttribute('width') ?? '0');
    const h = parseFloat(el.getAttribute('height') ?? '0');
    pushSegments(el, [
      { a: { x, y }, b: { x: x + w, y }, isCurve: false },
      { a: { x: x + w, y }, b: { x: x + w, y: y + h }, isCurve: false },
      { a: { x: x + w, y: y + h }, b: { x, y: y + h }, isCurve: false },
      { a: { x, y: y + h }, b: { x, y }, isCurve: false }
    ]);
  }

  if (raw.length === 0) {
    throw new NoVectorPathsError();
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
