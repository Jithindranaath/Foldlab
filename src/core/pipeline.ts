
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

  if (schedule.orphanPanels.length > 0) throw new DisconnectedGeometryError();

  const audit = computeAudit(schedule, isSample ? SAMPLE_EXPECTATIONS : null);

  return { schedule, audit, rawCounts: extracted.rawCounts };
}
