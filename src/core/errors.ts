
export class FoldLabError extends Error {
  readonly title: string;
  readonly detail: string;
  constructor(title: string, detail: string) {
    super(`${title}: ${detail}`);
    this.title = title;
    this.detail = detail;
  }
}

export class UnsupportedFormatError extends FoldLabError {
  constructor(detected: string) {
    super('Unsupported file', `FoldLab could not decode ${detected} as a PDF, SVG, or image.`);
  }
}

export class NoVectorPathsError extends FoldLabError {
  constructor() {
    super('No vector paths found', 'This file has no line work — it may be a scan. Upload the vector original.');
  }
}

export class NoCreaseLinesError extends FoldLabError {
  constructor() {
    super(
      'No crease lines found',
      'That dieline has cut lines but no crease lines. FoldLab needs creases to know where the card hinges.'
    );
  }
}

export class TooFewPanelsError extends FoldLabError {
  constructor() {
    super(
      'Only one panel found',
      'Only one panel was found. The crease lines may be on a layer FoldLab did not recognise.'
    );
  }
}

export class ArtworkNoGeometryError extends FoldLabError {
  constructor() {
    super('No geometry loaded', 'This image has no cut or crease data. Upload the PDF or SVG to fold it.');
  }
}

export class ParseFailedError extends FoldLabError {
  constructor(reason: string) {
    super('Could not read this file', reason);
  }
}

export class DisconnectedGeometryError extends FoldLabError {
  constructor() {
    super(
      'Fold could not be fully resolved',
      "Some of this image's cut/crease lines could not be connected into one continuous box."
    );
  }
}
