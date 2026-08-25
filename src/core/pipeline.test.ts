import { describe, expect, it } from 'vitest';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { walkPdfOperatorList } from './extract/pdfOperatorWalk.ts';
import { decomposePanels } from './panels.ts';
import { solveFoldSchedule } from './solver.ts';
import { computeAudit } from './audit.ts';
import { SAMPLE_EXPECTATIONS } from './sampleExpectations.ts';
import { classifySegments, decodePdfName } from './classify.ts';
import type { RawSegment } from './classify.ts';

// The golden fixture is the REAL sample_dieline.pdf provided for this
// challenge (not a synthetic stand-in) — parsed here via pdf.js's Node
// build, through the exact same walkPdfOperatorList used by the browser
// extractor (src/core/extract/pdf.ts), so this test exercises the real
// production code path end to end.
async function extractSamplePdf(): Promise<{ raw: RawSegment[] }> {
  const fs = await import('node:fs');
  const data = new Uint8Array(fs.readFileSync('public/samples/sample_dieline.pdf'));
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const opList = await page.getOperatorList();
  return walkPdfOperatorList(opList, pdfjsLib.OPS);
}

describe('decodePdfName', () => {
  it('decodes PDF name escapes and lowercases', () => {
    expect(decodePdfName('Rill-Schnitt#2010x10')).toBe('rill-schnitt 10x10');
  });
});

describe('classifySegments', () => {
  it('strategy 1 fires on named colorspace/layer substrings', () => {
    const result = classifySegments([
      { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, source: 'Schneiden', rgb: null },
      { a: { x: 0, y: 0 }, b: { x: 0, y: 10 }, source: 'Rillen', rgb: null }
    ]);
    expect(result.strategy).toBe('colorspace');
    expect(result.segments[0]!.kind).toBe('cut');
    expect(result.segments[1]!.kind).toBe('crease');
  });

  it('falls back to hue when no names are present', () => {
    const result = classifySegments([
      { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, source: '', rgb: { r: 0.9, g: 0.1, b: 0.1 } },
      { a: { x: 0, y: 0 }, b: { x: 0, y: 10 }, source: '', rgb: { r: 0.1, g: 0.8, b: 0.2 } },
      // Measured from the real sample_dieline.pdf's perforation stroke —
      // sits at h~197.5°, just outside a naive 200-260 band.
      { a: { x: 0, y: 0 }, b: { x: 0, y: 5 }, source: '', rgb: { r: 64 / 255, g: 127 / 255, b: 153 / 255 } }
    ]);
    expect(result.strategy).toBe('hue');
    expect(result.segments[0]!.kind).toBe('cut');
    expect(result.segments[1]!.kind).toBe('crease');
    expect(result.segments[2]!.kind).toBe('perf');
  });
});

describe('sample_dieline.pdf golden fixture (the real provided file)', () => {
  it('matches the locked-in working segment counts', async () => {
    const { raw } = await extractSamplePdf();
    const classified = classifySegments(raw);
    const cut = classified.segments.filter((s) => s.kind === 'cut').length;
    const crease = classified.segments.filter((s) => s.kind === 'crease').length;
    const perf = classified.segments.filter((s) => s.kind === 'perf').length;
    expect({ total: classified.segments.length, cut, crease, perf }).toEqual(SAMPLE_EXPECTATIONS.segmentCounts);
    expect(crease).toBe(17); // matches the brief's stated fact exactly
    expect(perf).toBe(1);
  });

  it('decomposes to the locked-in panel count with a connected fold graph', async () => {
    const { raw } = await extractSamplePdf();
    const classified = classifySegments(raw);
    const { panels } = decomposePanels(classified.segments);
    expect(panels.length).toBe(SAMPLE_EXPECTATIONS.panelCount);

    const schedule = solveFoldSchedule({
      panels,
      segments: classified.segments,
      classificationStrategy: classified.strategy
    });
    expect(schedule.orphanPanels.length).toBe(0);
  });

  it('solves to the expected L x H x D and a holding perimeter identity', async () => {
    const { raw } = await extractSamplePdf();
    const classified = classifySegments(raw);
    const { panels } = decomposePanels(classified.segments);
    const schedule = solveFoldSchedule({
      panels,
      segments: classified.segments,
      classificationStrategy: classified.strategy
    });
    expect(schedule.dims.L).toBeCloseTo(SAMPLE_EXPECTATIONS.dims.L, 6);
    expect(schedule.dims.H).toBeCloseTo(SAMPLE_EXPECTATIONS.dims.H, 6);
    expect(schedule.dims.D).toBeCloseTo(SAMPLE_EXPECTATIONS.dims.D, 6);
    expect(schedule.perimeterIdentity?.holds).toBe(true);
  });

  it('folds as a rigid isometry (negligible edge-length drift)', async () => {
    const { raw } = await extractSamplePdf();
    const classified = classifySegments(raw);
    const { panels } = decomposePanels(classified.segments);
    const schedule = solveFoldSchedule({
      panels,
      segments: classified.segments,
      classificationStrategy: classified.strategy
    });
    const audit = computeAudit(schedule, SAMPLE_EXPECTATIONS);
    expect(audit.isometryPass).toBe(true);
  });

  it('closure residual matches the real 16/17mm caliper asymmetry, not a parse error', async () => {
    const { raw } = await extractSamplePdf();
    const classified = classifySegments(raw);
    const { panels } = decomposePanels(classified.segments);
    const schedule = solveFoldSchedule({
      panels,
      segments: classified.segments,
      classificationStrategy: classified.strategy
    });
    const audit = computeAudit(schedule, SAMPLE_EXPECTATIONS);
    expect(schedule.dims.measuredPair.slice().sort()).toEqual([16, 17]);
    expect(audit.closureResidualExplainedByCaliper).toBe(true);
  });
});
