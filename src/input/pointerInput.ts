import { Document, MAX_DOCUMENT_POINTS } from "../model/document";
import {
  hitStroke,
  screenToWorld,
  type ViewTransform,
} from "../model/geometry";
import type { Sample, StrokeStyle } from "../model/types";

/** 屏幕坐标下的原始采样（CSS px）。 */
export interface RawSample {
  x: number;
  y: number;
  pressure: number;
  t: number;
}

/**
 * 输入层与 DOM 解耦的事件形态：coalesced/predicted 由适配层从
 * PointerEvent.getCoalescedEvents()/getPredictedEvents() 取出；
 * 不支持时传空数组，控制器回退到事件自身。
 */
export interface PointerEventData {
  pointerId: number;
  pointerType: string;
  button: number;
  x: number;
  y: number;
  pressure: number;
  t: number;
  coalesced: RawSample[];
  predicted: RawSample[];
}

export type Tool = "pen" | "eraser";

export interface InputHooks {
  getView(): ViewTransform;
  getTool(): Tool;
  getStyle(): StrokeStyle;
  /** 橡皮半径（屏幕 px），内部按视图缩放换算到世界单位。 */
  eraserRadiusPx: number;
  onStateChange(): void;
}

interface ActiveStroke {
  pointerId: number;
  /** 已确认的真实采样（世界坐标）。 */
  points: Sample[];
  /** 预测点：仅临时预览，绝不提交、不参与擦除判断、不导出。 */
  predicted: Sample[];
}

export class PointerInputController {
  private active: ActiveStroke | null = null;
  private erasePointer: number | null = null;

  constructor(
    private readonly doc: Document,
    private readonly hooks: InputHooks,
  ) {}

  get isDrawing(): boolean {
    return this.active !== null;
  }

  getActivePoints(): readonly Sample[] | null {
    return this.active ? this.active.points : null;
  }

  /** 预测预览（临时）；抬笔/取消后立即清空。 */
  getPreviewPoints(): readonly Sample[] | null {
    return this.active && this.active.predicted.length > 0
      ? this.active.predicted
      : null;
  }

  private toWorld(raw: RawSample): Sample {
    const p = screenToWorld(this.hooks.getView(), raw.x, raw.y);
    return { x: p.x, y: p.y, pressure: clamp01(raw.pressure), t: raw.t };
  }

  private batchOf(e: PointerEventData): RawSample[] {
    return e.coalesced.length > 0
      ? e.coalesced
      : [{ x: e.x, y: e.y, pressure: e.pressure, t: e.t }];
  }

  private appendActive(raw: RawSample): void {
    const active = this.active;
    if (!active) return;
    if (this.doc.totalPoints + active.points.length >= MAX_DOCUMENT_POINTS)
      return; // 两万点上限
    active.points.push(this.toWorld(raw));
  }

  onPointerDown(e: PointerEventData): void {
    if (this.active !== null || this.erasePointer !== null) return; // 单指针绘制
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (this.hooks.getTool() === "pen") {
      this.active = {
        pointerId: e.pointerId,
        points: [this.toWorld(e)],
        predicted: [],
      };
    } else {
      this.erasePointer = e.pointerId;
      this.doc.beginErasePass();
      this.eraseAt(e);
    }
    this.hooks.onStateChange();
  }

  onPointerMove(e: PointerEventData): void {
    if (this.active && e.pointerId === this.active.pointerId) {
      for (const raw of this.batchOf(e)) this.appendActive(raw);
      // 预测点只进临时预览缓冲，与真实采样严格分离
      this.active.predicted = e.predicted.map((p) => this.toWorld(p));
      this.hooks.onStateChange();
    } else if (
      this.erasePointer !== null &&
      e.pointerId === this.erasePointer
    ) {
      for (const raw of this.batchOf(e)) this.eraseAt(raw);
      this.hooks.onStateChange();
    }
  }

  onPointerUp(e: PointerEventData): void {
    if (this.active && e.pointerId === this.active.pointerId) {
      for (const raw of this.batchOf(e)) this.appendActive(raw);
      const points = this.active.points;
      // 先清活动笔画：随后的 lostpointercapture 不得误伤已提交的笔画
      this.active = null;
      this.doc.commitStroke(points, this.hooks.getStyle());
      this.hooks.onStateChange();
    } else if (
      this.erasePointer !== null &&
      e.pointerId === this.erasePointer
    ) {
      for (const raw of this.batchOf(e)) this.eraseAt(raw);
      this.erasePointer = null;
      this.doc.endErasePass(); // 本次擦除经过的所有删除合并为一个可撤销操作
      this.hooks.onStateChange();
    }
  }

  onPointerCancel(e: { pointerId: number }): void {
    this.discard(e.pointerId);
  }

  onLostPointerCapture(e: { pointerId: number }): void {
    this.discard(e.pointerId);
  }

  /** 取消或失去捕获：丢弃未完成笔画，不提交、不进撤销栈。 */
  private discard(pointerId: number): void {
    let changed = false;
    if (this.active && this.active.pointerId === pointerId) {
      this.active = null;
      changed = true;
    }
    if (this.erasePointer === pointerId) {
      this.erasePointer = null;
      this.doc.endErasePass(); // 已发生的删除保留为一次可撤销操作
      changed = true;
    }
    if (changed) this.hooks.onStateChange();
  }

  /** 橡皮命中判定只针对保存的采样（doc 内的 strokes），预测点不参与。 */
  private eraseAt(raw: RawSample): void {
    const view = this.hooks.getView();
    const w = screenToWorld(view, raw.x, raw.y);
    const radius = this.hooks.eraserRadiusPx / view.scale;
    for (const s of this.doc.getStrokes()) {
      if (hitStroke(s.points, s.style, w.x, w.y, radius))
        this.doc.eraseStroke(s.id);
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
