
export const PT_PER_MM = 2.834645669;

export function ptToMm(pt: number): number {
  return pt / PT_PER_MM;
}

export const SNAP_EPS_MM = 0.25;

export const ISOMETRY_EPS = 1e-6;

export const MIN_HINGE_LENGTH_MM = 5;

export const MIN_CELL_THICKNESS_MM = 0.4;

export const MIN_PANEL_AREA_MM2 = 3;

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
