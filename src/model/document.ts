import {
  compose,
  identity,
  isIdentity,
  matrix,
  type Matrix,
} from "./affine";
import type { Sample, Stroke, StrokeStyle } from "./types";

/** 单份文档采样点上限。 */
export const MAX_DOCUMENT_POINTS = 20000;

export type EditOp =
  | { type: "add"; strokeId: string }
  | { type: "erase"; entries: { stroke: Stroke; index: number }[] }
  | {
      type: "transform";
      entries: { strokeId: string; before: Matrix | undefined }[];
    };

/**
 * 文档模型：笔画集合 + 撤销栈 + 编辑代次。
 *
 * - editGen 在每次可撤销编辑（提交笔画、结束一次擦除、笔画变换、撤销）时递增；
 *   Worker 平滑结果携带 (strokeId, gen)，仅当 gen 与当前 editGen 一致
 *   且笔画仍存在时才被接受，旧结果无法覆盖新编辑或复活已擦除的笔画。
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
   * 对一组选中笔画施加同一仿射矩阵：新矩阵在世界坐标中左乘每笔已有矩阵，
   * 原始采样/压力/时间不动（始终留在笔画局部坐标）。
   *
   * 原子性保证 —— 以下任一情况都拒绝整次编辑，不留下任何部分变化：
   * - 空选择：不是编辑，不进撤销栈、不推进代次，返回 false；
   * - 选择含重复 id 或已不存在的笔画（失效选择）；
   * - 输入矩阵非法，或与某笔已有矩阵合成后越界/奇异。
   * 全部校验与合成结果先算好后才统一写入，一次合法变换 = 一次完整编辑。
   *
   * @returns 是否实际产生了编辑。
   */
  transformStrokes(ids: string[], value: unknown): boolean {
    if (ids.length === 0) return false;
    if (new Set(ids).size !== ids.length)
      throw new Error("duplicate stroke in selection");

    const m = matrix(value); // 输入矩阵非法时在任何写入前抛出
    const targets: { stroke: Stroke; next: Matrix | undefined }[] = [];
    for (const id of ids) {
      const stroke = this.getStroke(id);
      if (!stroke) throw new Error("unknown stroke in selection");
      const current = stroke.transform;
      // 新矩阵左乘已有矩阵；合成后的矩阵仍需通过系数/行列式约束
      const next = compose(m, current ?? identity());
      targets.push({ stroke, next: isIdentity(next) ? undefined : next });
    }

    // 校验全部通过后才写入：失败不可能只改到部分笔画
    const entries: { strokeId: string; before: Matrix | undefined }[] = [];
    for (const { stroke, next } of targets) {
      entries.push({
        strokeId: stroke.id,
        before: stroke.transform ? [...stroke.transform] : undefined,
      });
      stroke.transform = next;
    }
    this.editGen++;
    this.undoStack.push({ type: "transform", entries });
    this.emit();
    return true;
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
      // 恢复每笔变换前的确切矩阵（含“原本无变换”这一状态）
      for (const entry of op.entries) {
        const s = this.getStroke(entry.strokeId);
        if (s) s.transform = entry.before ? [...entry.before] : undefined;
      }
    } else {
      // 按删除的逆序、以删除时记录的下标插回，恢复原有相对顺序与变换。
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
   * 时丢弃；只写 smoothed 缓存，绝不触碰保存的采样 points。过期结果因此
   * 无法覆盖变换/撤销之后的新编辑。
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
