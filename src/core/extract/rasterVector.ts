// Raster-to-geometry: turns a bitmap's line art into the same RawSegment[]
// shape pdf.ts/svg.ts produce (position + sampled color, uncommitted to any
// particular kind), then hands it to classify.ts's existing classifySegments
// — the same colorspace/hue/topology fallback chain PDF and SVG already use.
// This is deliberately color-*agnostic* at the tracing stage: a real-world
// dieline image found on the web can use any color convention (blue cut +
// red crease is just as common as red/green/blue), and pre-splitting pixels
// into cut/crease/perf masks by hue before tracing — the previous design —
// silently produced a wrong or empty box whenever an image didn't happen to
// match classify.ts's red/green/blue assumption. Tracing one combined ink
// network first and classifying the resulting SEGMENTS afterward means an
// unconventional palette still falls through to the topology strategy
// (longest closed loop = cut, everything else = crease), same as it would
// for a PDF/SVG with unfamiliar layer colors.
//
// Pipeline: one combined "ink" mask (any sufficiently colored OR sufficiently
// dark pixel, any hue) -> gap-closing -> small-speck removal -> Zhang-Suen
// thinning to a 1px skeleton -> spur/bridge pruning -> graph trace into
// polylines -> Douglas-Peucker simplification -> axis-snap + quantize ->
// px -> mm via the caller's DPI -> classifySegments assigns cut/crease/perf.
import { classifySegments } from '../classify.ts';
import type { RawSegment, Rgb } from '../classify.ts';
import type { Segment, Vec2, ClassificationStrategy } from '../types.ts';
import type { ExtractResult } from '../types.ts';
import { NoVectorPathsError } from '../errors.ts';

const MIN_ALPHA = 40; // below this, a pixel is treated as transparent background
const INK_MIN_SATURATION = 0.4; // a colored stroke, any hue
const INK_MAX_VALUE_DARK = 0.35; // ...or a dark/black/grey stroke, regardless of hue
const MIN_COMPONENT_PX = 4; // discard specks smaller than this (anti-aliasing noise)
const MIN_SPUR_LENGTH_PX = 10; // Zhang-Suen leaves short "hair" branches at corners/junctions — prune them
const MAX_BRIDGE_LENGTH_PX = 10; // ...and short junction-to-junction "rungs" on diagonal staircases — prune those too
const GAP_CLOSE_RADIUS_PX = 4; // bridges small dash-gaps (nicks, anti-aliasing dropout) before thinning
const MIN_CHAIN_LENGTH_MM = 1.5; // below this, a trace chain is pixel-level noise, not a real dieline feature
const AXIS_SNAP_TOLERANCE_PX = 1.5; // regularizes a near-horizontal/vertical segment to exactly that (see below)
const RASTER_SNAP_MM = 0.8; // quantizes points so independently-traced coincident edges land on the same coordinate
const DP_TOLERANCE_PX = 4;
// A real dieline's cut/crease strokes are typically only 1-2px wide even in
// a several-thousand-pixel-wide export — any meaningful downscale aliases a
// line that thin into a staircase that Zhang-Suen then reads as dozens of
// spurious branches. So tracing runs at full resolution by default; this
// ceiling is only a safety valve against a pathologically huge image (product
// photography resolutions etc.) that would otherwise hang the thinning pass —
// blockOrDownscale (never a smoothing/blur) is used in that case since OR is
// the one downscale operation that cannot drop a thin line's presence outright.
const MAX_TRACE_DIM = 1800;

export interface RasterExtractResult {
  segments: Segment[];
  strategy: ClassificationStrategy;
  bbox: ExtractResult['bbox'];
  rawCounts: { straight: number; curve: number };
}

function neighborOffsets(x: number, y: number, width: number, height: number): [number, number][] {
  const out: [number, number][] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      out.push([nx, ny]);
    }
  }
  return out;
}

/** Drops connected components (8-connectivity) smaller than minSize, in place. */
function pruneSmallComponents(mask: Uint8Array, width: number, height: number, minSize: number): void {
  const visited = new Uint8Array(width * height);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    const component: number[] = [start];
    visited[start] = 1;
    const stack = [start];
    while (stack.length > 0) {
      const idx = stack.pop()!;
      const x = idx % width;
      const y = (idx / width) | 0;
      for (const [nx, ny] of neighborOffsets(x, y, width, height)) {
        const nIdx = ny * width + nx;
        if (mask[nIdx] && !visited[nIdx]) {
          visited[nIdx] = 1;
          component.push(nIdx);
          stack.push(nIdx);
        }
      }
    }
    if (component.length < minSize) {
      for (const idx of component) mask[idx] = 0;
    }
  }
}

function dilate(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        out[y * width + x] = 1;
        continue;
      }
      let any = 0;
      for (const [nx, ny] of neighborOffsets(x, y, width, height)) {
        if (mask[ny * width + nx]) {
          any = 1;
          break;
        }
      }
      out[y * width + x] = any;
    }
  }
  return out;
}

function erode(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      let all = 1;
      const neighbors = neighborOffsets(x, y, width, height);
      if (neighbors.length < 8) {
        all = 0; // border pixel: treat the missing neighbourhood as background
      } else {
        for (const [nx, ny] of neighbors) {
          if (!mask[ny * width + nx]) {
            all = 0;
            break;
          }
        }
      }
      out[y * width + x] = all;
    }
  }
  return out;
}

/** Morphological closing (dilate then erode): bridges gaps up to ~2*radius
 * px — real dieline cut lines are commonly drawn with small "nicks" left
 * uncut (a genuine packaging convention) or rasterize with occasional
 * anti-aliasing dropout at shallow angles, both of which leave a nominally
 * continuous line as many tiny disconnected dashes. Dilating first (which
 * bridges the gaps) then eroding back by the same amount restores the
 * original line width everywhere except at the now-fused gaps. */
function morphClose(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  let cur = mask;
  for (let i = 0; i < radius; i++) cur = dilate(cur, width, height);
  for (let i = 0; i < radius; i++) cur = erode(cur, width, height);
  return cur;
}

/** Classic Zhang-Suen thinning: reduces a binary mask to a 1px-wide skeleton. */
function zhangSuenThin(mask: Uint8Array, width: number, height: number): Uint8Array {
  const img = mask.slice();
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= width || y >= height ? 0 : img[y * width + x]!);

  let changed = true;
  while (changed) {
    changed = false;
    for (const step of [0, 1]) {
      const toClear: number[] = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (!at(x, y)) continue;
          const p2 = at(x, y - 1);
          const p3 = at(x + 1, y - 1);
          const p4 = at(x + 1, y);
          const p5 = at(x + 1, y + 1);
          const p6 = at(x, y + 1);
          const p7 = at(x - 1, y + 1);
          const p8 = at(x - 1, y);
          const p9 = at(x - 1, y - 1);
          const ring = [p2, p3, p4, p5, p6, p7, p8, p9];
          const B = ring.reduce((s, v) => s + v, 0);
          if (B < 2 || B > 6) continue;
          let A = 0;
          for (let k = 0; k < 8; k++) if (ring[k] === 0 && ring[(k + 1) % 8] === 1) A++;
          if (A !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }
          toClear.push(y * width + x);
        }
      }
      if (toClear.length > 0) {
        changed = true;
        for (const idx of toClear) img[idx] = 0;
      }
    }
  }
  return img;
}

/** Erases short dead-end branches Zhang-Suen leaves at corners, junctions,
 * and locally-thick spots (a well-known thinning artifact) — without this,
 * every such spur becomes a spurious extra chain/segment, badly
 * over-fragmenting the panel decomposition downstream. Repeated passes
 * because removing one spur can expose a junction as a new, shorter one. */
function pruneSpurs(skeleton: Uint8Array, width: number, height: number, maxSpurLength: number): void {
  const degreeAt = (x: number, y: number): number => neighborOffsets(x, y, width, height).filter(([nx, ny]) => skeleton[ny * width + nx]).length;

  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!skeleton[y * width + x] || degreeAt(x, y) !== 1) continue;

        const branch: [number, number][] = [[x, y]];
        let prevX = x;
        let prevY = y;
        const [firstNx, firstNy] = neighborOffsets(x, y, width, height).filter(([nx, ny]) => skeleton[ny * width + nx])[0]!;
        let curX = firstNx;
        let curY = firstNy;
        branch.push([curX, curY]);
        let stoppedAtJunction = false;

        while (branch.length <= maxSpurLength + 1) {
          const d = degreeAt(curX, curY);
          if (d >= 3) {
            stoppedAtJunction = true;
            break;
          }
          if (d === 1) break; // isolated short fragment — both ends are endpoints
          const next = neighborOffsets(curX, curY, width, height).find(
            ([nx, ny]) => skeleton[ny * width + nx] && !(nx === prevX && ny === prevY)
          );
          if (!next) break;
          prevX = curX;
          prevY = curY;
          [curX, curY] = next;
          branch.push([curX, curY]);
        }

        const spurLength = stoppedAtJunction ? branch.length - 1 : branch.length;
        if (spurLength <= maxSpurLength) {
          const eraseCount = stoppedAtJunction ? branch.length - 1 : branch.length;
          for (let i = 0; i < eraseCount; i++) {
            const [bx, by] = branch[i]!;
            skeleton[by * width + bx] = 0;
          }
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

/** Erases short junction-to-junction bridges: a thin diagonal stroke
 * anti-aliases into a pixel staircase, and Zhang-Suen commonly thins that
 * into the main path briefly forking into two parallel 1px rails a step
 * apart before rejoining — a "ladder rung" a few px long with a real
 * junction (degree >= 3) at both ends, so pruneSpurs' dead-end check never
 * touches it. Removing the rung lets the two rails' junctions collapse back
 * into simple degree-2 pass-through points on the next pass, restoring one
 * long clean chain instead of many tiny ones. */
function pruneBridges(skeleton: Uint8Array, width: number, height: number, maxBridgeLength: number): void {
  const degreeAt = (x: number, y: number): number => neighborOffsets(x, y, width, height).filter(([nx, ny]) => skeleton[ny * width + nx]).length;

  for (let pass = 0; pass < 8; pass++) {
    const toErase = new Set<number>();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!skeleton[y * width + x] || degreeAt(x, y) < 3) continue;
        for (const [firstX, firstY] of neighborOffsets(x, y, width, height).filter(([nx, ny]) => skeleton[ny * width + nx])) {
          const branch: [number, number][] = [[firstX, firstY]];
          let prevX = x;
          let prevY = y;
          let curX = firstX;
          let curY = firstY;
          let reachedOtherJunction = false;

          while (branch.length <= maxBridgeLength) {
            const d = degreeAt(curX, curY);
            if (d >= 3) {
              reachedOtherJunction = !(curX === x && curY === y);
              break;
            }
            if (d === 1) break; // dead end — a spur, not a bridge; pruneSpurs handles it
            const next = neighborOffsets(curX, curY, width, height).find(
              ([nx, ny]) => skeleton[ny * width + nx] && !(nx === prevX && ny === prevY)
            );
            if (!next) break;
            prevX = curX;
            prevY = curY;
            [curX, curY] = next;
            branch.push([curX, curY]);
          }

          if (reachedOtherJunction && branch.length - 1 <= maxBridgeLength) {
            for (let i = 0; i < branch.length - 1; i++) {
              const [bx, by] = branch[i]!;
              toErase.add(by * width + bx);
            }
          }
        }
      }
    }
    if (toErase.size === 0) break;
    for (const idx of toErase) skeleton[idx] = 0;
  }
}

function edgeKey(x1: number, y1: number, x2: number, y2: number): string {
  const a = y1 * 65536 + x1;
  const b = y2 * 65536 + x2;
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Traces a thinned skeleton into polylines: chains between endpoints/junctions,
 * plus any leftover pure closed loops that have neither. */
function traceChains(skeleton: Uint8Array, width: number, height: number): Vec2[][] {
  const chains: Vec2[][] = [];
  const visitedEdges = new Set<string>();
  const neighborsOf = (x: number, y: number): [number, number][] =>
    neighborOffsets(x, y, width, height).filter(([nx, ny]) => skeleton[ny * width + nx]);
  const isKeypoint = (x: number, y: number): boolean => neighborsOf(x, y).length !== 2;

  function walkFrom(startX: number, startY: number, firstX: number, firstY: number): Vec2[] {
    const chain: Vec2[] = [{ x: startX, y: startY }];
    let prevX = startX;
    let prevY = startY;
    let curX = firstX;
    let curY = firstY;
    visitedEdges.add(edgeKey(prevX, prevY, curX, curY));
    chain.push({ x: curX, y: curY });
    while (!isKeypoint(curX, curY)) {
      const next = neighborsOf(curX, curY).find(([nx, ny]) => !(nx === prevX && ny === prevY));
      if (!next) break;
      const [nx, ny] = next;
      const key = edgeKey(curX, curY, nx, ny);
      if (visitedEdges.has(key)) break;
      visitedEdges.add(key);
      prevX = curX;
      prevY = curY;
      curX = nx;
      curY = ny;
      chain.push({ x: curX, y: curY });
      if (curX === startX && curY === startY) break;
    }
    return chain;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!skeleton[y * width + x] || !isKeypoint(x, y)) continue;
      for (const [nx, ny] of neighborsOf(x, y)) {
        if (visitedEdges.has(edgeKey(x, y, nx, ny))) continue;
        chains.push(walkFrom(x, y, nx, ny));
      }
    }
  }

  // Whatever's left is a closed loop with no junctions (a plain circle/oval).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!skeleton[y * width + x]) continue;
      const open = neighborsOf(x, y).find(([nx, ny]) => !visitedEdges.has(edgeKey(x, y, nx, ny)));
      if (open) chains.push(walkFrom(x, y, open[0], open[1]));
    }
  }

  return chains.filter((c) => c.length >= 2);
}

function quantize(value: number, grid: number): number {
  return Math.round(value / grid) * grid;
}

function chainPixelLength(chain: Vec2[]): number {
  let total = 0;
  for (let i = 0; i + 1 < chain.length; i++) {
    total += Math.hypot(chain[i + 1]!.x - chain[i]!.x, chain[i + 1]!.y - chain[i]!.y);
  }
  return total;
}

function perpendicularDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  const cross = Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy);
  return cross / Math.sqrt(lenSq);
}

/** Iterative (stack-based, not recursive) Douglas-Peucker — safe for chains
 * of any length since it can't blow the call stack on a noisy trace. */
function douglasPeucker(points: Vec2[], tolerance: number): Vec2[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [startIdx, endIdx] = stack.pop()!;
    if (endIdx - startIdx < 2) continue;
    const first = points[startIdx]!;
    const last = points[endIdx]!;
    let maxDist = -1;
    let index = startIdx;
    for (let i = startIdx + 1; i < endIdx; i++) {
      const d = perpendicularDistance(points[i]!, first, last);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > tolerance) {
      keep[index] = 1;
      stack.push([startIdx, index]);
      stack.push([index, endIdx]);
    }
  }
  const out: Vec2[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]!);
  return out;
}

/** Downscales a binary mask by OR-ing every source pixel into its scaled
 * destination cell — unlike resampling a color image, a thin stroke can
 * never fall between sample points, since every source pixel contributes. */
function blockOrDownscale(mask: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number): Uint8Array {
  const out = new Uint8Array(dstW * dstH);
  for (let y = 0; y < srcH; y++) {
    if (!mask.subarray(y * srcW, (y + 1) * srcW).some((v) => v)) continue;
    const dy = Math.min(dstH - 1, Math.floor((y * dstH) / srcH));
    const rowOff = y * srcW;
    const outRowOff = dy * dstW;
    for (let x = 0; x < srcW; x++) {
      if (!mask[rowOff + x]) continue;
      const dx = Math.min(dstW - 1, Math.floor((x * dstW) / srcW));
      out[outRowOff + dx] = 1;
    }
  }
  return out;
}

function rgbToSv(r: number, g: number, b: number): { s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const v = max;
  const s = max === 0 ? 0 : (max - min) / max;
  return { s, v };
}

/** Buckets a color into one of 12 hue slices, or -1 for a neutral (black/
 * grey/near-white) ink color — grouping is coarse on purpose, just enough to
 * tell visually distinct line colors apart, not to name them. */
function bucketColor(rgb: Rgb): number {
  const { s, v } = rgbToSv(rgb.r, rgb.g, rgb.b);
  if (s < 0.15 || v < 0.15) return -1;
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
  return Math.floor(h / 30) % 12;
}

/**
 * A dieline drawn in an unfamiliar palette (anything other than FoldLab's
 * default red=cut/green=crease/blue=perf) still visually distinguishes
 * "outer boundary" from "internal fold" by using two (or three) DIFFERENT
 * colors, whatever they are — that's a far more reliable general assumption
 * than any specific hue, and one classify.ts's fixed-band hue strategy can't
 * make (it only activates when something happens to land in its green
 * crease band). Groups raw segments by visually distinct color, then ranks
 * groups by total traced length: the outer cut contour is almost always the
 * longest network, so longest -> cut, next -> crease, a third (if present)
 * -> perf. Returns null for a monochrome image (nothing to rank), letting
 * the caller fall through to classify.ts's own topology strategy.
 */
function classifyByDominantColors(raw: RawSegment[]): { segments: Segment[]; strategy: ClassificationStrategy } | null {
  const buckets = new Map<number, { totalLength: number; items: RawSegment[] }>();
  for (const s of raw) {
    if (!s.rgb) continue;
    const bucket = bucketColor(s.rgb);
    const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    const entry = buckets.get(bucket) ?? { totalLength: 0, items: [] };
    entry.totalLength += len;
    entry.items.push(s);
    buckets.set(bucket, entry);
  }
  const ranked = [...buckets.entries()].sort((a, b) => b[1].totalLength - a[1].totalLength);
  if (ranked.length < 2) return null; // one color only — nothing to rank by

  const totalAll = ranked.reduce((sum, [, e]) => sum + e.totalLength, 0);
  const [cutBucket, creaseBucket, perfBucket, ...rest] = ranked;
  if (!creaseBucket || creaseBucket[1].totalLength < totalAll * 0.03) return null; // second color is noise-scale

  const segments: Segment[] = [];
  for (const s of cutBucket![1].items) segments.push({ a: s.a, b: s.b, kind: 'cut', source: s.source });
  for (const s of creaseBucket[1].items) segments.push({ a: s.a, b: s.b, kind: 'crease', source: s.source });
  if (perfBucket) for (const s of perfBucket[1].items) segments.push({ a: s.a, b: s.b, kind: 'perf', source: s.source });
  // A fourth+ distinct color is unusual; fold it into crease rather than drop it.
  for (const [, entry] of rest) for (const s of entry.items) segments.push({ a: s.a, b: s.b, kind: 'crease', source: s.source });

  return { segments, strategy: 'hue' };
}

/** Samples a chain's own color from many interior points (skipping a margin
 * near both ends, where it may sit on or near a junction with a
 * differently-colored line), then takes a MAJORITY VOTE over the same coarse
 * color buckets classifyByDominantColors ranks by. A single most-saturated
 * sample is an outlier risk — one junction-adjacent pixel that happens to
 * read more saturated than the line's own (possibly thinner/softer) color
 * would still win; a mode over many samples doesn't have that failure mode. */
function sampleChainColor(chain: Vec2[], data: Uint8ClampedArray, width: number, height: number, scale: number): Rgb {
  const n = chain.length;
  const margin = Math.max(1, Math.floor(n * 0.15));
  const startIdx = Math.min(n - 1, margin);
  const endIdx = Math.max(startIdx, n - 1 - margin);
  const maxSamples = 40;
  const step = Math.max(1, Math.floor((endIdx - startIdx) / maxSamples) || 1);

  const buckets = new Map<number, { count: number; sumR: number; sumG: number; sumB: number }>();
  for (let i = startIdx; i <= endIdx; i += step) {
    const p = chain[i]!;
    const px = Math.min(width - 1, Math.max(0, Math.round(p.x / scale)));
    const py = Math.min(height - 1, Math.max(0, Math.round(p.y / scale)));
    const ci = (py * width + px) * 4;
    const rgb: Rgb = { r: data[ci]! / 255, g: data[ci + 1]! / 255, b: data[ci + 2]! / 255 };
    const bucket = bucketColor(rgb);
    const entry = buckets.get(bucket) ?? { count: 0, sumR: 0, sumG: 0, sumB: 0 };
    entry.count++;
    entry.sumR += rgb.r;
    entry.sumG += rgb.g;
    entry.sumB += rgb.b;
    buckets.set(bucket, entry);
  }

  let winner: { count: number; sumR: number; sumG: number; sumB: number } | null = null;
  for (const entry of buckets.values()) {
    if (!winner || entry.count > winner.count) winner = entry;
  }
  if (winner) return { r: winner.sumR / winner.count, g: winner.sumG / winner.count, b: winner.sumB / winner.count };

  const p = chain[Math.floor(n / 2)]!;
  const px = Math.min(width - 1, Math.max(0, Math.round(p.x / scale)));
  const py = Math.min(height - 1, Math.max(0, Math.round(p.y / scale)));
  const ci = (py * width + px) * 4;
  return { r: data[ci]! / 255, g: data[ci + 1]! / 255, b: data[ci + 2]! / 255 };
}

export function extractFromRasterImageData(imageData: ImageData, dpi: number): RasterExtractResult {
  const { width, height, data } = imageData;

  // Build one combined ink mask at full source resolution — a single cheap
  // pass, so a thin (1-3px) stroke is never missed. "Ink" is deliberately
  // color-blind (any hue counts, as long as it's saturated enough, plus dark
  // neutral/black strokes) since the whole point of tracing before
  // classifying is to not assume a color convention. A fast-path skip for
  // near-white pixels (the vast majority of a dieline image) avoids the S/V
  // conversion for them.
  const inkMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3]! < MIN_ALPHA) continue;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      if (r > 248 && g > 248 && b > 248) continue;
      const { s, v } = rgbToSv(r / 255, g / 255, b / 255);
      if (s >= INK_MIN_SATURATION || v <= INK_MAX_VALUE_DARK) inkMask[y * width + x] = 1;
    }
  }

  const scale = Math.min(1, MAX_TRACE_DIM / Math.max(width, height));
  const traceW = Math.max(1, Math.round(width * scale));
  const traceH = Math.max(1, Math.round(height * scale));
  const pxToMm = 25.4 / dpi / scale; // trace-space px -> mm, compensating for any downscale

  const downscaled = scale < 1 ? blockOrDownscale(inkMask, width, height, traceW, traceH) : inkMask;
  const traceMask = morphClose(downscaled, traceW, traceH, GAP_CLOSE_RADIUS_PX);
  pruneSmallComponents(traceMask, traceW, traceH, MIN_COMPONENT_PX);
  if (!traceMask.some((v) => v)) throw new NoVectorPathsError();

  const skeleton = zhangSuenThin(traceMask, traceW, traceH);
  // Bridge/spur pruning alternate: removing a bridge can turn its junction
  // into a new short spur (and vice versa), so a couple of rounds converges
  // to a materially cleaner skeleton than either pass alone.
  for (let round = 0; round < 6; round++) {
    pruneBridges(skeleton, traceW, traceH, MAX_BRIDGE_LENGTH_PX);
    pruneSpurs(skeleton, traceW, traceH, MIN_SPUR_LENGTH_PX);
  }
  const minChainLengthPx = MIN_CHAIN_LENGTH_MM / pxToMm;
  const chains = traceChains(skeleton, traceW, traceH).filter((c) => chainPixelLength(c) >= minChainLengthPx);

  const raw: RawSegment[] = [];
  let straightCount = 0;

  for (const chain of chains) {
    // Sample ONE representative color for the whole chain, from interior
    // points well away from its two ends — not per emitted sub-segment.
    // A crease's endpoint routinely touches the cut boundary exactly where
    // it terminates (that's how real dielines are drawn), so a sub-segment
    // right at that end can sample the *other* line's color if it lands on
    // or near the junction pixel. Interior sampling avoids that; picking the
    // most-saturated of several interior samples further avoids an
    // anti-aliased, partially-blended pixel skewing the result.
    const chainRgb = sampleChainColor(chain, data, width, height, scale);
    const simplified = douglasPeucker(chain, DP_TOLERANCE_PX);
    for (let i = 0; i + 1 < simplified.length; i++) {
      let a = simplified[i]!;
      let b = simplified[i + 1]!;
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue;
      // A real dieline's edges are overwhelmingly exactly horizontal or
      // vertical, but pixel quantization leaves a fraction-of-a-pixel
      // perpendicular wobble even on a truly straight edge. That wobble
      // (~0.5-0.6mm at this trace resolution) is bigger than panels.ts's
      // lattice/hinge-detection collinearity tolerance (0.25mm), so an
      // unsnapped "horizontal" crease silently fails to line up with any
      // panel edge and produces zero hinges. Snapping a near-axis-aligned
      // segment to be exactly axis-aligned (never touching a genuinely
      // diagonal or curved one, which fails this check by design) fixes
      // that without perturbing real geometry.
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.abs(dy) <= AXIS_SNAP_TOLERANCE_PX && Math.abs(dy) < Math.abs(dx)) {
        const avgY = (a.y + b.y) / 2;
        a = { x: a.x, y: avgY };
        b = { x: b.x, y: avgY };
      } else if (Math.abs(dx) <= AXIS_SNAP_TOLERANCE_PX && Math.abs(dx) < Math.abs(dy)) {
        const avgX = (a.x + b.x) / 2;
        a = { x: avgX, y: a.y };
        b = { x: avgX, y: b.y };
      }

      // Flip Y-down (pixel space) to Y-up, matching svg.ts's convention.
      // Then quantize to RASTER_SNAP_MM: two lines that are really the same
      // physical edge (e.g. a cut line and an adjoining crease meeting it)
      // can land up to ~1 trace pixel apart in absolute position even after
      // axis-snapping — bigger than panels.ts's own 0.25mm lattice/hinge
      // tolerance (tuned for vector-precision PDF/SVG data) — so they'd
      // silently fail to line up. Quantizing here, before that shared
      // tolerance ever sees the data, forces points meant to coincide to
      // actually do.
      raw.push({
        a: { x: quantize(a.x * pxToMm, RASTER_SNAP_MM), y: quantize((traceH - a.y) * pxToMm, RASTER_SNAP_MM) },
        b: { x: quantize(b.x * pxToMm, RASTER_SNAP_MM), y: quantize((traceH - b.y) * pxToMm, RASTER_SNAP_MM) },
        source: '',
        rgb: chainRgb
      });
      straightCount++;
    }
  }

  if (raw.length === 0) throw new NoVectorPathsError();

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

  const { segments, strategy }: { segments: Segment[]; strategy: ClassificationStrategy } =
    classifyByDominantColors(normalized) ?? classifySegments(normalized);

  return {
    segments,
    strategy,
    bbox: { x: 0, y: 0, w: maxX - minX, h: maxY - minY },
    rawCounts: { straight: straightCount, curve: 0 }
  };
}
