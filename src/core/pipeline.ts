// Orchestrates extract -> classify -> panels -> graph/solver -> audit into a
// single call. Used identically from the main thread (small files) and from
// workers/parse.worker.ts (files over 2 MB) — one implementation, two hosts.
import { extractFromPdf } from './extract/pdf.ts';
import { extractFromSvg } from './extract/svg.ts';
import { extractFromRasterImageData } from './extract/rasterVector.ts';
import { classifySegments } from './classify.ts';
import { decomposePanels } from './panels.ts';
import { solveFoldSchedule } from './solver.ts';
import { computeAudit } from './audit.ts';
import { NoCreaseLinesError, TooFewPanelsError, DisconnectedGeometryError } from './errors.ts';
import { SAMPLE_EXPECTATIONS } from './sampleExpectations.ts';
import type { AuditReport, FoldSchedule } from './types.ts';

export interface PipelineResult {
  schedule: FoldSchedule;
  audit: AuditReport;
  rawCounts: { straight: number; curve: number };
}

export async function runVectorPipeline(
  data: ArrayBuffer,
  format: 'pdf' | 'svg',
  isSample: boolean
): Promise<PipelineResult> {
  const extracted =
    format === 'pdf' ? await extractFromPdf(data) : await extractFromSvg(new TextDecoder('utf-8').decode(data));

  const classified = classifySegments(extracted.raw);
  const hasCrease = classified.segments.some((s) => s.kind === 'crease' || s.kind === 'perf');
  if (!hasCrease) throw new NoCreaseLinesError();

  const { panels } = decomposePanels(classified.segments);
  if (panels.length < 2) throw new TooFewPanelsError();

  const schedule = solveFoldSchedule({
    panels,
    segments: classified.segments,
    classificationStrategy: classified.strategy
  });

  const audit = computeAudit(schedule, isSample ? SAMPLE_EXPECTATIONS : null);

  return { schedule, audit, rawCounts: extracted.rawCounts };
}

/**
 * Traces a raster bitmap's colored line art directly into a Segment[] (each
 * pixel is already hue-classified — see rasterVector.ts), then runs it
 * through the same panels/solver/audit stages as PDF/SVG. Throws
 * NoCreaseLinesError/TooFewPanelsError/NoVectorPathsError when the image
 * isn't line art (a photo, a scan, plain artwork) — the caller falls back
 * to artwork-only texture mode in that case.
 */
export async function runRasterPipeline(imageData: ImageData, dpi: number, isSample: boolean): Promise<PipelineResult> {
  const extracted = extractFromRasterImageData(imageData, dpi);

  const hasCrease = extracted.segments.some((s) => s.kind === 'crease' || s.kind === 'perf');
  if (!hasCrease) throw new NoCreaseLinesError();

  const { panels } = decomposePanels(extracted.segments);
  if (panels.length < 2) throw new TooFewPanelsError();

  const schedule = solveFoldSchedule({
    panels,
    segments: extracted.segments,
    classificationStrategy: extracted.strategy
  });

  // Raster tracing has a real noise floor a vector source doesn't — rather
  // than ever show a box that's silently missing a wall or flap (a wrong
  // transform, exactly what this app's audit exists to catch), a fold that
  // didn't fully resolve is treated as a failure here and the caller falls
  // back to artwork-only mode instead.
  if (schedule.orphanPanels.length > 0) throw new DisconnectedGeometryError();

  const audit = computeAudit(schedule, isSample ? SAMPLE_EXPECTATIONS : null);

  return { schedule, audit, rawCounts: extracted.rawCounts };
}
