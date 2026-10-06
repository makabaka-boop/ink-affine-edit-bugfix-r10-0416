import { identity } from "./affine";
import type { Document } from "./document";

/**
 * 导出文档：保存的原始采样（笔画局部坐标，含压力与时间）+ 每笔的仿射矩阵。
 * 预测点从未进入文档，平滑缓存也不导出 ——
 * 局部采样 × transform 即可还原屏幕上的显示结果。
 */
export function exportDocument(doc: Document): string {
  return JSON.stringify({
    version: 1,
    editGen: doc.editGen,
    strokes: doc.getStrokes().map((s) => ({
      id: s.id,
      color: s.style.color,
      baseWidth: s.style.baseWidth,
      transform: s.transform ? [...s.transform] : identity(),
      points: s.points,
    })),
  });
}
