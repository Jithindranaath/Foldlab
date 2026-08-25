// Unit conversion and floating-point comparison constants shared across core/.

export const PT_PER_MM = 2.834645669;

export function ptToMm(pt: number): number {
  return pt / PT_PER_MM;
}

/** Snap tolerance for merging near-coincident vertices after extraction, in mm. */
export const SNAP_EPS_MM = 0.25;

/** Isometry drift tolerance: max relative edge-length change tolerated across the whole fold. */
export const ISOMETRY_EPS = 1e-6;

/** Minimum hinge length to be considered a real fold line rather than a chamfer artifact. */
export const MIN_HINGE_LENGTH_MM = 5;

/** Minimum lattice cell thickness; anything thinner is a chamfer sliver, not a panel. */
export const MIN_CELL_THICKNESS_MM = 0.4;

/** Minimum panel area to keep after decomposition, in mm^2. */
export const MIN_PANEL_AREA_MM2 = 3;

/** Closure residual pass threshold, in mm. */
export const CLOSURE_RESIDUAL_PASS_MM = 0.5;

export function snap(value: number, eps: number = SNAP_EPS_MM): number {
  return Math.round(value / eps) * eps;
}

export function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function approxEqual(a: number, b: number, eps: number = SNAP_EPS_MM): boolean {
  return Math.abs(a - b) <= eps;
}
