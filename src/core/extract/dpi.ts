// Reads embedded pixel density from a PNG's pHYs chunk or a JPEG's JFIF APP0
// density marker, so a raster upload can be traced to real mm instead of a
// guess. Falls back to 96 DPI — the same unitless-px convention svg.ts
// already uses for SVGs with no explicit unit — when no metadata is present.

function readU32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function detectPngDpi(bytes: Uint8Array): number | null {
  let offset = 8; // past the 8-byte PNG signature
  while (offset + 8 <= bytes.length) {
    const length = readU32BE(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    const dataStart = offset + 8;
    if (type === 'pHYs' && dataStart + 9 <= bytes.length) {
      const ppuX = readU32BE(bytes, dataStart);
      const unit = bytes[dataStart + 8];
      if (unit === 1 && ppuX > 0) return Math.round(ppuX * 0.0254); // pixels/metre -> DPI
      return null;
    }
    if (type === 'IDAT') return null; // pHYs, if present, always precedes IDAT
    offset = dataStart + length + 4; // skip chunk data + CRC
  }
  return null;
}

function detectJpegDpi(bytes: Uint8Array): number | null {
  let offset = 2; // past the SOI marker
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) break; // start of scan data — no more metadata markers
    const segLen = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (marker === 0xe0 && segLen >= 14) {
      const d = offset + 4;
      const isJfif = bytes[d] === 0x4a && bytes[d + 1] === 0x46 && bytes[d + 2] === 0x49 && bytes[d + 3] === 0x46;
      if (isJfif) {
        const units = bytes[d + 7];
        const xDensity = (bytes[d + 8]! << 8) | bytes[d + 9]!;
        if (units === 1 && xDensity > 0) return xDensity; // dots per inch
        if (units === 2 && xDensity > 0) return Math.round(xDensity * 2.54); // dots per cm
      }
    }
    offset += 2 + segLen;
  }
  return null;
}

const DEFAULT_DPI = 96;

export function detectDpi(bytes: Uint8Array): number {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return detectPngDpi(bytes) ?? DEFAULT_DPI;
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return detectJpegDpi(bytes) ?? DEFAULT_DPI;
  }
  return DEFAULT_DPI;
}
