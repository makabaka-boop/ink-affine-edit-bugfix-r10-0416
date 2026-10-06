import { describe, expect, it } from "vitest";
import {
  applyToPoint,
  compose,
  containsStroke,
  identity,
  invert,
  type Matrix,
} from "../src/model/affine";
import { Document } from "../src/model/document";
import { exportDocument } from "../src/model/export";
import { identityView } from "../src/model/geometry";
import { renderScene, type CtxLike } from "../src/render/renderer";
import { down, drawLineStroke, makeController, sample, up } from "./helpers";
import type { Sample } from "../src/model/types";

const STYLE = { color: "#000", baseWidth: 4 };

function pts(n: number): Sample[] {
  return Array.from({ length: n }, (_, i) => ({
    x: i * 10,
    y: 0,
    pressure: 0.5,
    t: i,
  }));
}

function expectMatrix(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(6);
  for (let i = 0; i < 6; i++) expect(actual[i]).toBeCloseTo(expected[i], 10);
}

const ROT90: Matrix = [0, 1, -1, 0, 0, 0]; // 逆时针 90°
const SHEAR: Matrix = [1, 0, 0.5, 1, 0, 0];
const SCALE_XY: Matrix = [2, 0, 0, 0.5, 0, 0];

describe("仿射矩阵复合", () => {
  it("compose 是真矩阵乘法，顺序敏感：新矩阵左乘已有矩阵", () => {
    const t: Matrix = [1, 0, 0, 1, 10, 0]; // 先平移
    // compose(ROT90, t)：先平移、再旋转
    const p1 = applyToPoint(compose(ROT90, t), 0, 0);
    expect(p1.x).toBeCloseTo(0, 10);
    expect(p1.y).toBeCloseTo(10, 10);
    // compose(t, ROT90)：先旋转、再平移 —— 顺序不同结果不同
    const p2 = applyToPoint(compose(t, ROT90), 0, 0);
    expect(p2.x).toBeCloseTo(10, 10);
    expect(p2.y).toBeCloseTo(0, 10);
  });

  it("复合矩阵等于逐次应用；invert 为其逆", () => {
    const m = compose(SCALE_XY, compose(SHEAR, ROT90));
    for (const [x, y] of [
      [3, -7],
      [0, 0],
      [-11, 5],
    ]) {
      const seq = applyToPoint(SCALE_XY, ...(() => {
        const p = applyToPoint(SHEAR, ...(() => {
          const q = applyToPoint(ROT90, x, y);
          return [q.x, q.y] as const;
        })());
        return [p.x, p.y] as const;
      })());
      const viaM = applyToPoint(m, x, y);
      expect(viaM.x).toBeCloseTo(seq.x, 10);
      expect(viaM.y).toBeCloseTo(seq.y, 10);
      const back = applyToPoint(invert(m), viaM.x, viaM.y);
      expect(back.x).toBeCloseTo(x, 8);
      expect(back.y).toBeCloseTo(y, 8);
    }
  });
});

describe("连续变换与撤销", () => {
  it("连续旋转、错切、非等比缩放按执行顺序左乘累积", () => {
    const doc = new Document();
    const s = doc.commitStroke(pts(5), STYLE)!;
    const cos = Math.cos(Math.PI / 6);
    const sin = Math.sin(Math.PI / 6);
    const rot30: Matrix = [cos, sin, -sin, cos, 0, 0];
    doc.transformStrokes([s.id], rot30);
    doc.transformStrokes([s.id], SHEAR);
    doc.transformStrokes([s.id], SCALE_XY);
    expectMatrix(
      doc.getStroke(s.id)!.transform!,
      compose(SCALE_XY, compose(SHEAR, rot30)),
    );
    // 原始采样保持局部坐标不变
    expect(doc.getStroke(s.id)!.points.map((p) => p.x)).toEqual([
      0, 10, 20, 30, 40,
    ]);
  });

  it("每次合法变换是一条完整撤销记录，撤销恢复全部选中笔画的旧矩阵", () => {
    const doc = new Document();
    const a = doc.commitStroke(pts(3), STYLE)!;
    const b = doc.commitStroke(pts(3), STYLE)!;
    doc.transformStrokes([a.id], ROT90); // a 已有变换
    const depth = doc.undoDepth;

    doc.transformStrokes([a.id, b.id], SCALE_XY);
    expect(doc.undoDepth).toBe(depth + 1); // 一批 = 一条记录
    expectMatrix(doc.getStroke(a.id)!.transform!, compose(SCALE_XY, ROT90));
    expectMatrix(doc.getStroke(b.id)!.transform!, SCALE_XY);

    expect(doc.undo()).toBe(true); // 一次撤销恢复两条笔画
    expectMatrix(doc.getStroke(a.id)!.transform!, ROT90);
    expectMatrix(doc.getStroke(b.id)!.transform!, identity());
  });

  it("擦除撤销恢复笔画及其变换", () => {
    const doc = new Document();
    const s = doc.commitStroke(pts(3), STYLE)!;
    doc.transformStrokes([s.id], SHEAR);
    doc.eraseStrokes([s.id]);
    expect(doc.getStrokes()).toHaveLength(0);
    doc.undo(); // 撤销擦除
    expectMatrix(doc.getStroke(s.id)!.transform!, SHEAR);
    doc.undo(); // 撤销变换
    expectMatrix(doc.getStroke(s.id)!.transform!, identity());
  });
});

describe("变换编辑的原子性", () => {
  it("选择中含有不存在的 id：整次拒绝，其它笔画不受影响、无撤销记录", () => {
    const doc = new Document();
    const a = doc.commitStroke(pts(3), STYLE)!;
    const b = doc.commitStroke(pts(3), STYLE)!;
    const gen = doc.editGen;
    const depth = doc.undoDepth;
    expect(() => doc.transformStrokes([a.id, "ghost", b.id], ROT90)).toThrow();
    expect(doc.getStroke(a.id)!.transform).toBeUndefined();
    expect(doc.getStroke(b.id)!.transform).toBeUndefined();
    expect(doc.undoDepth).toBe(depth);
    expect(doc.editGen).toBe(gen);
  });

  it("重复 id / 非法矩阵 / 奇异矩阵：整次拒绝", () => {
    const doc = new Document();
    const a = doc.commitStroke(pts(3), STYLE)!;
    const gen = doc.editGen;
    const depth = doc.undoDepth;
    expect(() => doc.transformStrokes([a.id, a.id], ROT90)).toThrow();
    expect(() => doc.transformStrokes([a.id], [1, 0, 0, 1, 0])).toThrow();
    expect(() =>
      doc.transformStrokes([a.id], [1, 0, 0, 1, 0, Number.NaN]),
    ).toThrow();
    expect(() => doc.transformStrokes([a.id], [1, 2, 2, 4, 0, 0])).toThrow(); // 奇异
    expect(() => doc.transformStrokes([a.id], [10001, 0, 0, 1, 0, 0])).toThrow();
    expect(doc.getStroke(a.id)!.transform).toBeUndefined();
    expect(doc.undoDepth).toBe(depth);
    expect(doc.editGen).toBe(gen);
  });

  it("空选择不产生编辑", () => {
    const doc = new Document();
    doc.commitStroke(pts(3), STYLE);
    const gen = doc.editGen;
    const depth = doc.undoDepth;
    doc.transformStrokes([], ROT90);
    expect(doc.undoDepth).toBe(depth);
    expect(doc.editGen).toBe(gen);
  });
});

describe("选择命中与显示一致", () => {
  function docWithLine(): { doc: Document; id: string } {
    const doc = new Document();
    drawLineStroke(doc, 0); // y=0，x∈[0,100]，pressure .5 → 半宽 1
    return { doc, id: doc.getStrokes()[0].id };
  }

  it("平移后命中新位置、不命中旧位置", () => {
    const { doc, id } = docWithLine();
    doc.transformStrokes([id], [1, 0, 0, 1, 0, 50]);
    const s = doc.getStroke(id)!;
    expect(containsStroke(s, 50, 50)).toBe(true);
    expect(containsStroke(s, 50, 51)).toBe(true);
    expect(containsStroke(s, 50, 52)).toBe(false);
    expect(containsStroke(s, 50, 0)).toBe(false); // 旧位置
  });

  it("旋转 90° 后命中旋转后的轮廓", () => {
    const { doc, id } = docWithLine();
    doc.transformStrokes([id], ROT90); // (x,0) → (0,x)
    const s = doc.getStroke(id)!;
    expect(containsStroke(s, 0, 50)).toBe(true);
    expect(containsStroke(s, 0.5, 50)).toBe(true);
    expect(containsStroke(s, 1.5, 50)).toBe(false);
    expect(containsStroke(s, 50, 0)).toBe(false); // 旧位置
  });

  it("非等比缩放：方向宽度随之变形", () => {
    const { doc, id } = docWithLine();
    doc.transformStrokes([id], [3, 0, 0, 1, 0, 0]); // x 拉 3 倍，y 不变
    const s = doc.getStroke(id)!;
    expect(containsStroke(s, 250, 0.5)).toBe(true); // 拉长后的笔迹上
    expect(containsStroke(s, 250, 1.5)).toBe(false); // y 方向半宽仍为 1
    expect(containsStroke(s, 350, 0)).toBe(false); // 超出拉伸后的末端
  });

  it("命中基于保存的原始采样，不随平滑缓存变化", () => {
    const { doc, id } = docWithLine();
    doc.transformStrokes([id], [1, 0, 0, 1, 0, 50]);
    const s = doc.getStroke(id)!;
    // 平滑缓存被挪到远处，命中仍跟随原始采样
    doc.applySmoothed(
      id,
      doc.editGen,
      s.points.map((p) => ({ ...p, y: p.y + 5000 })),
    );
    expect(containsStroke(s, 50, 50)).toBe(true);
    expect(containsStroke(s, 50, 5050)).toBe(false);
  });

  it("橡皮按显示位置命中变换后的笔画", () => {
    const { doc, id } = docWithLine();
    doc.transformStrokes([id], [1, 0, 0, 1, 0, 50]);
    const eraser = makeController(doc, { tool: "eraser", eraserRadiusPx: 10 });
    eraser.onPointerDown(down(2, sample(50, 0))); // 旧位置：不命中
    eraser.onPointerUp(up(2, sample(50, 0)));
    expect(doc.hasStroke(id)).toBe(true);
    eraser.onPointerDown(down(2, sample(50, 50))); // 新位置：命中
    eraser.onPointerUp(up(2, sample(50, 50)));
    expect(doc.hasStroke(id)).toBe(false);
    expect(doc.undo()).toBe(true); // 擦除撤销恢复笔画及变换
    expectMatrix(doc.getStroke(id)!.transform!, [1, 0, 0, 1, 0, 50]);
  });
});

describe("导出与渲染还原屏幕结果", () => {
  it("导出含每笔 transform（无变换为单位矩阵），采样保持局部坐标与压力时间", () => {
    const doc = new Document();
    const input = pts(4);
    const a = doc.commitStroke(input, STYLE)!;
    const b = doc.commitStroke(pts(2), STYLE)!;
    doc.transformStrokes([a.id], compose(SCALE_XY, ROT90));

    const parsed = JSON.parse(exportDocument(doc));
    const ea = parsed.strokes.find((s: { id: string }) => s.id === a.id);
    const eb = parsed.strokes.find((s: { id: string }) => s.id === b.id);
    expectMatrix(ea.transform, compose(SCALE_XY, ROT90));
    expectMatrix(eb.transform, [1, 0, 0, 1, 0, 0]);
    expect(ea.points).toEqual(JSON.parse(JSON.stringify(input))); // 压力/时间可追溯
    // 局部采样 × transform = 屏幕（世界）结果
    const world = applyToPoint(ea.transform, input[2].x, input[2].y);
    const seq = applyToPoint(SCALE_XY, ...(() => {
      const p = applyToPoint(ROT90, input[2].x, input[2].y);
      return [p.x, p.y] as const;
    })());
    expect(world.x).toBeCloseTo(seq.x, 10);
    expect(world.y).toBeCloseTo(seq.y, 10);
  });

  it("渲染把「视图 × 笔画矩阵」合成进画布变换，笔尖轮廓随矩阵变形", () => {
    const doc = new Document();
    const s = doc.commitStroke(pts(3), STYLE)!;
    doc.transformStrokes([s.id], [2, 0, 0, 1, 10, 20]);

    const transforms: number[][] = [];
    const moveToCalls: number[][] = [];
    const widths: number[] = [];
    const ctx: CtxLike = {
      setTransform: (a, b, c, d, e, f) => {
        transforms.push([a, b, c, d, e, f]);
      },
      clearRect: () => {},
      save: () => {},
      restore: () => {},
      translate: () => {},
      scale: () => {},
      beginPath: () => {},
      moveTo: (x, y) => {
        moveToCalls.push([x, y]);
      },
      lineTo: () => {},
      stroke: () => {},
      lineCap: "",
      lineJoin: "",
      strokeStyle: "",
      set lineWidth(v: number) {
        widths.push(v);
      },
      get lineWidth() {
        return 0;
      },
      globalAlpha: 1,
    };
    renderScene(ctx, {
      width: 800,
      height: 600,
      dpr: 1,
      view: { scale: 2, tx: 5, ty: 7 },
      strokes: doc.getStrokes(),
      active: null,
      preview: null,
      activeStyle: STYLE,
    });
    // 视图(scale 2, tx 5, ty 7) × 笔画矩阵(2,0,0,1,10,20)
    expectMatrix(transforms.at(-1)!, [4, 0, 0, 2, 25, 47]);
    // 画的是局部坐标采样，变形由画布变换承担（笔尖随之变形）
    expect(moveToCalls[0]).toEqual([0, 0]);
    expect(widths[0]).toBeCloseTo(2, 10); // 局部线宽：baseWidth 4 × pressure .5
  });
});

describe("变换与平滑代次", () => {
  it("变换推进 editGen：途中旧平滑结果被拒，已有缓存保留且仍有效", () => {
    const doc = new Document();
    const s = doc.commitStroke(pts(5), STYLE)!;
    const genBefore = doc.editGen;
    doc.transformStrokes([s.id], ROT90);
    expect(doc.editGen).toBe(genBefore + 1);
    // 变换前发出的平滑结果（旧代次）不能覆盖新编辑
    expect(doc.applySmoothed(s.id, genBefore, pts(5))).toBe(false);
    expect(s.smoothed).toBeNull();
    // 新代次的结果可应用；缓存是局部坐标，变换后渲染仍正确
    expect(doc.applySmoothed(s.id, doc.editGen, pts(5))).toBe(true);
    expect(s.smoothed).not.toBeNull();
    const cache = s.smoothed;
    doc.transformStrokes([s.id], SHEAR); // 再次变换不清空有效缓存
    expect(doc.getStroke(s.id)!.smoothed).toBe(cache);
  });
});
