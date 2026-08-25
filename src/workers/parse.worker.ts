// Runs extract -> classify -> panels -> graph -> solver -> audit off the
// main thread for files over 2 MB (state/store.ts decides the threshold).
// Same pipeline.ts as the inline path — one implementation, two hosts — and
// the result is plain data (numbers/strings/arrays/objects only), so it
// survives structured clone without a DataCloneError.
import { runVectorPipeline } from '../core/pipeline.ts';
import { FoldLabError } from '../core/errors.ts';

interface ParseRequest {
  data: ArrayBuffer;
  format: 'pdf' | 'svg';
  isSample: boolean;
}

self.onmessage = async (ev: MessageEvent<ParseRequest>) => {
  const { data, format, isSample } = ev.data;
  try {
    const result = await runVectorPipeline(data, format, isSample);
    (self as unknown as Worker).postMessage({ ok: true, result });
  } catch (err) {
    if (err instanceof FoldLabError) {
      (self as unknown as Worker).postMessage({ ok: false, title: err.title, detail: err.detail });
    } else {
      const detail = err instanceof Error ? err.message : 'An unknown error occurred while parsing.';
      (self as unknown as Worker).postMessage({ ok: false, title: 'Parse failed', detail });
    }
  }
};
