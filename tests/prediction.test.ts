import { describe, expect, it } from "vitest";
import { Document } from "../src/model/document";
import { exportDocument } from "../src/model/export";
import { down, makeController, move, sample, up } from "./helpers";

/** 预测点只用于临时预览：不进保存、不进擦除判断、不进导出。 */
describe("预测点与回退", () => {
  it("预测点出现在预览中，但绝不进入提交的笔画", () => {
    const doc = new Document();
    const ctrl = makeController(doc);
    const s0 = sample(0, 0);
    const s1 = sample(10, 1);
    const s2 = sample(20, 2);
    const s3 = sample(30, 3);
    const predicted = [sample(9000, 9000), sample(9010, 9010)];

    ctrl.onPointerDown(down(1, s0));
    ctrl.onPointerMove(move(1, [s1], predicted));

    // 预览可见
    const preview = ctrl.getPreviewPoints();
    expect(preview).toHaveLength(2);
    expect(preview![0].x).toBe(9000);

    ctrl.onPointerMove(move(1, [s2])); // 无预测 → 预览清空
    expect(ctrl.getPreviewPoints()).toBeNull();

    // 再来一批预测（coalesced 为空 → 回退到事件自身采样）
    ctrl.onPointerMove({
      pointerId: 1,
      pointerType: "pen",
      button: 0,
      ...sample(25, 2),
      coalesced: [],
      predicted,
    });
    ctrl.onPointerUp(up(1, s3));

    // 抬笔后预览清空
    expect(ctrl.getPreviewPoints()).toBeNull();
    // 提交的笔画只含真实采样
    const stroke = doc.getStrokes()[0];
    expect(stroke.points.map((p) => p.x)).toEqual([0, 10, 20, 25, 30]);
    expect(stroke.points.some((p) => p.x >= 9000)).toBe(false);
  });

  it("预测点不进入导出", () => {
    const doc = new Document();
    const ctrl = makeController(doc);
    ctrl.onPointerDown(down(1, sample(0, 0)));
    ctrl.onPointerMove(move(1, [sample(10, 0)], [sample(9999, 9999)]));
    ctrl.onPointerUp(up(1, sample(20, 0)));

    const exported = exportDocument(doc);
    expect(exported).not.toContain("9999");
    const parsed = JSON.parse(exported);
    expect(parsed.strokes[0].points).toHaveLength(3);
    expect(parsed.strokes[0].points.map((p: { x: number }) => p.x)).toEqual([
      0, 10, 20,
    ]);
  });

  it("预测点不参与橡皮命中判断", () => {
    const doc = new Document();
    const pen = makeController(doc);
    // 画一条 y=0 的线
    pen.onPointerDown(down(1, sample(0, 0)));
    pen.onPointerMove(move(1, [sample(50, 0)]));
    pen.onPointerUp(up(1, sample(100, 0)));
    expect(doc.getStrokes()).toHaveLength(1);

    // 橡皮：真实路径在远处（y=500），但预测点扫过笔画 —— 不得触发删除
    const eraser = makeController(doc, { tool: "eraser" });
    eraser.onPointerDown(down(2, sample(0, 500)));
    eraser.onPointerMove(
      move(2, [sample(50, 500)], [sample(50, 0), sample(60, 0)]),
    );
    eraser.onPointerUp(up(2, sample(100, 500)));
    expect(doc.getStrokes()).toHaveLength(1);
  });

  it("无预测能力的事件源（predicted 为空）正常工作", () => {
    const doc = new Document();
    const ctrl = makeController(doc);
    ctrl.onPointerDown(down(1, sample(0, 0)));
    ctrl.onPointerMove(move(1, [sample(5, 5)])); // predicted: []
    expect(ctrl.getPreviewPoints()).toBeNull();
    ctrl.onPointerUp(up(1, sample(10, 10)));
    expect(doc.getStrokes()[0].points).toHaveLength(3);
  });

  it("预测点绑定所属笔画：抬笔后不会泄漏到下一笔", () => {
    const doc = new Document();
    const ctrl = makeController(doc);
    ctrl.onPointerDown(down(1, sample(0, 0)));
    ctrl.onPointerMove(move(1, [sample(10, 0)], [sample(8888, 8888)]));
    ctrl.onPointerUp(up(1, sample(20, 0)));

    ctrl.onPointerDown(down(1, sample(100, 100)));
    expect(ctrl.getPreviewPoints()).toBeNull(); // 新笔画无旧预测
    ctrl.onPointerUp(up(1, sample(110, 100)));

    const second = doc.getStrokes()[1];
    expect(second.points.every((p) => p.x < 1000)).toBe(true);
  });
});
