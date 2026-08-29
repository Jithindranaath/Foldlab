
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
