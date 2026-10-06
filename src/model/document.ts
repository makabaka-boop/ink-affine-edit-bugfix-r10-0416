import { compose, identity, matrix, type Matrix } from "./affine";
import type { Sample, Stroke, StrokeStyle } from "./types";

/** 单份文档采样点上限。 */
export const MAX_DOCUMENT_POINTS = 20000;

export type EditOp =
  | { type: "add"; strokeId: string }
  | { type: "erase"; entries: { stroke: Stroke; index: number }[] }
  | { type: "transform"; entries: { strokeId: string; before: Matrix }[] };

/**
 * 文档模型：笔画集合 + 撤销栈 + 编辑代次。
 *
 * - editGen 在每次可撤销编辑（提交笔画、结束一次擦除、变换、撤销）时递增；
 *   Worker 平滑结果携带 (strokeId, gen)，仅当 gen 与当前 editGen 一致
 *   且笔画仍存在时才被接受，旧结果无法复活已擦除的笔画。
 * - applySmoothed 不是可撤销编辑，不推进 editGen，也不改动保存的采样。
 */
export class Document {
  private strokes: Stroke[] = [];
  private undoStack: EditOp[] = [];
  private listeners = new Set<() => void>();
  private erasePass: { entries: { stroke: Stroke; index: number }[] } | null =
    null;
  private nextId = 1;

  editGen = 0;
  totalPoints = 0;

  getStrokes(): readonly Stroke[] {
    return this.strokes.slice();
  }

  getStroke(id: string): Stroke | undefined {
    return this.strokes.find((s) => s.id === id);
  }

  hasStroke(id: string): boolean {
    return this.strokes.some((s) => s.id === id);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  remainingPointBudget(): number {
    return MAX_DOCUMENT_POINTS - this.totalPoints;
  }

  onEdit(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  /** 抬笔后提交完整笔画。超出两万点上限的部分被截断；预算耗尽返回 null。 */
  commitStroke(points: Sample[], style: StrokeStyle): Stroke | null {
    const budget = this.remainingPointBudget();
    if (budget <= 0 || points.length === 0) return null;
    const pts =
      points.length > budget ? points.slice(0, budget) : points.slice();
    this.editGen++;
    const stroke: Stroke = {
      id: `stroke-${this.nextId++}`,
      points: pts,
      smoothed: null,
      gen: this.editGen,
      style: { ...style },
    };
    this.strokes.push(stroke);
    this.totalPoints += pts.length;
    this.undoStack.push({ type: "add", strokeId: stroke.id });
    this.emit();
    return stroke;
  }

  beginErasePass(): void {
    if (this.erasePass) throw new Error("erase pass already open");
    this.erasePass = { entries: [] };
  }

  /** 擦除过程中命中即整条删除；删除记录累积，endErasePass 合并为一个可撤销操作。 */
  eraseStroke(id: string): boolean {
    if (!this.erasePass) throw new Error("no open erase pass");
    const index = this.strokes.findIndex((s) => s.id === id);
    if (index < 0) return false;
    const [stroke] = this.strokes.splice(index, 1);
    this.totalPoints -= stroke.points.length;
    this.erasePass.entries.push({ stroke, index });
    this.emit();
    return true;
  }

  endErasePass(): void {
    const pass = this.erasePass;
    this.erasePass = null;
    if (!pass || pass.entries.length === 0) return;
    this.editGen++;
    this.undoStack.push({ type: "erase", entries: pass.entries });
    this.emit();
  }

  /** 便捷方法：一次擦除若干笔画，合并为一个可撤销操作。 */
  eraseStrokes(ids: string[]): void {
    this.beginErasePass();
    try {
      for (const id of ids) this.eraseStroke(id);
    } finally {
      this.endErasePass();
    }
  }

  /**
   * 对选中的一批笔画应用仿射变换（新矩阵在世界坐标中左乘已有矩阵）。
   * 整次编辑是原子的：先校验矩阵与全部选择（重复/不存在的 id 一并拒绝），
   * 全部通过后才落地；任何失败都不留下部分变化，空选择不产生编辑。
   * 合法时所有笔画一起更新，合并为一条撤销记录，并推进 editGen ——
   * 途中的旧平滑结果随之失效，不能覆盖这次新编辑。
   */
  transformStrokes(ids: string[], value: unknown): void {
    if (ids.length === 0) return; // 空选择不产生编辑
    const m = matrix(value); // 非法矩阵：拒绝整次编辑
    if (new Set(ids).size !== ids.length)
      throw new Error("duplicate stroke in selection");
    const targets: { stroke: Stroke; before: Matrix; after: Matrix }[] = [];
    for (const id of ids) {
      const s = this.getStroke(id);
      if (!s) throw new Error("unknown stroke"); // 不存在的 id：拒绝整次编辑
      const before = (s.transform ?? identity()).slice() as Matrix;
      targets.push({ stroke: s, before, after: compose(m, before) });
    }
    // 全部校验通过后才落地，绝不留下部分变化
    for (const t of targets) t.stroke.transform = t.after;
    this.editGen++;
    this.undoStack.push({
      type: "transform",
      entries: targets.map((t) => ({ strokeId: t.stroke.id, before: t.before })),
    });
    this.emit();
  }

  undo(): boolean {
    const op = this.undoStack.pop();
    if (!op) return false;
    if (op.type === "add") {
      const index = this.strokes.findIndex((s) => s.id === op.strokeId);
      if (index >= 0) {
        const [stroke] = this.strokes.splice(index, 1);
        this.totalPoints -= stroke.points.length;
      }
    } else if (op.type === "transform") {
      for (const entry of op.entries) {
        const s = this.getStroke(entry.strokeId);
        if (s) s.transform = entry.before;
      }
    } else {
      // 按删除的逆序、以删除时记录的下标插回，恢复原有相对顺序。
      for (const e of [...op.entries].reverse()) {
        const at = Math.min(e.index, this.strokes.length);
        this.strokes.splice(at, 0, e.stroke);
        this.totalPoints += e.stroke.points.length;
      }
    }
    this.editGen++;
    this.emit();
    return true;
  }

  /**
   * 接收 Worker 平滑结果。代次不符（文档已编辑）或笔画已不存在（已擦除）
   * 时丢弃；只写 smoothed 缓存，绝不触碰保存的采样 points。
   */
  applySmoothed(strokeId: string, gen: number, points: Sample[]): boolean {
    if (gen !== this.editGen) return false;
    const stroke = this.getStroke(strokeId);
    if (!stroke) return false;
    stroke.smoothed = points;
    this.emit();
    return true;
  }
}
