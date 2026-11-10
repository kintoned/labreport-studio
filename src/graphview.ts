// グラフ直接編集ビュー。図設定と計算結果から SVG を描き、クリック・ダブルクリック・ドラッグを
// コントローラへ伝える。座標系は pt（1cm = 28.35pt）で、pgfplots の出力と同じ寸法になる。

import { fillText } from "./textrender";
import type { Computed, CSeries, Figure, RAxis, Series } from "./types";
import { clear, h, s } from "./ui";

export type Sel = { kind: "figure" } | { kind: "axis"; axis: "x" | "y" } | { kind: "series"; id: string };

export interface ViewCtx {
  fig: Figure;
  computed: Computed | null;
  sel: Sel;
  rangeMode: boolean;
  select(sel: Sel): void;
  commitText(target: string, value: string): void;
  setRange(a: number, b: number): void;
  moveEq(id: string, pos: [number, number]): void;
}

const CM = 28.3465;
const FONT = '"Times New Roman", "BIZ UDPMincho", "MS PMincho", "Yu Mincho", serif';

export function unitDisplay(unit: string): string {
  if (!unit.trim()) return "";
  if (!unit.includes("$") && /[\^_\\]/.test(unit)) return `$\\mathrm{${unit}}$`;
  return unit;
}

export function axisLabelText(label: string, unit: string): string {
  const u = unitDisplay(unit.trim());
  const l = label.trim();
  if (!u) return l;
  return l ? `${l} [${u}]` : `[${u}]`;
}

function scaleFn(ax: RAxis, size: number): { f: (v: number) => number; inv: (p: number) => number } {
  if (ax.log) {
    const a = Math.log10(ax.min);
    const b = Math.log10(ax.max);
    return { f: (v) => ((Math.log10(v) - a) / (b - a)) * size, inv: (p) => 10 ** (a + (p / size) * (b - a)) };
  }
  return { f: (v) => ((v - ax.min) / (ax.max - ax.min)) * size, inv: (p) => ax.min + (p / size) * (ax.max - ax.min) };
}

function dash(style: string, lw: number): string | null {
  switch (style) {
    case "dashed":
      return "3 3";
    case "dotted":
      return `${lw} 2`;
    case "dashdotted":
      return `3 2 ${lw} 2`;
    default:
      return null;
  }
}

function markerPath(marker: string, x: number, y: number, r: number): string {
  const m = marker.replace("*", "");
  const f = (n: number) => n.toFixed(2);
  switch (m || "o") {
    case "o":
      return `M${f(x - r)},${f(y)}a${f(r)},${f(r)} 0 1,0 ${f(2 * r)},0a${f(r)},${f(r)} 0 1,0 ${f(-2 * r)},0z`;
    case "square":
      return `M${f(x - r)},${f(y - r)}h${f(2 * r)}v${f(2 * r)}h${f(-2 * r)}z`;
    case "triangle":
      return `M${f(x)},${f(y - r)}L${f(x + 0.866 * r)},${f(y + 0.5 * r)}L${f(x - 0.866 * r)},${f(y + 0.5 * r)}z`;
    case "diamond":
      return `M${f(x)},${f(y - r)}L${f(x + 0.75 * r)},${f(y)}L${f(x)},${f(y + r)}L${f(x - 0.75 * r)},${f(y)}z`;
    case "x": {
      const d = r * 0.707;
      return `M${f(x - d)},${f(y - d)}L${f(x + d)},${f(y + d)}M${f(x - d)},${f(y + d)}L${f(x + d)},${f(y - d)}`;
    }
    case "+":
      return `M${f(x - r)},${f(y)}h${f(2 * r)}M${f(x)},${f(y - r)}v${f(2 * r)}`;
    default:
      return "";
  }
}

function markerFill(marker: string, color: string): string {
  return marker.includes("*") ? color : "none";
}

function text(src: string, fs: number, attrs: Record<string, string | number | null | undefined>): SVGTextElement {
  const t = s("text", { "font-size": fs, "font-family": FONT, ...attrs });
  fillText(t, src, fs);
  return t;
}

export function renderGraph(host: HTMLElement, ctx: ViewCtx): void {
  clear(host);
  const { fig, computed: c } = ctx;
  if (!c) {
    host.append(h("div", { class: "empty" }, "計算中…"));
    return;
  }
  const W = fig.width * CM;
  const H = fig.height * CM;
  const fs = fig.fontSize;
  const xa = c.xAxis;
  const ya = c.yAxis;
  const xLabel = axisLabelText(fig.xAxis.label, fig.xAxis.unit);
  const yLabel = axisLabelText(fig.yAxis.label, fig.yAxis.unit);

  const legendItems = fig.legendPos === "none" ? [] : fig.series
    .map((se, i) => ({ se, cs: c.series[i] }))
    .filter(({ se, cs }) => se.visible && se.legend.trim() && cs && cs.points.length > 0 && (se.lineStyle !== "none" || se.marker !== "none"));
  const outer = fig.legendPos.startsWith("outer");
  const legendEst = legendItems.length ? Math.max(...legendItems.map(({ se }) => se.legend.length)) * fs * 0.62 + 40 : 0;

  const yTickW = ya.log ? fs * 1.7 : Math.max(fs, ...ya.ticks.map((t) => t.label.length * fs * 0.5));
  const ml = 6 + (yLabel ? fs * 1.6 : 0) + yTickW + fs * 0.6;
  const mb = 6 + (xLabel ? fs * 1.7 : 0) + fs * 1.5;
  const mt = 4 + (ya.exp ? fs * 1.5 : fs * 0.7);
  const mr = 4 + fs * 1.2 + (outer ? legendEst + 8 : 0);
  const TW = ml + W + mr;
  const TH = mt + H + mb;

  const availW = Math.max(200, host.clientWidth - 40);
  const availH = Math.max(150, host.clientHeight - 40);
  const k = Math.min(availW / TW, availH / TH, 3.2);

  const svg = s("svg", { width: (TW * k).toFixed(1), height: (TH * k).toFixed(1), viewBox: `0 0 ${TW.toFixed(2)} ${TH.toFixed(2)}`, class: "graph-svg" });
  const wrap = h("div", { class: "graph-wrap" });
  wrap.append(svg);
  host.append(wrap);

  const X = scaleFn(xa, W);
  const Y0 = scaleFn(ya, H);
  const fx = (v: number) => X.f(v);
  const fy = (v: number) => H - Y0.f(v);
  const isSel = (sel: Sel) => JSON.stringify(sel) === JSON.stringify(ctx.sel);

  // --- 背景 ---
  const bg = s("rect", { x: 0, y: 0, width: TW, height: TH, fill: "#fff" });
  bg.addEventListener("click", () => ctx.select({ kind: "figure" }));
  svg.append(bg);
  const g = s("g", { transform: `translate(${ml.toFixed(2)},${mt.toFixed(2)})` });
  svg.append(g);

  // --- 軸の選択領域 ---
  const xHit = s("rect", { x: 0, y: H, width: W, height: mb - 2, fill: isSel({ kind: "axis", axis: "x" }) ? "#e8f1ff" : "transparent", class: "hit" });
  xHit.addEventListener("click", () => ctx.select({ kind: "axis", axis: "x" }));
  const yHit = s("rect", { x: -ml + 2, y: 0, width: ml - 2, height: H, fill: isSel({ kind: "axis", axis: "y" }) ? "#e8f1ff" : "transparent", class: "hit" });
  yHit.addEventListener("click", () => ctx.select({ kind: "axis", axis: "y" }));
  g.append(xHit, yHit);

  // --- グリッド ---
  const grid = s("g", { stroke: "#c8c8c8", "stroke-width": 0.4 });
  if (fig.xAxis.grid) for (const t of xa.ticks) grid.append(s("line", { x1: fx(t.v), x2: fx(t.v), y1: 0, y2: H }));
  if (fig.yAxis.grid) for (const t of ya.ticks) grid.append(s("line", { y1: fy(t.v), y2: fy(t.v), x1: 0, x2: W }));
  g.append(grid);

  // --- 系列 ---
  const clipId = `clip${Math.random().toString(36).slice(2)}`;
  svg.append(s("defs", {}, s("clipPath", { id: clipId }, s("rect", { x: 0, y: 0, width: W, height: H }))));
  const plot = s("g", { "clip-path": `url(#${clipId})` });
  g.append(plot);

  const selSeries = ctx.sel.kind === "series" ? fig.series.find((x) => x.id === (ctx.sel as { id: string }).id) : undefined;
  if (selSeries?.kind === "fit" && selSeries.range) {
    const [a, b] = selSeries.range;
    const x0 = fx(Math.min(a, b));
    const x1 = fx(Math.max(a, b));
    plot.append(s("rect", { x: x0, y: 0, width: Math.max(0, x1 - x0), height: H, fill: selSeries.color, opacity: 0.08 }));
    for (const x of [x0, x1]) plot.append(s("line", { x1: x, x2: x, y1: 0, y2: H, stroke: selSeries.color, "stroke-width": 0.5, "stroke-dasharray": "2 2" }));
  }

  const marksLayer = s("g");
  const clampP = (p: number) => Math.max(-1e5, Math.min(1e5, p));
  const drawSeries = (se: Series, cs: CSeries) => {
    if (!se.visible || !cs || cs.points.length === 0) return;
    const hasLine = se.lineStyle !== "none";
    const hasMark = se.marker !== "none" && se.marker !== "";
    if (!hasLine && !hasMark) return;
    let d = "";
    let md = "";
    let pen = false;
    const r = Math.max(0.1, se.markerSize);
    let marks = 0;
    for (const [vx, vy] of cs.points) {
      const ok = vy !== null && Number.isFinite(vx) && Number.isFinite(vy) && (!xa.log || vx > 0) && (!ya.log || vy > 0);
      if (!ok) {
        pen = false;
        continue;
      }
      const px = clampP(fx(vx));
      const py = clampP(fy(vy as number));
      if (hasLine) d += `${pen ? "L" : "M"}${px.toFixed(2)},${py.toFixed(2)}`;
      pen = true;
      if (hasMark && px >= -0.05 && px <= W + 0.05 && py >= -0.05 && py <= H + 0.05 && marks < 20000) {
        md += markerPath(se.marker, px, py, r);
        marks++;
      }
    }
    const grp = s("g", { class: "series", "data-id": se.id });
    const mgrp = s("g", { class: "series", "data-id": se.id });
    const selected = isSel({ kind: "series", id: se.id });
    if (selected) {
      if (d) grp.append(s("path", { d, fill: "none", stroke: "#ffca28", "stroke-width": se.lineWidth + 4, opacity: 0.55, "stroke-linecap": "round", "stroke-linejoin": "round" }));
      if (md) mgrp.append(s("path", { d: md, fill: "none", stroke: "#ffca28", "stroke-width": 3.2, opacity: 0.55 }));
    }
    if (d) grp.append(s("path", { d, fill: "none", stroke: se.color, "stroke-width": se.lineWidth, "stroke-dasharray": dash(se.lineStyle, se.lineWidth), "stroke-linejoin": "round" }));
    if (md) mgrp.append(s("path", { d: md, fill: markerFill(se.marker, se.color), stroke: se.color, "stroke-width": 0.6 }));
    // 当たり判定を広げる
    if (d) grp.append(s("path", { d, fill: "none", stroke: "transparent", "stroke-width": Math.max(7, se.lineWidth + 6), class: "hit" }));
    if (md) mgrp.append(s("path", { d: md, fill: "transparent", stroke: "transparent", "stroke-width": 5, class: "hit" }));
    for (const el of [grp, mgrp]) {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        ctx.select({ kind: "series", id: se.id });
      });
    }
    plot.append(grp);
    marksLayer.append(mgrp);
    if (cs.theory && se.highlight && cs.theory.outliers.length) {
      let od = "";
      for (const [vx, vy] of cs.theory.outliers) {
        if ((xa.log && vx <= 0) || (ya.log && vy <= 0)) continue;
        od += markerPath("o", fx(vx), fy(vy), Math.max(2, se.markerSize) + 2.5);
      }
      plot.append(s("path", { d: od, fill: "none", stroke: "red", "stroke-width": 1, "pointer-events": "none" }));
    }
  };
  fig.series.forEach((se, i) => drawSeries(se, c.series[i]));

  g.append(marksLayer);

  // --- 枠と目盛り ---
  g.append(s("rect", { x: 0, y: 0, width: W, height: H, fill: "none", stroke: "#000", "stroke-width": 0.4, "pointer-events": "none" }));
  const ticks = s("g", { stroke: "#000", "stroke-width": 0.4, "pointer-events": "none" });
  const TL = 4.2;
  const minor = (ax: RAxis): number[] => {
    if (!ax.log) return [];
    const out: number[] = [];
    for (let e = Math.floor(Math.log10(ax.min)) - 1; e <= Math.ceil(Math.log10(ax.max)); e++)
      for (let m = 2; m <= 9; m++) {
        const v = m * 10 ** e;
        if (v > ax.min * (1 + 1e-9) && v < ax.max * (1 - 1e-9)) out.push(v);
      }
    return out;
  };
  for (const t of xa.ticks) ticks.append(s("line", { x1: fx(t.v), x2: fx(t.v), y1: H, y2: H - TL }), s("line", { x1: fx(t.v), x2: fx(t.v), y1: 0, y2: TL }));
  for (const v of minor(xa)) ticks.append(s("line", { x1: fx(v), x2: fx(v), y1: H, y2: H - TL * 0.6 }), s("line", { x1: fx(v), x2: fx(v), y1: 0, y2: TL * 0.6 }));
  for (const t of ya.ticks) ticks.append(s("line", { y1: fy(t.v), y2: fy(t.v), x1: 0, x2: TL }), s("line", { y1: fy(t.v), y2: fy(t.v), x1: W, x2: W - TL }));
  for (const v of minor(ya)) ticks.append(s("line", { y1: fy(v), y2: fy(v), x1: 0, x2: TL * 0.6 }), s("line", { y1: fy(v), y2: fy(v), x1: W, x2: W - TL * 0.6 }));
  g.append(ticks);

  const labels = s("g", { "pointer-events": "none" });
  for (const t of xa.ticks) labels.append(text(`$${t.label}$`, fs, { x: fx(t.v), y: H + fs * 1.15, "text-anchor": "middle" }));
  for (const t of ya.ticks) labels.append(text(`$${t.label}$`, fs, { x: -fs * 0.45, y: fy(t.v) + fs * 0.33, "text-anchor": "end" }));
  if (xa.exp) labels.append(text(`$\\times 10^{${xa.exp}}$`, fs, { x: W, y: H + fs * 2.6, "text-anchor": "end" }));
  if (ya.exp) labels.append(text(`$\\times 10^{${ya.exp}}$`, fs, { x: 0, y: -fs * 0.45, "text-anchor": "start" }));
  g.append(labels);

  // --- 軸ラベル（ダブルクリックで直接編集） ---
  const editable = (el: SVGElement, target: string, raw: string, sel: Sel) => {
    el.classList.add("editable");
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      ctx.select(sel);
    });
    el.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startEdit(wrap, el, raw, (v) => ctx.commitText(target, v));
    });
  };
  const xl = text(xLabel || "（X 軸ラベル）", fs, { x: W / 2, y: H + fs * 1.5 + fs * 1.25, "text-anchor": "middle", fill: xLabel ? "#000" : "#aaa" });
  editable(xl, "xlabel", fig.xAxis.label, { kind: "axis", axis: "x" });
  const ylx = -(yTickW + fs * 0.6 + fs * 0.55);
  const yl = text(yLabel || "（Y 軸ラベル）", fs, { x: 0, y: 0, "text-anchor": "middle", fill: yLabel ? "#000" : "#aaa", transform: `translate(${ylx.toFixed(2)},${(H / 2).toFixed(2)}) rotate(-90)` });
  editable(yl, "ylabel", fig.yAxis.label, { kind: "axis", axis: "y" });
  g.append(xl, yl);

  // --- フィット式 ---
  fig.series.forEach((se, i) => {
    const cs = c.series[i];
    if (!se.visible || se.kind !== "fit" || !cs?.fit) return;
    const lines: string[] = [];
    if (se.showEquation) lines.push(`$${cs.fit.equationLatex}$`);
    if (se.showR2 && cs.fit.r2 !== null) lines.push(`$R^2 = ${cs.fit.r2.toFixed(4)}$`);
    if (!lines.length) return;
    const ex = se.eqPos[0] * W + 2;
    const ey = H - se.eqPos[1] * H + 2;
    const eg = s("g", { class: "eq-label", transform: `translate(${ex.toFixed(2)},${ey.toFixed(2)})` });
    lines.forEach((ln, j) => eg.append(text(ln, fs, { x: 0, y: fs * 0.85 + j * fs * 1.2, fill: se.color })));
    eg.addEventListener("click", (e) => {
      e.stopPropagation();
      ctx.select({ kind: "series", id: se.id });
    });
    eg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const sx = e.clientX;
      const sy = e.clientY;
      let nx = ex;
      let ny = ey;
      let moved = false;
      const move = (ev: PointerEvent) => {
        nx = ex + (ev.clientX - sx) / k;
        ny = ey + (ev.clientY - sy) / k;
        moved = moved || Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3;
        eg.setAttribute("transform", `translate(${nx.toFixed(2)},${ny.toFixed(2)})`);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (moved) ctx.moveEq(se.id, [Math.round(((nx - 2) / W) * 1000) / 1000, Math.round(((H - ny + 2) / H) * 1000) / 1000]);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    g.append(eg);
  });

  // --- 凡例 ---
  if (legendItems.length) {
    const lg = s("g", { class: "legend" });
    const rowH = fs * 1.3;
    const sample = 20;
    const pad = 3;
    const box = s("rect", { fill: "#fff", stroke: "#000", "stroke-width": 0.4 });
    lg.append(box);
    const texts: SVGTextElement[] = [];
    legendItems.forEach(({ se }, j) => {
      const cy = pad + rowH * j + rowH / 2;
      const hasLine = se.lineStyle !== "none";
      if (hasLine) lg.append(s("line", { x1: pad, x2: pad + sample, y1: cy, y2: cy, stroke: se.color, "stroke-width": se.lineWidth, "stroke-dasharray": dash(se.lineStyle, se.lineWidth) }));
      if (se.marker !== "none") lg.append(s("path", { d: markerPath(se.marker, pad + sample / 2, cy, Math.max(0.1, se.markerSize)), fill: markerFill(se.marker, se.color), stroke: se.color, "stroke-width": 0.6 }));
      const t = text(se.legend, fs, { x: pad + sample + 4, y: cy + fs * 0.33 });
      editable(t, `legend:${se.id}`, se.legend, { kind: "series", id: se.id });
      texts.push(t);
      lg.append(t);
    });
    g.append(lg);
    const tw = Math.max(...texts.map((t) => t.getComputedTextLength()));
    const bw = pad + sample + 4 + tw + pad + 1;
    const bh = pad * 2 + rowH * legendItems.length;
    box.setAttribute("width", bw.toFixed(2));
    box.setAttribute("height", bh.toFixed(2));
    const mx = 0.03 * W;
    const my = 0.03 * H;
    let lx = W - mx - bw;
    let ly = my;
    switch (fig.legendPos) {
      case "north west":
        lx = mx;
        break;
      case "south east":
        ly = H - my - bh;
        break;
      case "south west":
        lx = mx;
        ly = H - my - bh;
        break;
      case "outer north east":
        lx = W + 0.03 * W;
        ly = 0;
        break;
    }
    lg.setAttribute("transform", `translate(${lx.toFixed(2)},${ly.toFixed(2)})`);
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      ctx.select({ kind: "figure" });
    });
  }

  // --- フィット範囲のドラッグ指定 ---
  if (ctx.rangeMode) {
    const cover = s("rect", { x: 0, y: 0, width: W, height: H, fill: "rgba(30,120,255,0.04)", class: "range-cover" });
    const band = s("rect", { y: 0, height: H, width: 0, fill: "rgba(30,120,255,0.18)", stroke: "#1e78ff", "stroke-width": 0.5, "pointer-events": "none" });
    g.append(cover, band);
    cover.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const rect = cover.getBoundingClientRect();
      const toX = (cx: number) => Math.max(0, Math.min(W, (cx - rect.left) / k));
      const x0 = toX(e.clientX);
      let x1 = x0;
      const move = (ev: PointerEvent) => {
        x1 = toX(ev.clientX);
        band.setAttribute("x", Math.min(x0, x1).toFixed(2));
        band.setAttribute("width", Math.abs(x1 - x0).toFixed(2));
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (Math.abs(x1 - x0) > 2) ctx.setRange(X.inv(Math.min(x0, x1)), X.inv(Math.max(x0, x1)));
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }
}

/** SVG 上の文字の位置に入力欄を重ねて直接書き換える */
function startEdit(wrap: HTMLElement, el: SVGElement, raw: string, commit: (v: string) => void): void {
  const r = el.getBoundingClientRect();
  const w = wrap.getBoundingClientRect();
  const width = Math.max(140, r.width + 40);
  const input = h("input", {
    class: "inline-edit",
    type: "text",
    value: raw,
    spellcheck: false,
    style: {
      left: `${r.left - w.left + r.width / 2 - width / 2}px`,
      top: `${r.top - w.top + r.height / 2 - 14}px`,
      width: `${width}px`,
    },
  });
  let done = false;
  const finish = (ok: boolean) => {
    if (done) return;
    done = true;
    const v = input.value;
    input.remove();
    if (ok && v !== raw) commit(v);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  wrap.append(input);
  input.focus();
  input.select();
}
