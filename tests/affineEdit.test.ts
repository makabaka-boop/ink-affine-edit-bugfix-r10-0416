import { describe, expect, it } from "vitest";
import { Document } from "../src/model/document";
import {
  applyMatrix,
  axisScales,
  compose,
  containsStroke,
  hitEraseStroke,
  identity,
  invert,
  isIdentity,
  matrix,
} from "../src/model/affine";
import {
  identityView,
  screenToWorld,
  worldToScreen,
} from "../src/model/geometry";
import { exportDocument } from "../src/model/export";
import { renderScene, type CtxLike } from "../src/render/renderer";
import type { Sample } from "../src/model/types";
import { SmoothingManager, type WorkerLike } from "../src/smoothing/manager";
import { smoothPoints } from "../src/smoothing/smooth";
import type { SmoothRequest, SmoothResponse } from "../src/smoothing/messages";
import { down, drawLineStroke, makeController, sample, up } from "./helpers";

const STYLE = { color: "#000", baseWidth: 4 };
const translate = (x: number, y: number) =>
  [1, 0, 0, 1, x, y] as [number, number, number, number, number, number];
const scale = (sx: number, sy: number) =>
  [sx, 0, 0, sy, 0, 0] as [number, number, number, number, number, number];
// 逆时针 90°：(x,y) → (-y,x)
const rot90: [number, number, number, number, number, number] = [
  0, 1, -1, 0, 0, 0,
];

function strokePts(): Sample[] {
  return [
    { x: 0, y: 0, pressure: 0.5, t: 1 },
    { x: 10, y: 0, pressure: 0.7, t: 2 },
    { x: 20, y: 0, pressure: 0.9, t: 3 },
  ];
}

function mockCtx() {
  const moveToCalls: [number, number][] = [];
  const transforms: number[][] = [];
  const lineWidths: number[] = [];
  const strokeStyles: unknown[] = [];
  const ctx: CtxLike = {
    setTransform: () => {},
    clearRect: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
    transform: (...args: number[]) => transforms.push(args),
    beginPath: () => {},
    moveTo: (x, y) => moveToCalls.push([x, y]),
    lineTo: () => {},
    stroke: () => {},
    lineCap: "",
    lineJoin: "",
    set strokeStyle(v: unknown) {
      strokeStyles.push(v);
    },
    get strokeStyle() {
      return "";
    },
    set lineWidth(v: number) {
      lineWidths.push(v);
    },
    get lineWidth() {
      return 0;
    },
    globalAlpha: 1,
  };
  return { ctx, moveToCalls, transforms, lineWidths, strokeStyles };
}

describe("仿射矩阵合成", () => {
  it("compose 是真正的矩阵乘法（旧的逐元素实现会得到奇异结果）", () => {
    // R(90°) ∘ T(10,0)：原点先平移再旋转 → (0,10)
    const m = compose(rot90, translate(10, 0));
    const p = applyMatrix(m, 0, 0);
    expect(p.x).toBeCloseTo(0, 10);
    expect(p.y).toBeCloseTo(10, 10);
    const q = applyMatrix(m, 1, 0);
    expect(q.x).toBeCloseTo(0, 10);
    expect(q.y).toBeCloseTo(11, 10);
  });

  it("逆矩阵互逆，且逆系数不受 1e4 上限影响", () => {
    const m = matrix([0.0001, 0, 0, 0.0001, 5000, -5000]);
    const back = compose(m, invert(m));
    expect(back.slice(0, 4).map((v) => Math.round(v))).toEqual([1, 0, 0, 1]);
    expect(back[4]).toBeCloseTo(0, 6);
    expect(back[5]).toBeCloseTo(0, 6);
  });

  it("axisScales 在旋转/均匀缩放时相等，非等比缩放给出最小最大比", () => {
    expect(axisScales(rot90)).toEqual({ min: 1, max: 1 });
    expect(axisScales(scale(2, 3)).min).toBeCloseTo(2, 10);
    expect(axisScales(scale(2, 3)).max).toBeCloseTo(3, 10);
    expect(isIdentity(identity())).toBe(true);
  });
});

describe("连续变换：形状与执行顺序", () => {
  it("新矩阵在世界坐标左乘已有矩阵，平移后再缩放结果正确", () => {
    const doc = new Document();
    const s = doc.commitStroke(strokePts(), STYLE)!;
    doc.transformStrokes([s.id], translate(10, 0));
    doc.transformStrokes([s.id], scale(2, 2));
    const m = doc.getStroke(s.id)!.transform!;
    // (0,0) 先平移到 (10,0)，再放大到 (20,0)
    expect(applyMatrix(m, 0, 0)).toEqual({ x: 20, y: 0 });
    expect(applyMatrix(m, 5, 0)).toEqual({ x: 30, y: 0 });
  });

  it("旋转、错切、缩放连续施加可按顺序还原到单位矩阵", () => {
    const doc = new Document();
    const s = doc.commitStroke(strokePts(), STYLE)!;
    doc.transformStrokes([s.id], rot90); // 旋转
    doc.transformStrokes([s.id], [1, 0.5, 0, 1, 0, 0]); // x 方向错切
    doc.transformStrokes([s.id], scale(2, 0.5)); // 非等比缩放
    expect(doc.getStroke(s.id)!.transform).toBeDefined();
    // 三个变换合成后的整体矩阵可直接求逆；左乘其逆严格回到单位矩阵
    const cur = doc.getStroke(s.id)!.transform!;
    doc.transformStrokes([s.id], invert(cur));
    expect(doc.getStroke(s.id)!.transform).toBeUndefined();
    // 每次合法变换一次撤销，共 4 条；原始采样全程未变
    expect(doc.undoDepth).toBe(5); // 1 次添加 + 4 次变换
    expect(doc.getStroke(s.id)!.points).toEqual(strokePts());
  });

  it("原始坐标、压力、时间始终保留在局部坐标", () => {
    const doc = new Document();
    const s = doc.commitStroke(strokePts(), STYLE)!;
    doc.transformStrokes([s.id], rot90);
    doc.transformStrokes([s.id], scale(3, 3));
    const saved = doc.getStroke(s.id)!.points;
    expect(saved.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
    expect(saved.map((p) => p.pressure)).toEqual([0.5, 0.7, 0.9]);
    expect(saved.map((p) => p.t)).toEqual([1, 2, 3]);
  });
});

describe("变换编辑的原子性与拒绝规则", () => {
  it("空选择不产生编辑：不入栈、不推进代次、不触发监听", () => {
    const doc = new Document();
    doc.commitStroke(strokePts(), STYLE);
    const depth = doc.undoDepth;
    const gen = doc.editGen;
    let events = 0;
    const off = doc.onEdit(() => events++);
    expect(doc.transformStrokes([], translate(5, 5))).toBe(false);
    expect(doc.undoDepth).toBe(depth);
    expect(doc.editGen).toBe(gen);
    expect(events).toBe(0);
    off();
  });

  it("失效对象：选择中任一不存在，整次拒绝，其他笔画不变", () => {
    const doc = new Document();
    const a = doc.commitStroke(strokePts(), STYLE)!;
    const b = doc.commitStroke(strokePts(), STYLE)!;
    const depth = doc.undoDepth;
    expect(() => doc.transformStrokes([a.id, "missing"], translate(5, 0))).toThrow(
      /unknown/,
    );
    expect(doc.getStroke(a.id)!.transform).toBeUndefined();
    expect(doc.getStroke(b.id)!.transform).toBeUndefined();
    expect(doc.undoDepth).toBe(depth);
  });

  it("重复 id 拒绝整次编辑", () => {
    const doc = new Document();
    const a = doc.commitStroke(strokePts(), STYLE)!;
    expect(() => doc.transformStrokes([a.id, a.id], translate(1, 0))).toThrow(
      /duplicate/,
    );
    expect(doc.getStroke(a.id)!.transform).toBeUndefined();
  });

  it("非法矩阵（NaN/奇异/越界）拒绝整次编辑", () => {
    const doc = new Document();
    const a = doc.commitStroke(strokePts(), STYLE)!;
    const b = doc.commitStroke(strokePts(), STYLE)!;
    for (const bad of [
      [1, 0, 0, 1, NaN, 0],
      [0, 0, 0, 0, 0, 0],
      [1, 0, 0, 1, 10001, 0],
      "nope",
      [1, 0, 0, 1],
    ]) {
      expect(() => doc.transformStrokes([a.id, b.id], bad)).toThrow();
    }
    expect(doc.getStroke(a.id)!.transform).toBeUndefined();
    expect(doc.getStroke(b.id)!.transform).toBeUndefined();
  });

  it("合成后越界也拒绝，且不会先改掉一部分笔画", () => {
    const doc = new Document();
    const a = doc.commitStroke(strokePts(), STYLE)!;
    const b = doc.commitStroke(strokePts(), STYLE)!;
    doc.transformStrokes([a.id], translate(8000, 0)); // 合法
    // a 再平移 3000 → e=11000 越界；b 本身合法也不得被改
    expect(() =>
      doc.transformStrokes([a.id, b.id], translate(3000, 0)),
    ).toThrow(/invalid/);
    expect(doc.getStroke(a.id)!.transform).toEqual(translate(8000, 0));
    expect(doc.getStroke(b.id)!.transform).toBeUndefined();
  });
});

describe("变换撤销与擦除撤销", () => {
  it("撤销变换恢复确切的先前矩阵（包括“原本无变换”）", () => {
    const doc = new Document();
    const s = doc.commitStroke(strokePts(), STYLE)!;
    doc.transformStrokes([s.id], translate(10, 0));
    doc.transformStrokes([s.id], scale(2, 2));
    expect(doc.getStroke(s.id)!.transform![4]).toBe(20);
    doc.undo();
    expect(doc.getStroke(s.id)!.transform).toEqual(translate(10, 0));
    doc.undo();
    expect(doc.getStroke(s.id)!.transform).toBeUndefined();
  });

  it("擦除撤销连同变换一起恢复；再撤销变换恢复无变换状态", () => {
    const doc = new Document();
    drawLineStroke(doc, 0);
    const id = doc.getStrokes()[0].id;
    doc.transformStrokes([id], translate(0, 100));
    doc.eraseStrokes([id]);
    expect(doc.hasStroke(id)).toBe(false);
    doc.undo(); // 撤销擦除：笔画与变换都回来
    const restored = doc.getStroke(id)!;
    expect(restored.transform).toEqual(translate(0, 100));
    doc.undo(); // 撤销变换
    expect(doc.getStroke(id)!.transform).toBeUndefined();
    // 原始采样仍可追溯
    expect(doc.getStroke(id)!.points.length).toBeGreaterThan(0);
  });
});

describe("显示：笔尖轮廓随变换变形", () => {
  it("渲染通过 CTM 施加变换，移动到的是局部坐标，线宽在 CTM 内变形", () => {
    const doc = new Document();
    const s = doc.commitStroke(strokePts(), STYLE)!;
    doc.transformStrokes([s.id], [2, 0.3, 0.1, 0.5, 7, -9]);
    const { ctx, moveToCalls, transforms } = mockCtx();
    renderScene(ctx, {
      width: 800,
      height: 600,
      dpr: 1,
      view: identityView(),
      strokes: doc.getStrokes(),
      active: null,
      preview: null,
      activeStyle: STYLE,
    });
    expect(transforms).toContainEqual([2, 0.3, 0.1, 0.5, 7, -9]);
    // 中心不再由 JS 预映射；moveTo 是局部原始坐标，变换交给 canvas
    expect(moveToCalls.slice(0, 2)).toEqual([
      [0, 0],
      [10, 0],
    ]);
  });

  it("选中高亮在同一变换内绘制并随笔迹变形，且高亮宽于笔迹", () => {
    const doc = new Document();
    const s = doc.commitStroke(strokePts(), STYLE)!;
    doc.transformStrokes([s.id], scale(2, 3));
    const { ctx, lineWidths, strokeStyles } = mockCtx();
    renderScene(ctx, {
      width: 800,
      height: 600,
      dpr: 1,
      view: identityView(),
      strokes: doc.getStrokes(),
      active: null,
      preview: null,
      activeStyle: STYLE,
      selectedIds: new Set([s.id]),
    });
    // 三点笔画：高亮宽度按段 (0,1) 与 (1,2) 顺序记录
    // widthAt(.5,.7)=2.4、widthAt(.7,.9)=3.2；高亮各加 6
    expect(lineWidths[0]).toBeCloseTo(8.4, 10);
    expect(lineWidths[1]).toBeCloseTo(9.2, 10);
    expect(strokeStyles).toContain("#2f81f7");
    expect(lineWidths).toContain(2.4);
  });
});

describe("选择/橡皮命中与变换后的轮廓一致", () => {
  it("平移后：命中新位置，旧位置不再命中", () => {
    const doc = new Document();
    const s = doc.commitStroke(strokePts(), STYLE)!;
    doc.transformStrokes([s.id], translate(0, 100));
    const stroke = doc.getStroke(s.id)!;
    expect(containsStroke(stroke, 10, 100)).toBe(true);
    expect(containsStroke(stroke, 10, 0)).toBe(false);
  });

  it("旋转 90° 后水平线变成垂直线：命中竖向轮廓", () => {
    const doc = new Document();
    const s = doc.commitStroke(strokePts(), STYLE)!;
    doc.transformStrokes([s.id], rot90);
    const stroke = doc.getStroke(s.id)!;
    expect(containsStroke(stroke, 0, 10)).toBe(true);
    expect(containsStroke(stroke, 10, 0)).toBe(false);
  });

  it("非等比缩放后命中区域按轮廓伸缩", () => {
    const doc = new Document();
    const s = doc.commitStroke(strokePts(), STYLE)!;
    doc.transformStrokes([s.id], scale(2, 4));
    const stroke = doc.getStroke(s.id)!;
    // 线宽 2（压力 .5）：y 方向半径 4，x 方向半径 1
    expect(containsStroke(stroke, 20, 3)).toBe(true);
    expect(containsStroke(stroke, 20, 8)).toBe(false);
    // (44,0) 逆变换为局部 (22,0)：超出 0..20 的线段范围，最近点 (20,0) 距离 2 > 段半宽
    expect(containsStroke(stroke, 44, 0)).toBe(false);
    expect(containsStroke(stroke, 42, 0)).toBe(true); // 最近点 (20,0) 距离 1
  });

  it("视图缩放/平移与变换叠加时，屏幕点击仍命中变换后的笔迹", () => {
    const doc = new Document();
    const s = doc.commitStroke(strokePts(), STYLE)!;
    doc.transformStrokes([s.id], translate(0, 100));
    const view = { scale: 2, tx: 30, ty: -10 };
    // 世界点 (10,100) 的屏幕位置
    const screen = worldToScreen(view, 10, 100);
    const world = screenToWorld(view, screen.x, screen.y);
    expect(containsStroke(doc.getStroke(s.id)!, world.x, world.y)).toBe(true);
  });

  it("橡皮在变换后的世界位置擦除，旧位置擦不到", () => {
    const doc = new Document();
    drawLineStroke(doc, 0);
    const id = doc.getStrokes()[0].id;
    doc.transformStrokes([id], translate(0, 100));

    const miss = makeController(doc, { tool: "eraser", eraserRadiusPx: 10 });
    miss.onPointerDown(down(2, sample(50, 0)));
    miss.onPointerUp(up(2, sample(50, 0)));
    expect(doc.hasStroke(id)).toBe(true);

    const hit = makeController(doc, { tool: "eraser", eraserRadiusPx: 10 });
    hit.onPointerDown(down(3, sample(50, 100)));
    hit.onPointerUp(up(3, sample(50, 100)));
    expect(doc.hasStroke(id)).toBe(false);
  });

  it("旋转后橡皮按变换轮廓命中，hitEraseStroke 的伸缩界正确", () => {
    const doc = new Document();
    const s = doc.commitStroke(strokePts(), STYLE)!;
    doc.transformStrokes([s.id], scale(2, 3));
    const stroke = doc.getStroke(s.id)!;
    // 世界坐标点 (20,0)：x 方向半宽 1、y 方向半宽 3
    expect(hitEraseStroke(stroke, 20, 3, 0)).toBe(true);
    expect(hitEraseStroke(stroke, 20, 5, 0)).toBe(false);
  });
});

describe("导出可还原屏幕结果", () => {
  it("每笔导出 transform（无变换为单位矩阵），点仍为局部原始采样", () => {
    const doc = new Document();
    const a = doc.commitStroke(strokePts(), STYLE)!;
    const b = doc.commitStroke(strokePts(), STYLE)!;
    doc.transformStrokes([a.id], translate(5, 9));
    doc.applySmoothed(a.id, doc.editGen, smoothPoints(strokePts())); // 不导出
    const parsed = JSON.parse(exportDocument(doc));
    expect(parsed.strokes[0].transform).toEqual([1, 0, 0, 1, 5, 9]);
    expect(parsed.strokes[1].transform).toEqual(identity());
    // 平滑缓存不在导出中；原始压力/时间在
    expect(parsed.strokes[0].points).toEqual(strokePts());
    expect(parsed.strokes[0].points[1].pressure).toBe(0.7);
    expect(parsed.strokes[0].points[1].t).toBe(2);
  });

  it("用导出的 transform 作用于导出点，可还原渲染的世界坐标", () => {
    const doc = new Document();
    const s = doc.commitStroke(strokePts(), STYLE)!;
    doc.transformStrokes([s.id], compose(scale(2, 2), translate(10, 0)));
    const parsed = JSON.parse(exportDocument(doc));
    const m = parsed.strokes[0].transform;
    const screenWorld = parsed.strokes[0].points.map((p: Sample) =>
      applyMatrix(m, p.x, p.y),
    );
    expect(screenWorld[0]).toEqual({ x: 20, y: 0 });
    expect(screenWorld[2]).toEqual({ x: 60, y: 0 });
  });
});

describe("过期平滑结果不能覆盖新编辑", () => {
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

  it("变换后途中到达的旧代次平滑结果被丢弃，按新代次重新平滑", () => {
    const doc = new Document();
    const worker = new FakeWorker();
    const mgr = new SmoothingManager(doc, worker);
    const s = doc.commitStroke(strokePts(), STYLE)!;
    doc.transformStrokes([s.id], translate(3, 4)); // gen 前进，旧请求过期
    const stale = worker.inbox[0];
    worker.inbox = [stale];
    worker.flush();
    expect(doc.getStroke(s.id)!.smoothed).toBeNull(); // 没有覆盖
    mgr.requestPending();
    expect(worker.inbox.at(-1)!.gen).toBe(doc.editGen);
    worker.flush();
    expect(doc.getStroke(s.id)!.smoothed).not.toBeNull();
    // 平滑只写缓存：局部原始采样与变换都不受影响
    expect(doc.getStroke(s.id)!.points).toEqual(strokePts());
    expect(doc.getStroke(s.id)!.transform).toEqual(translate(3, 4));
  });
});
