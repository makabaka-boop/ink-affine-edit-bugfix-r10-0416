import { describe, expect, it } from "vitest";
import { Document } from "../src/model/document";
import {
  drawStrokeWithBatches,
  makeController,
  sample,
  type RawSample,
} from "./helpers";

/**
 * 同一物理输入，无论 Pointer Events 如何分批（逐点、整批、混合），
 * 提交后的笔画采样必须完全一致。
 */
describe("事件分批不影响笔画结果", () => {
  const N = 120;
  const inputs: RawSample[] = Array.from({ length: N }, (_, i) =>
    sample(i * 2, Math.sin(i / 5) * 20, 0.1 + (i % 10) / 10),
  );
  const middle = inputs.slice(1, -1);

  function run(batches: RawSample[][]): Document {
    const doc = new Document();
    const ctrl = makeController(doc);
    drawStrokeWithBatches(ctrl, 1, inputs, batches);
    return doc;
  }

  it("逐点 / 整批 / 不规则分批，结果一致", () => {
    const perPoint = run(middle.map((p) => [p]));
    const oneBatch = run([middle]);
    const chunks: RawSample[][] = [];
    for (let i = 0, size = 1; i < middle.length; size = (size % 7) + 1) {
      chunks.push(middle.slice(i, i + size));
      i += size;
    }
    const mixed = run(chunks);

    const a = perPoint.getStrokes()[0].points;
    const b = oneBatch.getStrokes()[0].points;
    const c = mixed.getStrokes()[0].points;

    expect(a).toHaveLength(N);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("压力与坐标按序绑定到所属笔画", () => {
    const doc = run(middle.map((p) => [p]));
    const stroke = doc.getStrokes()[0];
    expect(doc.getStrokes()).toHaveLength(1);
    stroke.points.forEach((p, i) => {
      expect(p.x).toBe(inputs[i].x);
      expect(p.y).toBe(inputs[i].y);
      expect(p.pressure).toBeCloseTo(inputs[i].pressure, 10);
    });
    expect(doc.totalPoints).toBe(N);
  });

  it("合并事件为空时回退到事件自身", () => {
    const doc = new Document();
    const ctrl = makeController(doc);
    const s0 = sample(0, 0);
    const s1 = sample(10, 10, 0.8);
    const s2 = sample(20, 20);
    ctrl.onPointerDown({
      pointerId: 1,
      pointerType: "pen",
      button: 0,
      ...s0,
      coalesced: [],
      predicted: [],
    });
    // coalesced 为空 → 使用事件自身坐标
    ctrl.onPointerMove({
      pointerId: 1,
      pointerType: "pen",
      button: 0,
      ...s1,
      coalesced: [],
      predicted: [],
    });
    ctrl.onPointerUp({
      pointerId: 1,
      pointerType: "pen",
      button: 0,
      ...s2,
      coalesced: [],
      predicted: [],
    });
    const pts = doc.getStrokes()[0].points;
    expect(pts.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [10, 10],
      [20, 20],
    ]);
    expect(pts[1].pressure).toBeCloseTo(0.8, 10);
  });
});
