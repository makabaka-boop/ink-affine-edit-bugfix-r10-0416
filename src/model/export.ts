import type { Document } from "./document";

/**
 * 导出文档：只包含保存的原始采样。
 * 预测点从未进入文档，平滑缓存也不导出 —— 导出结果即保存的采样本身。
 */
export function exportDocument(doc: Document): string {
  return JSON.stringify({
    version: 1,
    editGen: doc.editGen,
    strokes: doc.getStrokes().map((s) => ({
      id: s.id,
      color: s.style.color,
      baseWidth: s.style.baseWidth,
      points: s.points,
    })),
  });
}
