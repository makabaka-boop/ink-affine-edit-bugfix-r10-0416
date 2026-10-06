import type {
  PointerEventData,
  PointerInputController,
  RawSample,
} from "./pointerInput";

/**
 * DOM 适配层：把 PointerEvent 转成 PointerEventData。
 * - getCoalescedEvents() 不可用（或返回空）时传空数组，控制器回退到事件自身；
 * - getPredictedEvents() 同理，缺失即无预测预览；
 * - pointerdown 时 setPointerCapture，并监听 lostpointercapture 以撤销未完成笔画。
 */
export function attachPointerInput(
  el: HTMLElement,
  ctrl: PointerInputController,
): () => void {
  const toData = (e: PointerEvent): PointerEventData => {
    const rect = el.getBoundingClientRect();
    const sampleOf = (ev: PointerEvent): RawSample => ({
      x: ev.clientX - rect.left,
      y: ev.clientY - rect.top,
      pressure: ev.pressure,
      t: ev.timeStamp,
    });
    const coalesced =
      typeof e.getCoalescedEvents === "function"
        ? e.getCoalescedEvents().map(sampleOf)
        : [];
    const getPredicted = (
      e as unknown as { getPredictedEvents?: () => PointerEvent[] }
    ).getPredictedEvents;
    const predicted =
      typeof getPredicted === "function"
        ? getPredicted.call(e).map(sampleOf)
        : [];
    return {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      button: e.button,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure: e.pressure,
      t: e.timeStamp,
      coalesced,
      predicted,
    };
  };

  const down = (e: PointerEvent) => {
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* 某些环境不支持捕获 */
    }
    ctrl.onPointerDown(toData(e));
    e.preventDefault();
  };
  const move = (e: PointerEvent) => ctrl.onPointerMove(toData(e));
  const up = (e: PointerEvent) => ctrl.onPointerUp(toData(e));
  const cancel = (e: PointerEvent) =>
    ctrl.onPointerCancel({ pointerId: e.pointerId });
  const lost = (e: PointerEvent) =>
    ctrl.onLostPointerCapture({ pointerId: e.pointerId });

  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("lostpointercapture", lost);

  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", cancel);
    el.removeEventListener("lostpointercapture", lost);
  };
}
