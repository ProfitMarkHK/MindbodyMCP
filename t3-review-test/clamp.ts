export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(lo, Math.max(hi, v));
}
