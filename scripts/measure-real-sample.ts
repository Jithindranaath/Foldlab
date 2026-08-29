
import { writeFileSync, readFileSync } from 'node:fs';
import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';
import { walkPdfOperatorList } from '../src/core/extract/pdfOperatorWalk.ts';
import { classifySegments } from '../src/core/classify.ts';
import { decomposePanels } from '../src/core/panels.ts';
import { solveFoldSchedule } from '../src/core/solver.ts';
import { computeAudit } from '../src/core/audit.ts';

async function extractRealPdf(path: string) {
  const data = new Uint8Array(readFileSync(path));
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const opList = await page.getOperatorList();
  return walkPdfOperatorList(opList, pdfjsLib.OPS);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

(async () => {
  const { raw, rawCounts } = await extractRealPdf('public/samples/sample_dieline.pdf');
  const classified = classifySegments(raw);
  const { panels } = decomposePanels(classified.segments);
  const schedule = solveFoldSchedule({
    panels,
    segments: classified.segments,
    classificationStrategy: classified.strategy
  });
  const audit = computeAudit(schedule, null);

  console.log('--- Real sample_dieline.pdf measurement ---');
  console.log('Classification strategy:', classified.strategy);
  console.log('Raw counts (pre-flatten):', rawCounts);
  console.log('Working segment counts (post-flatten):', audit.segmentCounts);
  console.log('Panels:', panels.length);
  console.log('Dims:', schedule.dims);
  console.log('Perimeter identity:', schedule.perimeterIdentity);
  console.log('Closure residual (mm):', audit.closureResidualMm);
  console.log('Isometry drift (max):', audit.isometryDriftMax);
  console.log('Orphan panels:', schedule.orphanPanels);

  if (panels.length < 10) throw new Error('Panel count implausibly low — extraction likely broken');
  if (!schedule.perimeterIdentity?.holds) throw new Error('Perimeter identity does not hold');
  if (schedule.orphanPanels.length > 0) throw new Error('Fold graph is not connected');
  if (audit.isometryDriftMax === null || !audit.isometryPass) {
    throw new Error(`Isometry drift check failed: ${audit.isometryDriftMax}`);
  }

  const expectationsSource = `

export const SAMPLE_EXPECTATIONS = {
  segmentCounts: ${JSON.stringify(audit.segmentCounts)},
  rawCounts: ${JSON.stringify(rawCounts)},
  panelCount: ${panels.length},
  dims: { L: ${round(schedule.dims.L)}, H: ${round(schedule.dims.H)}, D: ${round(schedule.dims.D)} }
} as const;
`;

  writeFileSync('src/core/sampleExpectations.ts', expectationsSource);
  console.log('\nWrote src/core/sampleExpectations.ts');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
