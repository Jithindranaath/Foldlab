import { create } from 'zustand';
import { runVectorPipeline, runRasterPipeline } from '../core/pipeline.ts';
import { sniffFormat, detectRasterMime } from '../core/extract/index.ts';
import { decodeRasterToBitmap } from '../core/extract/raster.ts';
import { detectDpi } from '../core/extract/dpi.ts';
import { FoldLabError, ArtworkNoGeometryError } from '../core/errors.ts';
import type { AuditReport, FoldSchedule } from '../core/types.ts';
import type { ShowFlags } from '../three/Viewport.ts';

const WORKER_THRESHOLD_BYTES = 2_000_000;
const SAMPLE_URL = '/samples/sample_dieline.pdf';

export type AppStatus = 'idle' | 'parsing' | 'ready' | 'artworkOnly' | 'error';

export interface AppError {
  title: string;
  detail: string;
}

interface AppState {
  fileName: string | null;
  status: AppStatus;
  error: AppError | null;
  schedule: FoldSchedule | null;
  audit: AuditReport | null;
  rawCounts: { straight: number; curve: number } | null;
  artworkBitmapUrl: string | null;

  t: number;
  playing: boolean;
  show: ShowFlags;

  loadFile(file: File): Promise<void>;
  loadSample(): Promise<void>;
  setT(t: number): void;
  play(): void;
  pause(): void;
  reset(): void;
  toggleShow(key: keyof ShowFlags): void;
  dismissError(): void;
}

function toAppError(err: unknown): AppError {
  if (err instanceof FoldLabError) return { title: err.title, detail: err.detail };
  if (err instanceof Error) return { title: 'Something went wrong', detail: err.message };
  return { title: 'Something went wrong', detail: 'An unknown error occurred.' };
}

async function runPipelineFor(data: ArrayBuffer, format: 'pdf' | 'svg', isSample: boolean, useWorker: boolean) {
  if (!useWorker) {
    return runVectorPipeline(data, format, isSample);
  }
  const worker = new Worker(new URL('../workers/parse.worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<Awaited<ReturnType<typeof runVectorPipeline>>>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as { ok: true; result: Awaited<ReturnType<typeof runVectorPipeline>> } | { ok: false; title: string; detail: string };
        if (msg.ok) resolve(msg.result);
        else reject(new FoldLabError(msg.title, msg.detail));
      };
      worker.onerror = (ev) => reject(new Error(ev.message));
      worker.postMessage({ data, format, isSample }, [data]);
    });
  } finally {
    worker.terminate();
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  fileName: null,
  status: 'idle',
  error: null,
  schedule: null,
  audit: null,
  rawCounts: null,
  artworkBitmapUrl: null,

  t: 0,
  playing: false,
  show: { axes: false, grid: false, frames: false, dims: true },

  async loadFile(file: File) {
    set({ status: 'parsing', error: null, fileName: file.name });
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const format = sniffFormat(bytes, file.name);

      if (format === 'raster') {
        const mime = detectRasterMime(bytes, file.type);
        const bitmap = await decodeRasterToBitmap(buffer, mime, file.name);

        const fullCanvas = document.createElement('canvas');
        fullCanvas.width = bitmap.width;
        fullCanvas.height = bitmap.height;
        const fullCtx = fullCanvas.getContext('2d');
        fullCtx?.drawImage(bitmap, 0, 0);
        const url = fullCanvas.toDataURL('image/png');

        let geometry: Awaited<ReturnType<typeof runRasterPipeline>> | null = null;
        try {
          if (!fullCtx) throw new Error('Canvas 2D context unavailable');
          const imageData = fullCtx.getImageData(0, 0, bitmap.width, bitmap.height);
          geometry = await runRasterPipeline(imageData, detectDpi(bytes), false);
        } catch {
          geometry = null;
        }

        if (geometry) {
          set({
            status: 'ready',
            schedule: geometry.schedule,
            audit: geometry.audit,
            rawCounts: geometry.rawCounts,
            artworkBitmapUrl: url,
            t: 0,
            playing: false,
            error: null
          });
        } else {
          const hasGeometry = get().schedule !== null;
          set({ artworkBitmapUrl: url, status: hasGeometry ? 'ready' : 'artworkOnly', error: null });
        }
        return;
      }

      const useWorker = buffer.byteLength > WORKER_THRESHOLD_BYTES;
      const result = await runPipelineFor(buffer, format, false, useWorker);
      set({
        status: 'ready',
        schedule: result.schedule,
        audit: result.audit,
        rawCounts: result.rawCounts,
        t: 0,
        playing: false
      });
    } catch (err) {
      set({ status: 'error', error: toAppError(err) });
    }
  },

  async loadSample() {
    set({ status: 'parsing', error: null, fileName: 'sample_dieline.pdf' });
    try {
      const res = await fetch(SAMPLE_URL);
      if (!res.ok) throw new Error(`Could not load the sample file (${res.status}).`);
      const buffer = await res.arrayBuffer();
      const result = await runPipelineFor(buffer, 'pdf', true, false);
      set({
        status: 'ready',
        schedule: result.schedule,
        audit: result.audit,
        rawCounts: result.rawCounts,
        t: 0,
        playing: false
      });
    } catch (err) {
      set({ status: 'error', error: toAppError(err) });
    }
  },

  setT(t: number) {
    set({ t: Math.min(1, Math.max(0, t)) });
  },
  play() {
    if (get().schedule === null) return;
    set((s) => ({ playing: true, t: s.t >= 0.999 ? 0 : s.t }));
  },
  pause() {
    set({ playing: false });
  },
  reset() {
    set({ t: 0, playing: false });
  },
  toggleShow(key) {
    set((s) => ({ show: { ...s.show, [key]: !s.show[key] } }));
  },
  dismissError() {
    set({ error: null, status: get().schedule ? 'ready' : 'idle' });
  }
}));

export const ARTWORK_NO_GEOMETRY_MESSAGE = new ArtworkNoGeometryError().detail;
