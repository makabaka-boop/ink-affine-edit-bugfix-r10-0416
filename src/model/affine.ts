import type { Stroke } from "./types";
import { hitStroke } from "./geometry";

/** Canvas 顺序的仿射矩阵 [a,b,c,d,e,f]：x' = a·x + c·y + e，y' = b·x + d·y + f。 */
export type Matrix = [number, number, number, number, number, number];

export const identity = (): Matrix => [1, 0, 0, 1, 0, 0];

/** 校验输入矩阵：系数有限、绝对值 ≤ 10000、|行列式| ≥ 1e-8；非法即抛错。 */
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

/**
 * 矩阵乘积 a·b（先应用 b、再应用 a）。
 * 新矩阵在世界坐标中左乘已有矩阵：compose(newM, existing)。
 * 纯计算不抛错：合法矩阵的乘积行列式非零、系数有限，始终可逆可用。
 */
export function compose(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function applyToPoint(
  m: Matrix,
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** 逆矩阵。存储的矩阵都经过 matrix() 校验（|det| ≥ 1e-8），其乘积行列式亦非零。 */
export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

/**
 * 世界坐标下的命中判定：把判定点逆变换到笔画局部坐标，
 * 再对保存的原始采样（压力笔迹，非平滑缓存）判定 ——
 * 与渲染时笔尖轮廓随矩阵变形严格一致，不会命中变换前的旧位置。
 */
export function hitStrokeWorld(
  s: Stroke,
  wx: number,
  wy: number,
  radius: number,
): boolean {
  const m = s.transform;
  if (!m) return hitStroke(s.points, s.style, wx, wy, radius);
  const inv = invert(m);
  const p = applyToPoint(inv, wx, wy);
  // 世界坐标下的圆盘半径在局部坐标下是椭圆，用逆矩阵两个列向量的平均长度近似
  const k = (Math.hypot(inv[0], inv[1]) + Math.hypot(inv[2], inv[3])) / 2;
  return hitStroke(s.points, s.style, p.x, p.y, radius * k);
}

/** 点选命中：世界坐标点落在变换后的笔迹轮廓内（radius 0，局部判定是精确的）。 */
export function containsStroke(s: Stroke, x: number, y: number): boolean {
  return hitStrokeWorld(s, x, y, 0);
}
