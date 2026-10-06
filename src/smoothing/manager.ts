import type { Document } from "../model/document";
import type { SmoothRequest, SmoothResponse } from "./messages";

export interface WorkerLike {
  postMessage(msg: SmoothRequest): void;
  onmessage: ((ev: MessageEvent<SmoothResponse>) => void) | null;
}

/**
 * 平滑管理器：为尚未平滑的笔画发请求（携带当前编辑代次），
 * 接收结果时交给 Document.applySmoothed 按 (strokeId, gen) 验收 ——
 * 文档在此期间被编辑（gen 变化）或笔画已被擦除时，结果被丢弃，
 * 旧结果不会复活已擦除的笔画。
 */
export class SmoothingManager {
  constructor(
    private readonly doc: Document,
    private readonly worker: WorkerLike,
    private readonly onApplied: () => void = () => {},
  ) {
    this.worker.onmessage = (ev) => this.handleMessage(ev.data);
    // 任何文档变化后，为缺失平滑结果的笔画按新代次重新请求
    this.doc.onEdit(() => this.requestPending());
  }

  requestPending(): void {
    const gen = this.doc.editGen;
    for (const s of this.doc.getStrokes()) {
      if (s.smoothed === null) {
        this.worker.postMessage({
          type: "smooth",
          strokeId: s.id,
          gen,
          points: s.points,
        });
      }
    }
  }

  private handleMessage(msg: SmoothResponse): void {
    if (msg.type !== "smoothed") return;
    if (this.doc.applySmoothed(msg.strokeId, msg.gen, msg.points)) {
      this.onApplied();
    }
  }
}
