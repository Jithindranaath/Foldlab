export type SourceFormat = 'pdf' | 'svg' | 'raster';

/** Sniffs the format by magic bytes/content, not by file extension. Anything
 * that isn't recognisably PDF or SVG is handed to the browser's own image
 * decoder as 'raster' — decodeRasterToBitmap (raster.ts) is the real
 * arbiter of whether a file is actually readable; an undecodable file
 * throws there with a clear message, not here. This is what lets FoldLab
 * accept "any format": PDF and SVG get full vector extraction, every image
 * format the browser can decode (PNG, JPEG, GIF, BMP, WEBP, AVIF, ...) gets
 * attempted as line-art geometry (see rasterVector.ts) and falls back to
 * artwork-only texture mode when it isn't line art. */
export function sniffFormat(bytes: Uint8Array, _fileName: string): SourceFormat {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'pdf'; // %PDF
  }
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 2048));
  if (/<\?xml/i.test(head) || /<svg[\s>]/i.test(head)) return 'svg';
  return 'raster';
}

/** Best-effort MIME sniff by magic bytes, for a correct Blob type going into
 * createImageBitmap — `file.type` is sometimes empty (e.g. some drag-drop
 * sources), so this doesn't rely on it being set correctly. */
export function detectRasterMime(bytes: Uint8Array, fallback: string): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return fallback || 'image/png';
}
