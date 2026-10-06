import {
  PointerInputController,
  type PointerEventData,
  type RawSample,
  type Tool,
} from "../src/input/pointerInput";
import { Document } from "../src/model/document";
import { identityView, type ViewTransform } from "../src/model/geometry";
import type { StrokeStyle } from "../src/model/types";

export type { RawSample } from "../src/input/pointerInput";

let clock = 0;

/** 生成屏幕坐标原始采样；t 单调递增。 */
export function sample(x: number, y: number, pressure = 0.5): RawSample {
  return { x, y, pressure, t: ++clock };
}

export function down(
  pointerId: number,
  s: RawSample,
  pointerType = "pen",
): PointerEventData {
  return {
    pointerId,
    pointerType,
    button: 0,
    x: s.x,
    y: s.y,
    pressure: s.pressure,
    t: s.t,
    coalesced: [],
    predicted: [],
  };
}

/** move 事件：coalesced 非空时事件自身字段取最后一个合并点（与浏览器一致）。 */
export function move(
  pointerId: number,
  coalesced: RawSample[],
  predicted: RawSample[] = [],
): PointerEventData {
  const last = coalesced[coalesced.length - 1] ?? {
    x: 0,
    y: 0,
    pressure: 0,
    t: 0,
  };
  return {
    pointerId,
    pointerType: "pen",
    button: 0,
    x: last.x,
    y: last.y,
    pressure: last.pressure,
    t: last.t,
    coalesced,
    predicted,
  };
}

export function up(pointerId: number, s: RawSample): PointerEventData {
  return {
    pointerId,
    pointerType: "pen",
    button: 0,
    x: s.x,
    y: s.y,
    pressure: s.pressure,
    t: s.t,
    coalesced: [],
    predicted: [],
  };
}

export interface ControllerOptions {
  view?: ViewTransform;
  tool?: Tool;
  style?: StrokeStyle;
  eraserRadiusPx?: number;
}

export function makeController(
  doc: Document,
  opts: ControllerOptions = {},
): PointerInputController {
  const view = opts.view ?? identityView();
  return new PointerInputController(doc, {
    getView: () => view,
    getTool: () => opts.tool ?? "pen",
    getStyle: () => opts.style ?? { color: "#000", baseWidth: 4 },
    eraserRadiusPx: opts.eraserRadiusPx ?? 10,
    onStateChange: () => {},
  });
}

/** 用同一组输入采样画一笔：down 用 inputs[0]，up 用 inputs[N-1]，中间按 batches 分批投递。 */
export function drawStrokeWithBatches(
  ctrl: PointerInputController,
  pointerId: number,
  inputs: RawSample[],
  batches: RawSample[][],
): void {
  ctrl.onPointerDown(down(pointerId, inputs[0]));
  for (const batch of batches) ctrl.onPointerMove(move(pointerId, batch));
  ctrl.onPointerUp(up(pointerId, inputs[inputs.length - 1]));
}

/** 便捷：identity 视图下画一条水平线笔画并提交。 */
export function drawLineStroke(
  doc: Document,
  y: number,
  x0 = 0,
  x1 = 100,
  step = 10,
): void {
  const ctrl = makeController(doc);
  const pts: RawSample[] = [];
  for (let x = x0; x <= x1; x += step) pts.push(sample(x, y));
  drawStrokeWithBatches(
    ctrl,
    1,
    pts,
    pts.slice(1, -1).map((p) => [p]),
  );
}
