import type { SmoothRequest, SmoothResponse } from "./messages";
import { smoothPoints } from "./smooth";

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<SmoothRequest>) => void) | null;
  postMessage(msg: SmoothResponse): void;
};

scope.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "smooth") {
    // 原样回传 strokeId 与 gen，由主线程按代次验收
    scope.postMessage({
      type: "smoothed",
      strokeId: msg.strokeId,
      gen: msg.gen,
      points: smoothPoints(msg.points),
    });
  }
};
