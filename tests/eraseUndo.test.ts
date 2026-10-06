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

/** 橡皮：命中删除整条笔画；一次擦除经过的所有删除合并为一个可撤销操作。 */
describe("擦除与撤销", () => {
  function docWithThreeLines(): Document {
    const doc = new Document();
    drawLineStroke(doc, 0); // stroke-1: y=0
    drawLineStroke(doc, 100); // stroke-2: y=100
    drawLineStroke(doc, 200); // stroke-3: y=200
    return doc;
  }

  it("一次擦除经过多条笔画 = 一个可撤销操作", () => {
    const doc = docWithThreeLines();
    const ids = doc.getStrokes().map((s) => s.id);
    const eraser = makeController(doc, { tool: "eraser", eraserRadiusPx: 10 });

    // 从 y=5 划到 y=100：先后命中 stroke-1 和 stroke-2
    eraser.onPointerDown(down(2, sample(50, 5)));
    expect(doc.hasStroke(ids[0])).toBe(false); // 命中即删（实时反馈）
    expect(doc.hasStroke(ids[1])).toBe(true);
    eraser.onPointerMove(move(2, [sample(50, 50), sample(50, 100)]));
    expect(doc.hasStroke(ids[1])).toBe(false);
    eraser.onPointerUp(up(2, sample(50, 105)));

    expect(doc.getStrokes().map((s) => s.id)).toEqual([ids[2]]);
    expect(doc.undoDepth).toBe(4); // 3 次添加 + 1 次擦除（合并）

    // 一次撤销恢复本次擦除删掉的所有笔画，且顺序不变
    expect(doc.undo()).toBe(true);
    expect(doc.getStrokes().map((s) => s.id)).toEqual(ids);
  });

  it("擦除未命中不产生撤销操作", () => {
    const doc = docWithThreeLines();
    const depth = doc.undoDepth;
    const eraser = makeController(doc, { tool: "eraser" });
    eraser.onPointerDown(down(2, sample(50, 500)));
    eraser.onPointerMove(move(2, [sample(60, 500)]));
    eraser.onPointerUp(up(2, sample(70, 500)));
    expect(doc.getStrokes()).toHaveLength(3);
    expect(doc.undoDepth).toBe(depth);
  });

  it("命中判定考虑线宽与橡皮半径", () => {
    const doc = new Document();
    drawLineStroke(doc, 0); // baseWidth 4, pressure .5 → 线宽 2，半径 1
    const eraser = makeController(doc, { tool: "eraser", eraserRadiusPx: 10 });

    // 距离 12 > 10(橡皮) + 1(线宽一半) → 不命中
    eraser.onPointerDown(down(2, sample(50, 12)));
    eraser.onPointerUp(up(2, sample(50, 12)));
    expect(doc.getStrokes()).toHaveLength(1);

    // 距离 10 ≤ 11 → 命中
    eraser.onPointerDown(down(2, sample(50, 10)));
    eraser.onPointerUp(up(2, sample(50, 10)));
    expect(doc.getStrokes()).toHaveLength(0);
  });

  it("撤销提交笔画", () => {
    const doc = new Document();
    drawLineStroke(doc, 0);
    expect(doc.getStrokes()).toHaveLength(1);
    expect(doc.undo()).toBe(true);
    expect(doc.getStrokes()).toHaveLength(0);
    expect(doc.totalPoints).toBe(0);
    expect(doc.undo()).toBe(false); // 栈空
  });

  it("撤销擦除后再撤销添加，顺序正确", () => {
    const doc = new Document();
    drawLineStroke(doc, 0);
    drawLineStroke(doc, 100);
    const ids = doc.getStrokes().map((s) => s.id);

    doc.eraseStrokes([ids[0], ids[1]]);
    expect(doc.getStrokes()).toHaveLength(0);

    doc.undo(); // 撤销擦除 → 两条都回来
    expect(doc.getStrokes().map((s) => s.id)).toEqual(ids);
    doc.undo(); // 撤销第二次添加
    expect(doc.getStrokes().map((s) => s.id)).toEqual([ids[0]]);
    doc.undo(); // 撤销第一次添加
    expect(doc.getStrokes()).toHaveLength(0);
  });
});
