import type { Sample } from "../model/types";

/**
 * 纯函数平滑：端点保留，中间点做 (1-2-1)/4 加权，压力同步平滑。
 * 不修改输入，返回新数组；输出仅作渲染缓存，不回写保存的采样。
 */
export function smoothPoints(points: readonly Sample[]): Sample[] {
  if (points.length < 3) return points.slice();
  const out: Sample[] = [{ ...points[0] }];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    out.push({
      x: (a.x + 2 * b.x + c.x) / 4,
      y: (a.y + 2 * b.y + c.y) / 4,
      pressure: (a.pressure + 2 * b.pressure + c.pressure) / 4,
      t: b.t,
    });
  }
  out.push({ ...points[points.length - 1] });
  return out;
}
