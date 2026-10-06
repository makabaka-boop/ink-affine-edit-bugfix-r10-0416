import type { StrokeStyle } from "./types";

/** 视图变换：screen = world * scale + (tx, ty)。 */
export interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

export const identityView = (): ViewTransform => ({ scale: 1, tx: 0, ty: 0 });

export function screenToWorld(
  view: ViewTransform,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return { x: (sx - view.tx) / view.scale, y: (sy - view.ty) / view.scale };
}

export function worldToScreen(
  view: ViewTransform,
  wx: number,
  wy: number,
): { x: number; y: number } {
  return { x: wx * view.scale + view.tx, y: wy * view.scale + view.ty };
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 16;

/** 以屏幕点 (sx, sy) 为锚缩放：锚点下的世界坐标保持不动。 */
export function zoomAt(
  view: ViewTransform,
  sx: number,
  sy: number,
  factor: number,
): ViewTransform {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  const k = scale / view.scale;
  return { scale, tx: sx - (sx - view.tx) * k, ty: sy - (sy - view.ty) * k };
}

export function panBy(
  view: ViewTransform,
  dx: number,
  dy: number,
): ViewTransform {
  return { ...view, tx: view.tx + dx, ty: view.ty + dy };
}

/** 某压力下的线宽（世界单位）。压力 clamp 到 [0.05, 1]，避免 0 宽。 */
export function widthAt(style: StrokeStyle, pressure: number): number {
  const p = pressure < 0.05 ? 0.05 : pressure > 1 ? 1 : pressure;
  return style.baseWidth * p;
}

export function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * 橡皮命中判定：基于保存的原始采样（不是平滑结果，更不是预测点），
 * 世界坐标下点 (wx, wy) 距任一线段 ≤ 橡皮半径 + 该段线宽一半即命中。
 */
export function hitStroke(
  points: readonly { x: number; y: number; pressure: number }[],
  style: StrokeStyle,
  wx: number,
  wy: number,
  radius: number,
): boolean {
  if (points.length === 0) return false;
  if (points.length === 1) {
    const r = radius + widthAt(style, points[0].pressure) / 2;
    return Math.hypot(points[0].x - wx, points[0].y - wy) <= r;
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const halfWidth =
      (widthAt(style, a.pressure) + widthAt(style, b.pressure)) / 4;
    if (distToSegment(wx, wy, a.x, a.y, b.x, b.y) <= radius + halfWidth)
      return true;
  }
  return false;
}
