import { distToSegment, hitStroke, widthAt } from "./geometry";
import type { Stroke } from "./types";

/**
 * 仿射矩阵（Canvas 约定的六元组 [a,b,c,d,e,f]）：
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 * 点/压力/时间始终保存在笔画局部坐标，transform 只描述局部→世界的映射。
 */
export type Matrix = [number, number, number, number, number, number];

export const identity = (): Matrix => [1, 0, 0, 1, 0, 0];

const COEF_LIMIT = 10000;
const MIN_ABS_DET = 1e-8;

/** 校验并复制矩阵：系数必须有限且 |·| ≤ 10000，行列式绝对值 ≥ 1e-8。 */
export function matrix(value: unknown): Matrix {
  if (
    !Array.isArray(value) ||
    value.length !== 6 ||
    value.some(
      (x) =>
        typeof x !== "number" || !Number.isFinite(x) || Math.abs(x) > COEF_LIMIT,
    )
  )
    throw new Error("invalid affine matrix");
  if (Math.abs(value[0] * value[3] - value[1] * value[2]) < MIN_ABS_DET)
    throw new Error("singular affine matrix");
  return value.slice() as Matrix;
}

/**
 * 矩阵乘法 compose(l, r) = l * r：几何上“先做 r，再做 l”。
 * 编辑语义是“新矩阵 m 在世界坐标中左乘已有矩阵 T”，因此新的世界矩阵
 * 取 compose(m, T)；连续变换严格按提交顺序左乘，形状与执行顺序一致。
 */
export function compose(l: Matrix, r: Matrix): Matrix {
  return matrix([
    l[0] * r[0] + l[2] * r[1],
    l[1] * r[0] + l[3] * r[1],
    l[0] * r[2] + l[2] * r[3],
    l[1] * r[2] + l[3] * r[3],
    l[0] * r[4] + l[2] * r[5] + l[4],
    l[1] * r[4] + l[3] * r[5] + l[5],
  ]);
}

/**
 * 逆矩阵。入参恒为已通过 matrix() 校验的存储矩阵（行列式非零），
 * 逆系数本身可能超过 1e4，故不再经过系数上限校验，直接构造。
 */
export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  const inv = 1 / det;
  return [
    m[3] * inv,
    -m[1] * inv,
    -m[2] * inv,
    m[0] * inv,
    (m[2] * m[5] - m[3] * m[4]) * inv,
    (m[1] * m[4] - m[0] * m[5]) * inv,
  ];
}

/** 矩阵作用于点。 */
export function applyMatrix(
  m: Matrix,
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/**
 * 线性部分 A = [[a,c],[b,d]] 的奇异值，即各方向上的最小/最大伸缩比。
 * 用 2×2 闭式公式：σ² = (s ± √(s² − 4·det²)) / 2，s = a²+b²+c²+d²。
 * 平移（线性部分为单位阵）得到 {1,1}，旋转/均匀缩放时 min == max。
 */
export function axisScales(m: Matrix): { min: number; max: number } {
  const s = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] + m[3] * m[3];
  const det = m[0] * m[3] - m[1] * m[2];
  const disc = Math.sqrt(Math.max(0, s * s - 4 * det * det));
  return {
    min: Math.sqrt(Math.max(0, (s - disc) / 2)),
    max: Math.sqrt(Math.max(0, (s + disc) / 2)),
  };
}

/**
 * 是否为单位矩阵（用于把相消后的变换还原为“无变换”状态）。
 * 允许极小浮点误差（合法系数 ≤ 1e4，乘除误差远小于 1e-9）。
 */
export function isIdentity(m: Matrix): boolean {
  const eps = 1e-9;
  return (
    Math.abs(m[0] - 1) <= eps &&
    Math.abs(m[3] - 1) <= eps &&
    Math.abs(m[1]) <= eps &&
    Math.abs(m[2]) <= eps &&
    Math.abs(m[4]) <= eps &&
    Math.abs(m[5]) <= eps
  );
}

/**
 * 选择命中：使用保存的原始压力采样（不用平滑缓存），在世界坐标下判定。
 * 精确做法是把查询点用逆矩阵映回笔画局部坐标，再按局部压力轮廓判定 ——
 * 旋转/错切/非等比缩放后命中区域与屏幕轮廓完全一致，不会再命中旧位置。
 */
export function containsStroke(s: Stroke, wx: number, wy: number): boolean {
  const m = s.transform;
  if (!m) return hitStroke(s.points, s.style, wx, wy, 0);
  const p = applyMatrix(invert(m), wx, wy);
  return hitStroke(s.points, s.style, p.x, p.y, 0);
}

interface Pt {
  x: number;
  y: number;
}

/** 点到凸多边形（顶点按顺序给出）的距离；点在内部返回 0。朝向无关。 */
function distanceToConvexPolygon(q: Pt, verts: readonly Pt[]): number {
  let sign = 0;
  let outside = false;
  let minDist = Infinity;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const cross = (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) outside = true;
    }
    minDist = Math.min(
      minDist,
      distToSegment(q.x, q.y, a.x, a.y, b.x, b.y),
    );
  }
  return outside ? minDist : 0;
}

/**
 * 点到世界坐标中椭圆的距离。椭圆 = 半径 r 的圆先经线性部分 A 变换得到，
 * 即半轴 r·a、r·b 且带有旋转。做极分解 A = Q·diag(a,b)（Q 为旋转），
 * 把查询点旋进椭圆自身轴系后，轴对齐椭圆最近点满足
 *   z_i = s_i² · q_i / (s_i² + λ)，  z 在椭圆上
 * λ≥0 上二分（该方程关于 λ 单调递减）；点在椭圆内返回 0。
 * 旋转/错切/非等比缩放都走同一精确路径。
 */
function distanceToEllipse(q: Pt, center: Pt, m: Matrix, r: number): number {
  const { qrot, sa, sb } = ellipseFrame(q, center, m);
  if (!(sa > 0) || !(sb > 0) || !(r > 0)) return Infinity;
  const A = sa * r; // 世界半轴长
  const B = sb * r;
  const qx = qrot.x;
  const qy = qrot.y;
  const inside = (qx * qx) / (A * A) + (qy * qy) / (B * B);
  if (inside <= 1) return 0;

  const evalF = (lambda: number) => {
    const zx = (A * A * qx) / (A * A + lambda);
    const zy = (B * B * qy) / (B * B + lambda);
    return (zx * zx) / (A * A) + (zy * zy) / (B * B);
  };
  let lo = 0;
  let hi = Math.max(A, B) * Math.hypot(qx, qy) + 1;
  while (evalF(hi) > 1) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (evalF(mid) > 1) lo = mid;
    else hi = mid;
  }
  const lambda = (lo + hi) / 2;
  const zx = (A * A * qx) / (A * A + lambda);
  const zy = (B * B * qy) / (B * B + lambda);
  return Math.hypot(qx - zx, qy - zy); // 旋转保距，轴系内距离即世界距离
}

/** 极分解 A = Q·diag(sa,sb)，返回查询点在椭圆轴系（相对中心）中的坐标。 */
function ellipseFrame(
  q: Pt,
  center: Pt,
  m: Matrix,
): { qrot: Pt; sa: number; sb: number } {
  // 奇异值
  const { min: sb, max: sa } = axisScales(m);
  const px = q.x - center.x;
  const py = q.y - center.y;
  // 旋转 Q：由 A Aᵀ 的主方向给出。D = A Aᵀ，主特征向量 v 满足
  // tan(2θ) = 2D01/(D00-D11)；用 atan2 稳定求 θ。
  const d00 = m[0] * m[0] + m[2] * m[2];
  const d11 = m[1] * m[1] + m[3] * m[3];
  const d01 = m[0] * m[1] + m[2] * m[3];
  const theta = Math.atan2(2 * d01, d00 - d11) / 2;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // q 相对中心，再乘 Qᵀ 进入椭圆轴系
  return {
    qrot: { x: cos * px + sin * py, y: -sin * px + cos * py },
    sa,
    sb,
  };
}

/**
 * 一段渲染笔迹在局部坐标中是半径 h 的胶囊（段身为矩形、两端为圆盘）。
 * 仿射变换后段身成为平行四边形、端帽成为椭圆 —— 距离取二者最小，
 * 与 canvas 圆头描边经 CTM 变换后的轮廓一致。
 */
function segmentCapsuleDistance(
  q: Pt,
  a: Pt,
  b: Pt,
  halfWidth: number,
  m: Matrix,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return distanceToEllipse(q, a, m, halfWidth);
  // 局部垂直方向（半径方向）
  const nx = -dy / len;
  const ny = dx / len;
  const h = halfWidth;
  const v0 = applyMatrix(m, a.x + nx * h, a.y + ny * h);
  const v1 = applyMatrix(m, b.x + nx * h, b.y + ny * h);
  const v2 = applyMatrix(m, b.x - nx * h, b.y - ny * h);
  const v3 = applyMatrix(m, a.x - nx * h, a.y - ny * h);
  const body = distanceToConvexPolygon(q, [v0, v1, v2, v3]);
  const capA = distanceToEllipse(q, applyMatrix(m, a.x, a.y), m, h);
  const capB = distanceToEllipse(q, applyMatrix(m, b.x, b.y), m, h);
  return Math.min(body, capA, capB);
}

/**
 * 橡皮命中（世界坐标，精确感知 transform）：只使用保存的原始采样
 * （预测点和平滑缓存都不参与），按每段变换后的平行四边形段身 + 椭圆端帽
 * 精确判定 —— 旋转/错切/非等比缩小时与屏幕显示严格一致，既不漏删也不因
 * 近似而误删。无变换时退化为既有的世界坐标线段判定。
 */
export function hitEraseStroke(
  s: Stroke,
  wx: number,
  wy: number,
  radius: number,
): boolean {
  const pts = s.points;
  if (pts.length === 0) return false;
  const m = s.transform;
  if (!m) return hitStroke(pts, s.style, wx, wy, radius);
  const q = { x: wx, y: wy };

  if (pts.length === 1) {
    return (
      distanceToEllipse(q, applyMatrix(m, pts[0].x, pts[0].y), m,
        widthAt(s.style, pts[0].pressure) / 2) <= radius
    );
  }

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    // 与渲染/无变换命中保持同一约定：段宽取两端压力线宽的均值
    const halfWidth =
      (widthAt(s.style, a.pressure) + widthAt(s.style, b.pressure)) / 4;
    if (
      segmentCapsuleDistance(q, { x: a.x, y: a.y }, { x: b.x, y: b.y },
        halfWidth, m) <= radius
    )
      return true;
  }
  return false;
}
