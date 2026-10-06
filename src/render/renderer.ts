import { widthAt, type ViewTransform } from "../model/geometry";
import type { Sample, Stroke, StrokeStyle } from "../model/types";

/** CanvasRenderingContext2D 的最小子集，便于测试中用 mock 验证渲染纯度。 */
export interface CtxLike {
  setTransform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  transform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  lineCap: string;
  lineJoin: string;
  strokeStyle: unknown;
  lineWidth: number;
  globalAlpha: number;
}

export interface Scene {
  width: number;
  height: number;
  dpr: number;
  view: ViewTransform;
  strokes: readonly Stroke[];
  /** 进行中的笔画（真实采样）。 */
  active: readonly Sample[] | null;
  /** 预测点预览（临时，半透明）。 */
  preview: readonly Sample[] | null;
  activeStyle: StrokeStyle;
  /** 当前选中的笔画 id；选中轮廓随同一变换矩阵一起变形。 */
  selectedIds?: ReadonlySet<string>;
}

/** 选中轮廓在压力线宽外额外加宽的世界单位（命中判断不使用它）。 */
const SELECTION_PADDING = 6;
const SELECTION_COLOR = "#2f81f7";

/**
 * 场景绘制：只读取文档数据，绝不修改保存的采样。
 * 已提交的笔画用平滑缓存（若有）渲染，否则用原始采样；笔画的仿射矩阵通过
 * canvas CTM 施加，因此笔尖轮廓（线宽、圆头、错切/非等比缩放）与采样中心
 * 一起变形，与世界坐标下的选择/橡皮判定一致。
 */
export function renderScene(ctx: CtxLike, scene: Scene): void {
  const { width, height, dpr, view, selectedIds } = scene;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(view.tx, view.ty);
  ctx.scale(view.scale, view.scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of scene.strokes) {
    ctx.save();
    if (s.transform) {
      const m = s.transform;
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    }
    const pts = s.smoothed ?? s.points;
    if (selectedIds?.has(s.id)) {
      // 选中轮廓：同样在笔画 CTM 内绘制，旋转/错切/缩放时随笔迹一起变形
      drawPolyline(ctx, pts, s.style, 0.35, SELECTION_PADDING, SELECTION_COLOR);
    }
    drawPolyline(ctx, pts, s.style, 1, 0);
    ctx.restore();
  }
  if (scene.active) drawPolyline(ctx, scene.active, scene.activeStyle, 1, 0);
  if (scene.preview)
    drawPolyline(ctx, scene.preview, scene.activeStyle, 0.5, 0);
  ctx.restore();
}

function drawPolyline(
  ctx: CtxLike,
  points: readonly Sample[],
  style: StrokeStyle,
  alpha: number,
  padding: number,
  color: string = style.color,
): void {
  if (points.length === 0) return;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  if (points.length === 1) {
    const p = points[0];
    ctx.lineWidth = widthAt(style, p.pressure) + padding;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.01, p.y);
    ctx.stroke();
  } else {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      ctx.lineWidth =
        widthAt(style, (a.pressure + b.pressure) / 2) + padding;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}
