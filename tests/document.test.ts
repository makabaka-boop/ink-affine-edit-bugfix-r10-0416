import { describe, expect, it } from "vitest";
import { Document, MAX_DOCUMENT_POINTS } from "../src/model/document";
import { exportDocument } from "../src/model/export";
import type { Sample } from "../src/model/types";

const STYLE = { color: "#000", baseWidth: 4 };

function pts(n: number): Sample[] {
  return Array.from({ length: n }, (_, i) => ({
    x: i,
    y: i,
    pressure: 0.5,
    t: i,
  }));
}

describe("文档采样点上限（两万）", () => {
  it("超出上限的笔画被截断，预算耗尽后拒绝新笔画", () => {
    const doc = new Document();
    const s1 = doc.commitStroke(pts(12000), STYLE)!;
    expect(s1.points).toHaveLength(12000);

    const s2 = doc.commitStroke(pts(9000), STYLE)!;
    expect(s2.points).toHaveLength(8000); // 截断到剩余预算
    expect(doc.totalPoints).toBe(MAX_DOCUMENT_POINTS);

    expect(doc.commitStroke(pts(10), STYLE)).toBeNull(); // 预算耗尽
    expect(doc.totalPoints).toBe(MAX_DOCUMENT_POINTS);
  });

  it("单笔画超过两万点也截断到两万", () => {
    const doc = new Document();
    const s = doc.commitStroke(pts(25000), STYLE)!;
    expect(s.points).toHaveLength(MAX_DOCUMENT_POINTS);
    expect(doc.totalPoints).toBe(MAX_DOCUMENT_POINTS);
  });

  it("撤销释放采样点预算", () => {
    const doc = new Document();
    doc.commitStroke(pts(15000), STYLE);
    doc.commitStroke(pts(5000), STYLE);
    expect(doc.remainingPointBudget()).toBe(0);

    doc.undo(); // 撤销第二笔
    expect(doc.remainingPointBudget()).toBe(5000);
    const s = doc.commitStroke(pts(5000), STYLE)!;
    expect(s.points).toHaveLength(5000);
  });
});

describe("导出", () => {
  it("导出内容等于保存的采样", () => {
    const doc = new Document();
    const input = pts(50);
    const stroke = doc.commitStroke(input, STYLE)!;
    // 平滑缓存存在也不影响导出
    doc.applySmoothed(
      stroke.id,
      doc.editGen,
      pts(50).map((p) => ({ ...p, y: p.y + 1 })),
    );

    const parsed = JSON.parse(exportDocument(doc));
    expect(parsed.strokes).toHaveLength(1);
    expect(parsed.strokes[0].points).toEqual(JSON.parse(JSON.stringify(input)));
    expect(parsed.strokes[0].color).toBe("#000");
  });
});

describe("编辑代次", () => {
  it("可撤销编辑推进代次，applySmoothed 不推进", () => {
    const doc = new Document();
    expect(doc.editGen).toBe(0);

    const s = doc.commitStroke(pts(3), STYLE)!;
    expect(doc.editGen).toBe(1);
    expect(s.gen).toBe(1);

    expect(doc.applySmoothed(s.id, 1, pts(3))).toBe(true);
    expect(doc.editGen).toBe(1); // 不推进

    doc.eraseStrokes([s.id]);
    expect(doc.editGen).toBe(2);
    expect(doc.applySmoothed(s.id, 1, pts(3))).toBe(false); // 旧代次 + 已擦除

    doc.undo();
    expect(doc.editGen).toBe(3);
    expect(doc.applySmoothed(s.id, 2, pts(3))).toBe(false); // 代次仍不符
    expect(doc.applySmoothed(s.id, 3, pts(3))).toBe(true); // 当前代次可应用
  });
});
