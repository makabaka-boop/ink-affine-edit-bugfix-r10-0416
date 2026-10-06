import { useEffect, useRef, useState } from "react";
import { attachPointerInput } from "../input/domAdapter";
import { PointerInputController } from "../input/pointerInput";
import { containsStroke } from "../model/affine";
import { screenToWorld } from "../model/geometry";
import { Document, MAX_DOCUMENT_POINTS } from "../model/document";
import { exportDocument } from "../model/export";
import {
  identityView,
  panBy,
  zoomAt,
  type ViewTransform,
} from "../model/geometry";
import { renderScene } from "../render/renderer";
import { SmoothingManager } from "../smoothing/manager";

type ToolId = "pen" | "eraser" | "pan" | "select";

export function CanvasBoard() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [doc] = useState(() => new Document());
  const [tool, setTool] = useState<ToolId>("pen");
  const [selection, setSelection] = useState<string[]>([]);
  const [affineText, setAffineText] = useState("[1,0,0,1,0,0]");
  const [affineError, setAffineError] = useState("");
  const [color, setColor] = useState("#202020");
  const [baseWidth, setBaseWidth] = useState(4);
  const [pointCount, setPointCount] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [zoom, setZoom] = useState(1);

  const viewRef = useRef<ViewTransform>(identityView());
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const styleRef = useRef({ color, baseWidth });
  styleRef.current = { color, baseWidth };
  const renderRef = useRef<() => void>(() => {});

  const [ctrl] = useState(
    () =>
      new PointerInputController(doc, {
        getView: () => viewRef.current,
        getTool: () => (toolRef.current === "eraser" ? "eraser" : "pen"),
        getStyle: () => styleRef.current,
        eraserRadiusPx: 14,
        onStateChange: () => renderRef.current(),
      }),
  );

  // 渲染循环：文档/输入状态变化时重绘。重绘只读文档，不改变保存的采样。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const render = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (
          canvas.width !== Math.round(w * dpr) ||
          canvas.height !== Math.round(h * dpr)
        ) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        renderScene(ctx, {
          width: w,
          height: h,
          dpr,
          view: viewRef.current,
          strokes: doc.getStrokes(),
          active: ctrl.getActivePoints(),
          preview: ctrl.getPreviewPoints(),
          activeStyle: styleRef.current,
        });
      });
    };
    renderRef.current = render;
    render();
    const ro = new ResizeObserver(render);
    ro.observe(canvas);
    const unsub = doc.onEdit(() => {
      setPointCount(doc.totalPoints);
      setCanUndo(doc.canUndo);
      // 笔画被擦除/撤销后，选择中失效的 id 一并剔除
      setSelection((prev) => {
        const kept = prev.filter((id) => doc.hasStroke(id));
        return kept.length === prev.length ? prev : kept;
      });
      render();
    });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsub();
    };
  }, [doc, ctrl]);

  // 指针输入（笔/橡皮）；pan 工具下不挂载，由平移逻辑接管
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || tool === "pan" || tool === "select") return;
    return attachPointerInput(canvas, ctrl);
  }, [tool, ctrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || tool !== "select") return;
    const click = (e: MouseEvent) => {
      const box = canvas.getBoundingClientRect();
      const p = screenToWorld(
        viewRef.current,
        e.clientX - box.left,
        e.clientY - box.top,
      );
      setSelection(
        doc
          .getStrokes()
          .filter((s) => containsStroke(s, p.x, p.y))
          .map((s) => s.id),
      );
    };
    canvas.addEventListener("click", click);
    return () => canvas.removeEventListener("click", click);
  }, [tool, doc]);

  // 平移工具：拖拽视图
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || tool !== "pan") return;
    let last: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const move = (e: PointerEvent) => {
      if (!last) return;
      viewRef.current = panBy(
        viewRef.current,
        e.clientX - last.x,
        e.clientY - last.y,
      );
      last = { x: e.clientX, y: e.clientY };
      renderRef.current();
    };
    const up = () => {
      last = null;
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
    };
  }, [tool]);

  // 滚轮缩放（以光标为锚）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      viewRef.current = zoomAt(
        viewRef.current,
        e.clientX - rect.left,
        e.clientY - rect.top,
        Math.exp(-e.deltaY * 0.0015),
      );
      setZoom(viewRef.current.scale);
      renderRef.current();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // 平滑 Worker：结果按 (strokeId, gen) 验收，旧结果不会复活已擦除笔画
  useEffect(() => {
    const worker = new Worker(
      new URL("../smoothing/worker.ts", import.meta.url),
      { type: "module" },
    );
    const mgr = new SmoothingManager(doc, worker, () => renderRef.current());
    mgr.requestPending();
    return () => worker.terminate();
  }, [doc]);

  const zoomTo = (factor: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    viewRef.current = zoomAt(
      viewRef.current,
      canvas.clientWidth / 2,
      canvas.clientHeight / 2,
      factor,
    );
    setZoom(viewRef.current.scale);
    renderRef.current();
  };

  const resetView = () => {
    viewRef.current = identityView();
    setZoom(1);
    renderRef.current();
  };

  const doExport = () => {
    const blob = new Blob([exportDocument(doc)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ink-document.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="toolbar">
        <button onClick={() => setTool("select")}>选择笔画</button>
        <button onClick={() => setSelection(doc.getStrokes().map((s) => s.id))}>
          全选
        </button>
        <input
          aria-label="仿射矩阵"
          value={affineText}
          onChange={(e) => setAffineText(e.target.value)}
        />
        <button
          onClick={() => {
            try {
              doc.transformStrokes(selection, JSON.parse(affineText));
              setAffineError("");
            } catch (e) {
              setAffineError(String(e));
            }
          }}
        >
          变换选中笔画
        </button>
        <span aria-label="变换状态">
          已选 {selection.length} {affineError}
        </span>
        <button
          className={tool === "pen" ? "active" : ""}
          onClick={() => setTool("pen")}
        >
          ✒️ 笔
        </button>
        <button
          className={tool === "eraser" ? "active" : ""}
          onClick={() => setTool("eraser")}
        >
          🧽 橡皮
        </button>
        <button
          className={tool === "pan" ? "active" : ""}
          onClick={() => setTool("pan")}
        >
          ✋ 平移
        </button>
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          title="颜色"
        />
        <label>
          粗细
          <input
            type="range"
            min={1}
            max={16}
            step={0.5}
            value={baseWidth}
            onChange={(e) => setBaseWidth(Number(e.target.value))}
          />
        </label>
        <button onClick={() => doc.undo()} disabled={!canUndo}>
          ↩️ 撤销
        </button>
        <button onClick={() => zoomTo(1.25)}>＋</button>
        <button onClick={() => zoomTo(0.8)}>－</button>
        <button onClick={resetView} title="重置视图">
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={doExport}>导出</button>
        <span className="counter">
          {pointCount} / {MAX_DOCUMENT_POINTS} 采样点
        </span>
      </div>
      <div className="board">
        <canvas ref={canvasRef} className={tool === "pan" ? "pan" : ""} />
      </div>
    </>
  );
}
