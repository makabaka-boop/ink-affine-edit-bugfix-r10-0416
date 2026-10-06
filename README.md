# 本地笔迹页（React + Canvas + Worker）

支持压感笔、缩放和平移的本地手写画板。单份文档最多 20000 采样点。

## 运行

```bash
npm install
npm run dev      # 开发
npm test         # 测试（vitest，34 个用例）
npm run build    # 类型检查 + 生产构建
```

## 架构

| 模块 | 职责 |
| --- | --- |
| `src/model/document.ts` | 笔画集合、撤销栈、编辑代次 `editGen`、两万点上限 |
| `src/model/geometry.ts` | 视图变换（缩放/平移）、橡皮命中判定 |
| `src/input/pointerInput.ts` | 指针状态机：合并事件、预测点、提交/撤销笔画 |
| `src/input/domAdapter.ts` | PointerEvent → 输入层，`setPointerCapture` |
| `src/smoothing/*` | Worker 平滑；结果按 `(strokeId, gen)` 验收 |
| `src/render/renderer.ts` | 只读渲染，绝不改写保存的采样 |
| `src/ui/CanvasBoard.tsx` | React 组件：工具栏、滚轮缩放、平移、导出 |

## 关键约束

- **合并事件**：`getCoalescedEvents()` 的每个点都进入当前笔画；不支持时回退到事件自身。
- **预测点**：`getPredictedEvents()` 只进临时预览缓冲，不进入保存、擦除判断与导出。
- **压力与坐标绑定笔画**：采样带 `pointerId`，非活动指针的输入被忽略。
- **抬笔提交**：`pointerup` 提交完整笔画；`pointercancel` / `lostpointercapture` 丢弃未完成笔画（正常抬笔后的 `lostpointercapture` 不会误伤）。
- **橡皮**：命中即删整条笔画；一次擦除经过的所有删除合并为一个可撤销操作。
- **平滑代次**：Worker 结果携带 `(strokeId, gen)`，仅当代次匹配且笔画存在时应用——旧结果不能复活已擦除的笔画；平滑只写渲染缓存，不改保存的采样。
- **重绘纯度**：渲染只读文档；采样以世界坐标保存，视图变换不影响已存数据。

## 测试覆盖（`tests/`）

- `batching.test.ts`：同一输入在逐点/整批/不规则分批下笔画结果一致；合并事件为空时回退。
- `prediction.test.ts`：预测点仅预览，不进保存/擦除/导出；无预测能力的事件源正常回退。
- `transform.test.ts`：坐标变换互逆、锚点缩放、世界坐标保存、重绘不改写采样。
- `eraseUndo.test.ts`：一次擦除多条笔画合并为单个撤销操作、命中半径、撤销顺序。
- `cancel.test.ts`：取消/失去捕获回退、第二指针忽略。
- `smoothing.test.ts`：代次验收、擦除后旧结果不复活、撤销后按新代次重新平滑。
- `document.test.ts`：两万点上限截断、撤销释放预算、导出内容、代次推进规则。


## 笔画仿射编辑
全选或用选择工具点选笔画，输入 Canvas 顺序 [a,b,c,d,e,f] 的矩阵后变换。新矩阵在世界坐标中左乘已有矩阵，笔尖形状也随同变换。原始点、压力和时间保留在笔画局部坐标；平滑缓存不写入导出。导出含每笔 transform（无变换为单位矩阵）。每次非空选择产生一次撤销记录。矩阵必须有限、系数绝对值不超过 10000、行列式绝对值至少 1e-8；无效、重复或不存在的选择拒绝整次编辑，空选择不产生编辑。选择命中采用原始采样的压力笔迹，不随显示平滑变化。
