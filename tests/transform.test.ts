import { describe, expect, it } from "vitest";
import { Document } from "../src/model/document";
import {
  identityView,
  panBy,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from "../src/model/geometry";
import { renderScene, type CtxLike } from "../src/render/renderer";
import { down, makeController, move, sample, up } from "./helpers";

function mockCtx() {
  const moveToCalls: [number, number][] = [];
  const ctx: CtxLike = {
    setTransform: () => {},
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
    lineWidth: 0,
    globalAlpha: 1,
  };
  return { ctx, moveToCalls };
}

describe("坐标变换", () => {
  it("screenToWorld / worldToScreen 互逆", () => {
    const view = { scale: 2.5, tx: -30, ty: 40 };
    const w = screenToWorld(view, 117, -22);
    const s = worldToScreen(view, w.x, w.y);
    expect(s.x).toBeCloseTo(117, 10);
    expect(s.y).toBeCloseTo(-22, 10);
  });

  it("zoomAt 保持锚点下的世界坐标不动", () => {
    const view = { scale: 1, tx: 10, ty: 20 };
    const before = screenToWorld(view, 200, 150);
    const zoomed = zoomAt(view, 200, 150, 1.5);
    const after = screenToWorld(zoomed, 200, 150);
    expect(zoomed.scale).toBeCloseTo(1.5, 10);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });

  it("缩放/平移下采样以世界坐标保存", () => {
    const doc = new Document();
    const view = { scale: 2, tx: 100, ty: 50 };
    const ctrl = makeController(doc, { view });
    ctrl.onPointerDown(down(1, sample(102, 54))); // → world (1, 2)
    ctrl.onPointerMove(move(1, [sample(112, 64)])); // → world (6, 7)
    ctrl.onPointerUp(up(1, sample(122, 74))); // → world (11, 12)
    const pts = doc.getStrokes()[0].points;
    expect(pts.map((p) => [p.x, p.y])).toEqual([
      [1, 2],
      [6, 7],
      [11, 12],
    ]);
  });

  it("视图变化不改变已保存的采样", () => {
    const doc = new Document();
    const ctrl = makeController(doc);
    ctrl.onPointerDown(down(1, sample(10, 10)));
    ctrl.onPointerMove(move(1, [sample(20, 20)]));
    ctrl.onPointerUp(up(1, sample(30, 30)));
    const before = JSON.parse(JSON.stringify(doc.getStrokes()[0].points));

    // 缩放 + 平移视图，并用新视图重绘
    const view = panBy(zoomAt(identityView(), 15, 15, 2), 7, -3);
    const { ctx } = mockCtx();
    renderScene(ctx, {
      width: 800,
      height: 600,
      dpr: 2,
      view,
      strokes: doc.getStrokes(),
      active: null,
      preview: null,
      activeStyle: { color: "#000", baseWidth: 4 },
    });

    expect(doc.getStrokes()[0].points).toEqual(before);
  });

  it("重绘使用平滑缓存但不改写保存的采样", () => {
    const doc = new Document();
    const ctrl = makeController(doc);
    ctrl.onPointerDown(down(1, sample(0, 0)));
    ctrl.onPointerMove(move(1, [sample(10, 0), sample(20, 0)]));
    ctrl.onPointerUp(up(1, sample(30, 0)));

    const stroke = doc.getStrokes()[0];
    const savedBefore = JSON.parse(JSON.stringify(stroke.points));
    doc.applySmoothed(stroke.id, doc.editGen, [
      { x: 0, y: 0.5, pressure: 0.5, t: 0 },
      { x: 15, y: 0.5, pressure: 0.5, t: 1 },
      { x: 30, y: 0.5, pressure: 0.5, t: 2 },
    ]);

    const { ctx, moveToCalls } = mockCtx();
    renderScene(ctx, {
      width: 800,
      height: 600,
      dpr: 1,
      view: identityView(),
      strokes: doc.getStrokes(),
      active: null,
      preview: null,
      activeStyle: { color: "#000", baseWidth: 4 },
    });

    // 渲染走的是平滑缓存（y=0.5），保存的采样原封不动
    expect(moveToCalls[0][1]).toBeCloseTo(0.5, 10);
    expect(doc.getStrokes()[0].points).toEqual(savedBefore);
  });
});
