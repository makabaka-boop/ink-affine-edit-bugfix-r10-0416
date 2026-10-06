import { describe, expect, it } from "vitest";
import { Document } from "../src/model/document";
import {
  down,
  drawLineStroke,
  makeController,
  move,
  sample,
  up,
} from "./helpers";

/** 取消 / 失去捕获：撤销未完成笔画；正常抬笔后的 lostpointercapture 不得误伤。 */
describe("取消与失去捕获", () => {
  it("pointercancel 丢弃未完成笔画", () => {
    const doc = new Document();
    const ctrl = makeController(doc);
    ctrl.onPointerDown(down(1, sample(0, 0)));
    ctrl.onPointerMove(
      move(1, [sample(10, 0), sample(20, 0)], [sample(30, 0)]),
    );
    expect(ctrl.getActivePoints()).toHaveLength(3);
    ctrl.onPointerCancel({ pointerId: 1 });
    expect(doc.getStrokes()).toHaveLength(0);
    expect(doc.undoDepth).toBe(0);
    expect(ctrl.getActivePoints()).toBeNull();
    expect(ctrl.getPreviewPoints()).toBeNull();
  });

  it("lostpointercapture 丢弃未完成笔画", () => {
    const doc = new Document();
    const ctrl = makeController(doc);
    ctrl.onPointerDown(down(1, sample(0, 0)));
    ctrl.onPointerMove(move(1, [sample(10, 0)]));
    ctrl.onLostPointerCapture({ pointerId: 1 });
    expect(doc.getStrokes()).toHaveLength(0);
    expect(ctrl.getActivePoints()).toBeNull();
  });

  it("正常抬笔后的 lostpointercapture 不影响已提交笔画", () => {
    const doc = new Document();
    const ctrl = makeController(doc);
    ctrl.onPointerDown(down(1, sample(0, 0)));
    ctrl.onPointerMove(move(1, [sample(10, 0)]));
    ctrl.onPointerUp(up(1, sample(20, 0)));
    // 浏览器在 pointerup 后释放捕获并派发 lostpointercapture
    ctrl.onLostPointerCapture({ pointerId: 1 });
    expect(doc.getStrokes()).toHaveLength(1);
    expect(doc.undoDepth).toBe(1);
  });

  it("cancel 后再 lostpointercapture 不重复处理", () => {
    const doc = new Document();
    const ctrl = makeController(doc);
    ctrl.onPointerDown(down(1, sample(0, 0)));
    ctrl.onPointerCancel({ pointerId: 1 });
    ctrl.onLostPointerCapture({ pointerId: 1 });
    expect(doc.getStrokes()).toHaveLength(0);
    expect(doc.undoDepth).toBe(0);
  });

  it("第二支指针的输入被忽略（采样绑定所属笔画）", () => {
    const doc = new Document();
    const ctrl = makeController(doc);
    ctrl.onPointerDown(down(1, sample(0, 0)));
    ctrl.onPointerDown(down(2, sample(500, 500))); // 绘制中，忽略
    ctrl.onPointerMove(move(2, [sample(600, 600)])); // 非活动指针，忽略
    ctrl.onPointerMove(move(1, [sample(10, 0)]));
    ctrl.onPointerUp(up(2, sample(700, 700))); // 非活动指针，忽略
    ctrl.onPointerUp(up(1, sample(20, 0)));

    expect(doc.getStrokes()).toHaveLength(1);
    const pts = doc.getStrokes()[0].points;
    expect(pts.map((p) => p.x)).toEqual([0, 10, 20]);
  });

  it("擦除过程中取消：已发生的删除保留为一次可撤销操作", () => {
    const doc = new Document();
    drawLineStroke(doc, 0);
    const eraser = makeController(doc, { tool: "eraser" });
    eraser.onPointerDown(down(2, sample(50, 0))); // 命中删除
    expect(doc.getStrokes()).toHaveLength(0);
    eraser.onPointerCancel({ pointerId: 2 });

    expect(doc.undoDepth).toBe(2); // 添加 + 一次擦除
    expect(doc.undo()).toBe(true);
    expect(doc.getStrokes()).toHaveLength(1);
  });
});
