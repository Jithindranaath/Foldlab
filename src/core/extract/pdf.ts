// PDF vector extraction via pdfjs-dist's operator list. pdf.js resolves
// /Separation colour spaces (like the ones a real dieline uses for
// "Schneiden"/"Rillen"/perforation lines) to concrete device RGB before the
// operator list is built, so the colourspace *name* never reaches this
// layer — only OPS.setStrokeRGBColor / setStrokeGray / setStrokeCMYKColor
// do. That RGB is carried through as `rgb` on each raw segment for
// classify.ts's hue-based fallback strategy; `source` is left empty here
// (see classify.ts strategy 1, which SVG layer/id names do feed).
//
// The actual operator-list walk (CTM, colour, path construction) lives in
// pdfOperatorWalk.ts, which takes plain opList/OPS data and has no
// dependency on Vite's `?url` worker import — that keeps it callable from
// Node scripts/tests too. This file is just the browser-specific wiring:
// pdfjs-dist + a real worker.
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { walkPdfOperatorList } from './pdfOperatorWalk.ts';
import type { RawSegment } from '../classify.ts';
import type { ExtractResult } from '../types.ts';
import { NoVectorPathsError } from '../errors.ts';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export async function extractFromPdf(
  data: ArrayBuffer
): Promise<{ raw: RawSegment[]; bbox: ExtractResult['bbox']; rawCounts: { straight: number; curve: number } }> {
  const loadingTask = pdfjsLib.getDocument({ data, isEvalSupported: false });
  const doc = await loadingTask.promise;
  const page = await doc.getPage(1);
  const opList = await page.getOperatorList();

  const { raw, rawCounts, bbox } = walkPdfOperatorList(opList, pdfjsLib.OPS);

  if (raw.length === 0) {
    throw new NoVectorPathsError();
  }

  return { raw, bbox, rawCounts };
}
