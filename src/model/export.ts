import { identity } from "./affine";
import type { Document } from "./document";

/**
 * 导出文档：包含保存的原始采样（世界坐标的笔迹以局部坐标保存）与每笔的
 * 仿射矩阵。预测点从未进入文档；平滑缓存仅是渲染缓存，不导出。
 * 导入端对每笔先取 points 再施加 transform 即可还原屏幕结果：
 * 无变换的笔画导出单位矩阵 [1,0,0,1,0,0]。
 */
export function exportDocument(doc: Document): string {
  return JSON.stringify({
    version: 1,
    editGen: doc.editGen,
    strokes: doc.getStrokes().map((s) => ({
      id: s.id,
      color: s.style.color,
      baseWidth: s.style.baseWidth,
      transform: s.transform ?? identity(),
      points: s.points,
    })),
  });
}
