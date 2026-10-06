/** 一个采样点：世界坐标（与视图缩放/平移无关），压力 0..1，时间戳 ms。 */
export interface Sample {
  x: number;
  y: number;
  pressure: number;
  t: number;
}

export interface StrokeStyle {
  color: string;
  /** 压力为 1 时的线宽（世界单位）。 */
  baseWidth: number;
}

export interface Stroke {
  id: string;
  /** 保存的原始采样，提交后不可变；渲染/平滑都不得改写它。 */
  points: Sample[];
  /** Worker 平滑结果，仅作渲染缓存；与 points 分开存放，永不回写。 */
  smoothed: Sample[] | null;
  /** 提交时文档的编辑代次。 */
  gen: number;
  style: StrokeStyle;
  transform?: [number, number, number, number, number, number];
}
