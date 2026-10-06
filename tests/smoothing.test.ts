import { describe, expect, it } from "vitest";
import { Document } from "../src/model/document";
import type { SmoothRequest, SmoothResponse } from "../src/smoothing/messages";
import { SmoothingManager, type WorkerLike } from "../src/smoothing/manager";
import { smoothPoints } from "../src/smoothing/smooth";
import type { Sample } from "../src/model/types";

/** 同步可控的假 Worker：收集请求，flush 时按真实 Worker 逻辑回包。 */
class FakeWorker implements WorkerLike {
  onmessage: ((ev: { data: SmoothResponse }) => void) | null = null;
  inbox: SmoothRequest[] = [];

  postMessage(msg: SmoothRequest): void {
    this.inbox.push(msg);
  }

  flush(): void {
    const msgs = this.inbox.splice(0);
    for (const m of msgs) {
      this.onmessage?.({
        data: {
          type: "smoothed",
          strokeId: m.strokeId,
          gen: m.gen,
          points: smoothPoints(m.points),
        },
      });
    }
  }
}

function pts(n: number): Sample[] {
  return Array.from({ length: n }, (_, i) => ({
    x: i * 10,
    y: (i % 3) * 5,
    pressure: 0.5,
    t: i,
  }));
}

const STYLE = { color: "#000", baseWidth: 4 };

describe("Worker 平滑与编辑代次", () => {
  it("代次匹配时应用平滑结果，且不改动保存的采样、不推进代次", () => {
    const doc = new Document();
    const worker = new FakeWorker();
    new SmoothingManager(doc, worker);

    const stroke = doc.commitStroke(pts(10), STYLE)!;
    expect(worker.inbox.length).toBeGreaterThan(0);
    expect(worker.inbox.at(-1)!.gen).toBe(doc.editGen);

    const genBefore = doc.editGen;
    const savedBefore = JSON.parse(JSON.stringify(stroke.points));
    worker.flush();

    expect(stroke.smoothed).not.toBeNull();
    expect(stroke.smoothed).toHaveLength(10);
    expect(stroke.points).toEqual(savedBefore); // 保存的采样不变
    expect(doc.editGen).toBe(genBefore); // 平滑不是可撤销编辑
  });

  it("笔画被擦除后，旧平滑结果不能复活它", () => {
    const doc = new Document();
    const worker = new FakeWorker();
    new SmoothingManager(doc, worker);

    const stroke = doc.commitStroke(pts(10), STYLE)!;
    const request = worker.inbox.at(-1)!;
    doc.eraseStrokes([stroke.id]); // 擦除：gen 前进，请求变为旧代次
    expect(doc.getStrokes()).toHaveLength(0);

    worker.flush(); // 旧结果到达
    expect(doc.getStrokes()).toHaveLength(0); // 没有复活
    expect(request.strokeId).toBe(stroke.id);
  });

  it("撤销擦除后按新代次重新平滑", () => {
    const doc = new Document();
    const worker = new FakeWorker();
    new SmoothingManager(doc, worker);

    const stroke = doc.commitStroke(pts(10), STYLE)!;
    doc.eraseStrokes([stroke.id]);
    worker.flush(); // 丢弃旧结果
    worker.inbox.length = 0;

    doc.undo(); // 笔画恢复，smoothed 为 null
    const restored = doc.getStroke(stroke.id)!;
    expect(restored.smoothed).toBeNull();
    // 管理器在编辑后自动按新代次重发
    expect(worker.inbox.at(-1)!.gen).toBe(doc.editGen);

    worker.flush();
    expect(restored.smoothed).not.toBeNull();
  });

  it("无关编辑推进代次后，途中结果按旧代次被丢弃、按新代次被接受", () => {
    const doc = new Document();
    const worker = new FakeWorker();
    const mgr = new SmoothingManager(doc, worker);

    const s1 = doc.commitStroke(pts(10), STYLE)!;
    doc.commitStroke(pts(5), STYLE); // 推进代次；管理器已为 s1 重发新代次请求

    // 只投递最早的（旧代次）请求
    const stale = worker.inbox[0];
    worker.inbox = [stale];
    worker.flush();
    expect(s1.smoothed).toBeNull(); // 旧代次被丢弃

    mgr.requestPending(); // 按当前代次重发
    worker.flush();
    expect(s1.smoothed).not.toBeNull();
  });

  it("smoothPoints 是纯函数：保留端点与长度，不改输入", () => {
    const input = pts(10);
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = smoothPoints(input);
    expect(out).toHaveLength(input.length);
    expect(out[0]).toEqual(input[0]);
    expect(out[out.length - 1]).toEqual(input[input.length - 1]);
    expect(input).toEqual(snapshot);
    expect(smoothPoints(pts(2))).toHaveLength(2); // 短笔画原样返回
  });
});
