// Raster bitmap decode via the browser's own image codecs (PNG/JPEG/GIF/
// BMP/WEBP/AVIF and more, whatever the host browser supports) — this is the
// real arbiter of "any format": if createImageBitmap can decode it, FoldLab
// can ingest it. Geometry extraction (rasterVector.ts) or artwork-only
// texture mode both start from this bitmap.
import { UnsupportedFormatError } from '../errors.ts';

export async function decodeRasterToBitmap(data: ArrayBuffer, mimeType: string, fileName: string): Promise<ImageBitmap> {
  const blob = new Blob([data], { type: mimeType });
  try {
    return await createImageBitmap(blob);
  } catch {
    const ext = fileName.toLowerCase().split('.').pop();
    throw new UnsupportedFormatError(ext ? `this .${ext} file` : 'this file');
  }
}
