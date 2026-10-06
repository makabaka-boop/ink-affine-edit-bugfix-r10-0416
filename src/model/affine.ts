import type { Stroke } from "./types";
import { hitStroke } from "./geometry";
export type Matrix = [number, number, number, number, number, number];
export const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
export function matrix(value: unknown): Matrix {
  if (
    !Array.isArray(value) ||
    value.length !== 6 ||
    value.some(
      (x) =>
        typeof x !== "number" || !Number.isFinite(x) || Math.abs(x) > 10000,
    )
  )
    throw new Error("invalid affine matrix");
  if (Math.abs(value[0] * value[3] - value[1] * value[2]) < 1e-8)
    throw new Error("singular affine matrix");
  return value.slice() as Matrix;
}
export function compose(a: Matrix, b: Matrix): Matrix {
  return matrix([
    a[0] * b[0],
    a[1] * b[1],
    a[2] * b[2],
    a[3] * b[3],
    a[4] + b[4],
    a[5] + b[5],
  ]);
}
export function containsStroke(s: Stroke, x: number, y: number): boolean {
  return hitStroke(s.points, s.style, x, y, 0);
}
