
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
