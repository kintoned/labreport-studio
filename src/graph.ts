// グラフ編集のコントローラ: 図設定(JSON) の状態、元に戻す/やり直す、
// 即時プレビュー用の計算と、裏での pgfplots 再生成・PDF 化を取り仕切る。

import { api } from "./api";
import { renderPanel, updateResults } from "./graphprops";
import { renderGraph, type Sel } from "./graphview";
import { emit, newId, refreshTree, S, setStatus } from "./state";
import { defaultFigure, defaultSeries, normalizeFigure, PALETTE, type Computed, type Dataset, type Figure, type Series, type SeriesKind } from "./types";
import { debounce, errText, promptText, showError, toast } from "./ui";

export const G = {
  name: null as string | null,
  fig: null as Figure | null,
  computed: null as Computed | null,
  sel: { kind: "figure" } as Sel,
  rangeMode: false,
  buildErrors: [] as string[],
};

let viewHost: HTMLElement;
let panelHost: HTMLElement;
let undoStack: string[] = [];
let redoStack: string[] = [];
let lastKey = "";
let lastTime = 0;

export function initGraph(view: HTMLElement, panel: HTMLElement): void {
  viewHost = view;
  panelHost = panel;
  new ResizeObserver(() => G.fig && renderView()).observe(viewHost);
  document.addEventListener("keydown", (e) => {
    if (!G.fig || !viewHost.isConnected || viewHost.offsetParent === null) return;
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, .cm-editor, .modal")) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
      e.preventDefault();
      redo();
    } else if (e.key === "Escape" && G.rangeMode) {
      G.rangeMode = false;
      renderView();
      renderPanel(panelHost);
    }
  });
}

export function datasets(): Dataset[] {
  return S.project?.datasets ?? [];
}

export function renderView(): void {
  if (!G.fig) return;
  renderGraph(viewHost, {
    fig: G.fig,
    computed: G.computed,
    sel: G.sel,
    rangeMode: G.rangeMode,
    select,
    commitText(target, value) {
      commit((f) => {
        if (target === "xlabel") f.xAxis.label = value;
        else if (target === "ylabel") f.yAxis.label = value;
        else if (target.startsWith("legend:")) {
          const se = f.series.find((x) => x.id === target.slice(7));
          if (se) se.legend = value;
        }
      }, { panel: true });
    },
    setRange(a, b) {
      if (G.sel.kind !== "series") return;
      const id = G.sel.id;
      G.rangeMode = false;
      const sig = (v: number) => Number(v.toPrecision(4));
      commit((f) => {
        const se = f.series.find((x) => x.id === id);
        if (se) se.range = [sig(a), sig(b)];
      }, { panel: true });
    },
    moveEq(id, pos) {
      commit((f) => {
        const se = f.series.find((x) => x.id === id);
        if (se) se.eqPos = pos;
      });
    },
  });
}

export function select(sel: Sel): void {
  if (JSON.stringify(sel) === JSON.stringify(G.sel)) return;
  G.sel = sel;
  G.rangeMode = false;
  renderView();
  renderPanel(panelHost);
}

export function setRangeMode(on: boolean): void {
  G.rangeMode = on;
  renderView();
}

/**
 * 図設定を変更する唯一の入口。
 * key を付けると、同じ項目への連続した変更（入力中の 1 文字ごと等）を 1 回の「元に戻す」にまとめる。
 * panel: true でプロパティパネルも作り直す（構造が変わったとき）。
 */
export function commit(mut: (f: Figure) => void, opts: { key?: string; panel?: boolean } = {}): void {
  if (!G.fig) return;
  const before = JSON.stringify(G.fig);
  mut(G.fig);
  if (JSON.stringify(G.fig) === before) return;
  const now = Date.now();
  if (!(opts.key && opts.key === lastKey && now - lastTime < 900)) {
    undoStack.push(before);
    if (undoStack.length > 200) undoStack.shift();
  }
  lastKey = opts.key ?? "";
  lastTime = now;
  redoStack = [];
  afterChange(opts.panel ?? false);
}

function afterChange(panel: boolean): void {
  if (G.sel.kind === "series" && !G.fig!.series.some((x) => x.id === (G.sel as { id: string }).id)) G.sel = { kind: "figure" };
  renderView();
  if (panel) renderPanel(panelHost);
  emit("graph-history");
  requestCompute();
  scheduleBuild();
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}
export function canRedo(): boolean {
  return redoStack.length > 0;
}

export function undo(): void {
  if (!G.fig || !undoStack.length) return;
  redoStack.push(JSON.stringify(G.fig));
  G.fig = JSON.parse(undoStack.pop()!);
  lastKey = "";
  afterChange(true);
}

export function redo(): void {
  if (!G.fig || !redoStack.length) return;
  undoStack.push(JSON.stringify(G.fig));
  G.fig = JSON.parse(redoStack.pop()!);
  lastKey = "";
  afterChange(true);
}

// ---- 即時プレビュー用の計算（Rust 側。CSV はキャッシュされるので速い）----
let computing = false;
let computeDirty = false;

export function requestCompute(): void {
  if (computing) {
    computeDirty = true;
    return;
  }
  if (!G.fig || !G.name) return;
  computing = true;
  const name = G.name;
  api
    .figureCompute(S.dir, datasets(), G.fig)
    .then((c) => {
      if (G.name !== name) return;
      G.computed = c;
      renderView();
      updateResults();
    })
    .catch(showError)
    .finally(() => {
      computing = false;
      if (computeDirty) {
        computeDirty = false;
        requestCompute();
      }
    });
}

// ---- 保存 + pgfplots 再生成 + PDF 化（裏で実行、変更があったものだけ）----
let building = false;
let buildDirty = false;

const scheduleBuild = debounce(() => void runBuild(), 700);

export async function runBuild(): Promise<void> {
  scheduleBuild.cancel();
  if (!G.fig || !G.name) return;
  if (building) {
    buildDirty = true;
    return;
  }
  building = true;
  const name = G.name;
  const fig = JSON.parse(JSON.stringify(G.fig)) as Figure;
  setStatus(`図「${name}」を生成中…`, "busy");
  try {
    const r = await api.figureBuild(S.dir, datasets(), name, fig);
    if (G.name === name) G.buildErrors = r.errors.map((e) => e.message);
    if (r.errors.length) {
      setStatus(`図「${name}」の生成に失敗: ${r.errors[0].message}`, "error");
    } else {
      setStatus(r.cached ? `図「${name}」は変更なし` : `図「${name}」を更新しました`, "ok");
      if (r.pdfChanged || r.valuesChanged) emit("figure-built", name);
    }
    if (G.name === name) updateResults();
  } catch (e) {
    setStatus(`図の生成に失敗: ${errText(e)}`, "error");
  } finally {
    building = false;
    if (buildDirty) {
      buildDirty = false;
      void runBuild();
    }
  }
}

export async function openFigure(name: string): Promise<void> {
  if (G.name && G.name !== name) await runBuild();
  try {
    const raw = await api.figureRead(S.dir, name);
    G.name = name;
    G.fig = normalizeFigure(raw);
    G.computed = null;
    G.sel = { kind: "figure" };
    G.rangeMode = false;
    G.buildErrors = [];
    undoStack = [];
    redoStack = [];
    emit("show-graph", name);
    renderView();
    renderPanel(panelHost);
    emit("graph-history");
    requestCompute();
    scheduleBuild();
  } catch (e) {
    showError(e);
  }
}

export function closeFigure(): void {
  G.name = null;
  G.fig = null;
  G.computed = null;
}

function columnsOf(ds: Dataset | undefined) {
  return (ds?.import.columns ?? []).filter((c) => c.used);
}

/** データ系列の列から軸ラベル・単位を補う（空欄のときだけ） */
export function fillAxisLabels(f: Figure, se: Series): void {
  const ds = datasets().find((d) => d.id === se.dataset);
  const cols = columnsOf(ds);
  const x = cols.find((c) => c.index === se.xCol);
  const y = cols.find((c) => c.index === se.yCol);
  if (x && !f.xAxis.label && !f.xAxis.unit) {
    f.xAxis.label = x.name;
    f.xAxis.unit = x.unit;
  }
  if (y && !f.yAxis.label && !f.yAxis.unit) {
    f.yAxis.label = y.name;
    f.yAxis.unit = y.unit;
  }
}

export function makeSeries(f: Figure, kind: SeriesKind, datasetId?: string): Series {
  const id = newId("s", f.series.map((x) => x.id));
  const se = defaultSeries(kind, id, PALETTE[f.series.length % PALETTE.length]);
  const firstData = f.series.find((x) => x.kind === "data");
  if (kind === "data") {
    const ds = datasets().find((d) => d.id === datasetId) ?? datasets()[0];
    if (ds) {
      const cols = columnsOf(ds);
      se.dataset = ds.id;
      se.xCol = cols[0]?.index ?? 0;
      se.yCol = cols[1]?.index ?? cols[0]?.index ?? 0;
      se.legend = cols.find((c) => c.index === se.yCol)?.name || ds.name;
    }
  } else if (kind === "fit") {
    se.source = firstData?.id ?? "";
    se.legend = "フィット";
    const nFit = f.series.filter((x) => x.kind === "fit").length;
    se.eqPos = [0.05, Math.max(0.2, 0.95 - nFit * 0.18)];
  } else {
    se.compare = firstData?.id ?? "";
    se.legend = "理論式";
    se.expr = "a*x + b";
    se.params = { a: 1, b: 0 };
  }
  return se;
}

export async function createFigure(datasetId?: string): Promise<void> {
  if (!S.dir) return;
  const suggested = newId("fig", S.tree.figures);
  const name = await promptText("新しい図", "図の名前（ファイル名になります）", suggested, "作成");
  if (!name) return;
  if (/[\\/:*?"<>|]/.test(name)) {
    toast("図の名前に \\ / : * ? \" < > | は使えません", "error");
    return;
  }
  if (S.tree.figures.includes(name)) {
    toast(`図「${name}」は既にあります`, "error");
    return;
  }
  const f = defaultFigure();
  if (datasets().length) {
    const se = makeSeries(f, "data", datasetId);
    f.series.push(se);
    fillAxisLabels(f, se);
  }
  try {
    await api.figureBuild(S.dir, datasets(), name, f);
    await refreshTree();
    await openFigure(name);
  } catch (e) {
    showError(e);
  }
}

/** データ設定が変わったとき（CSV 取り込み設定の更新など）に呼ぶ */
export function refreshData(): void {
  if (!G.fig) return;
  renderPanel(panelHost);
  requestCompute();
  scheduleBuild();
}
