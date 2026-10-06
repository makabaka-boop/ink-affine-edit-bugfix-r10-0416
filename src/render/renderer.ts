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
}

/**
 * 场景绘制：只读取文档数据，绝不修改保存的采样。
 * 已提交的笔画用平滑缓存（若有）渲染，否则用原始采样。
 * 带变换的笔画把「视图 × 笔画矩阵」合成进画布变换后直接画局部坐标采样，
 * 位置与笔尖轮廓一起变形（旋转/错切/非等比缩放下圆头笔尖随之变为椭圆），
 * 与选择/橡皮的命中判定（逆变换到局部坐标）保持一致。
 */
export function renderScene(ctx: CtxLike, scene: Scene): void {
  const { width, height, dpr, view } = scene;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(view.tx, view.ty);
  ctx.scale(view.scale, view.scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of scene.strokes) {
    const pts = s.smoothed ?? s.points;
    const m = s.transform;
    if (m) {
      // 设备变换 = dpr · 视图平移缩放 · 笔画矩阵
      const k = dpr * view.scale;
      ctx.save();
      ctx.setTransform(
        k * m[0],
        k * m[1],
        k * m[2],
        k * m[3],
        k * m[4] + dpr * view.tx,
        k * m[5] + dpr * view.ty,
      );
      drawPolyline(ctx, pts, s.style, 1);
      ctx.restore();
    } else {
      drawPolyline(ctx, pts, s.style, 1);
    }
  }
  if (scene.active) drawPolyline(ctx, scene.active, scene.activeStyle, 1);
  if (scene.preview) drawPolyline(ctx, scene.preview, scene.activeStyle, 0.5);
  ctx.restore();
}

function drawPolyline(
  ctx: CtxLike,
  points: readonly Sample[],
  style: StrokeStyle,
  alpha: number,
): void {
  if (points.length === 0) return;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = style.color;
  if (points.length === 1) {
    const p = points[0];
    ctx.lineWidth = widthAt(style, p.pressure);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.01, p.y);
    ctx.stroke();
  } else {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      ctx.lineWidth = widthAt(style, (a.pressure + b.pressure) / 2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}
