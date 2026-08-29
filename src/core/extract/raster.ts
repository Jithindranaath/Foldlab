
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
