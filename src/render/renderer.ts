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
    const m = s.transform;
    const pts = s.smoothed ?? s.points;
    drawPolyline(
      ctx,
      m
        ? pts.map((p) => ({
            ...p,
            x: m[0] * p.x + m[2] * p.y + m[4],
            y: m[1] * p.x + m[3] * p.y + m[5],
          }))
        : pts,
      s.style,
      1,
    );
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
