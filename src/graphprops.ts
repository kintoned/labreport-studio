// プロパティパネル: 選択中の要素（図全体・軸・系列）の設定項目と、フィット/理論式の結果表示。

import { api } from "./api";
import { commit, datasets, fillAxisLabels, G, makeSeries, select, setRangeMode } from "./graph";
import { plainText } from "./textrender";
import type { Axis, Figure, Series } from "./types";
import { checkInput, clear, colorInput, confirmBox, copyText, debounce, fmt, h, numInput, promptText, row, selectInput, showError, textInput, toast } from "./ui";

const KIND_LABEL = { data: "データ", fit: "フィット", theory: "理論式" } as const;
const LINE_STYLES: [string, string][] = [["solid", "実線"], ["dashed", "破線"], ["dotted", "点線"], ["dashdotted", "一点鎖線"], ["none", "なし"]];
const MARKERS: [string, string][] = [["none", "なし"], ["*", "● 丸（塗り）"], ["o", "○ 丸"], ["square*", "■ 四角（塗り）"], ["square", "□ 四角"], ["triangle*", "▲ 三角（塗り）"], ["triangle", "△ 三角"], ["diamond*", "◆ ひし形（塗り）"], ["diamond", "◇ ひし形"], ["x", "× バツ"], ["+", "＋ 十字"]];
const LEGEND_POS: [string, string][] = [["north east", "右上"], ["north west", "左上"], ["south east", "右下"], ["south west", "左下"], ["outer north east", "枠の外（右上）"], ["none", "表示しない"]];
const MODELS: [string, string][] = [["linear", "一次  y = ax + b"], ["poly", "多項式"], ["exp", "指数  y = a·e^(bx)"], ["log", "対数  y = a·ln x + b"], ["power", "べき乗  y = a·x^b"]];

interface GraphStyle {
  name: string;
  width: number;
  height: number;
  fontSize: number;
  legendPos: string;
  xGrid: boolean;
  yGrid: boolean;
  series: Pick<Series, "kind" | "color" | "lineWidth" | "lineStyle" | "marker" | "markerSize">[];
}

let resultsHost: HTMLElement | null = null;

function seriesName(se: Series): string {
  return plainText(se.legend) || `${KIND_LABEL[se.kind]} ${se.id}`;
}

function edit(id: string, key: string, mut: (se: Series, f: Figure) => void, panel = false): void {
  commit((f) => {
    const se = f.series.find((x) => x.id === id);
    if (se) mut(se, f);
  }, { key: `${id}.${key}`, panel });
}

export function renderPanel(host: HTMLElement): void {
  clear(host);
  resultsHost = null;
  const fig = G.fig;
  if (!fig) return;

  // ---- 系列リスト ----
  const list = h("div", { class: "series-list" });
  for (const se of fig.series) {
    const selected = G.sel.kind === "series" && G.sel.id === se.id;
    list.append(
      h("div", { class: `series-row ${selected ? "selected" : ""}`, onclick: () => select({ kind: "series", id: se.id }) },
        h("input", {
          type: "checkbox",
          checked: se.visible,
          title: "表示・非表示",
          onclick: (e: Event) => e.stopPropagation(),
          onchange: (e: Event) => edit(se.id, "visible", (x) => (x.visible = (e.target as HTMLInputElement).checked), true),
        }),
        h("span", { class: "swatch", style: { background: se.color } }),
        h("span", { class: "series-name" }, seriesName(se)),
        h("span", { class: "tag" }, KIND_LABEL[se.kind]),
        h("button", {
          class: "icon-btn",
          title: "この系列を削除",
          onclick: (e: Event) => {
            e.stopPropagation();
            commit((f) => {
              f.series = f.series.filter((x) => x.id !== se.id);
              for (const o of f.series) {
                if (o.source === se.id) o.source = "";
                if (o.compare === se.id) o.compare = "";
              }
            }, { panel: true });
          },
        }, "×"),
      ),
    );
  }
  const add = (kind: Series["kind"]) => () => {
    if (kind === "data" && !datasets().length) {
      toast("先に左の「データ」から CSV を取り込んでください", "error");
      return;
    }
    let id = "";
    commit((f) => {
      const se = makeSeries(f, kind);
      id = se.id;
      f.series.push(se);
      if (kind === "data") fillAxisLabels(f, se);
    }, { panel: true });
    if (id) select({ kind: "series", id });
  };
  host.append(
    h("div", { class: "panel-section" },
      h("div", { class: "panel-title" }, "系列"),
      list,
      h("div", { class: "btn-row" },
        h("button", { class: "btn small", onclick: add("data") }, "＋ データ"),
        h("button", { class: "btn small", onclick: add("fit") }, "＋ フィット"),
        h("button", { class: "btn small", onclick: add("theory") }, "＋ 理論式"),
      ),
    ),
  );

  // ---- 選択対象の切り替え ----
  const tab = (label: string, sel: typeof G.sel) =>
    h("button", { class: `tab ${JSON.stringify(sel) === JSON.stringify(G.sel) ? "active" : ""}`, onclick: () => select(sel) }, label);
  host.append(h("div", { class: "tabs" }, tab("全体", { kind: "figure" }), tab("X 軸", { kind: "axis", axis: "x" }), tab("Y 軸", { kind: "axis", axis: "y" })));

  const body = h("div", { class: "panel-section" });
  host.append(body);
  if (G.sel.kind === "figure") figurePanel(body, fig);
  else if (G.sel.kind === "axis") axisPanel(body, fig, G.sel.axis);
  else {
    const se = fig.series.find((x) => x.id === (G.sel as { id: string }).id);
    if (se) seriesPanel(body, fig, se);
  }
}

function figurePanel(body: HTMLElement, fig: Figure): void {
  const set = <K extends keyof Figure>(k: K) => (v: Figure[K] | null) => v !== null && commit((f) => void (f[k] = v), { key: `fig.${k}` });
  body.append(
    h("div", { class: "panel-title" }, "図全体"),
    row("幅 [cm]", numInput(fig.width, set("width"), { min: 1, max: 40, step: 0.5 }), "軸で囲まれた領域の幅"),
    row("高さ [cm]", numInput(fig.height, set("height"), { min: 1, max: 40, step: 0.5 }), "軸で囲まれた領域の高さ"),
    row("フォントサイズ [pt]", numInput(fig.fontSize, set("fontSize"), { min: 4, max: 40, step: 0.5 })),
    row("凡例の位置", selectInput(fig.legendPos, LEGEND_POS, set("legendPos"))),
    row("有効数字", numInput(fig.sigDigits, (v) => v !== null && set("sigDigits")(Math.round(v)), { min: 1, max: 12, step: 1 }), "フィット結果・values.tex の桁数"),
  );

  // グラフスタイル（設定フォルダに保存され、全 PC で共有できる）
  const styleBox = h("div", { class: "btn-row" });
  body.append(h("div", { class: "panel-title sub" }, "グラフスタイル"), styleBox);
  const load = async () => {
    const styles = ((await api.settingsRead<{ styles: GraphStyle[] }>("graph_styles"))?.styles ?? []) as GraphStyle[];
    clear(styleBox);
    const sel = h("select", { class: "input" }, h("option", { value: "" }, "スタイルを適用…"), styles.map((st) => h("option", { value: st.name }, st.name)));
    sel.addEventListener("change", () => {
      const st = styles.find((x) => x.name === sel.value);
      sel.value = "";
      if (!st) return;
      commit((f) => {
        f.width = st.width;
        f.height = st.height;
        f.fontSize = st.fontSize;
        f.legendPos = st.legendPos;
        f.xAxis.grid = st.xGrid;
        f.yAxis.grid = st.yGrid;
        const counters: Record<string, number> = {};
        for (const se of f.series) {
          const pool = st.series.filter((x) => x.kind === se.kind);
          const k = (counters[se.kind] = (counters[se.kind] ?? -1) + 1);
          if (pool[k]) Object.assign(se, pool[k]);
        }
      }, { panel: true });
    });
    styleBox.append(
      sel,
      h("button", {
        class: "btn small",
        onclick: async () => {
          const name = await promptText("グラフスタイルを保存", "スタイル名", "", "保存");
          if (!name || !G.fig) return;
          const f = G.fig;
          const st: GraphStyle = {
            name, width: f.width, height: f.height, fontSize: f.fontSize, legendPos: f.legendPos, xGrid: f.xAxis.grid, yGrid: f.yAxis.grid,
            series: f.series.map(({ kind, color, lineWidth, lineStyle, marker, markerSize }) => ({ kind, color, lineWidth, lineStyle, marker, markerSize })),
          };
          await api.settingsWrite("graph_styles", { styles: [...styles.filter((x) => x.name !== name), st] });
          toast(`スタイル「${name}」を保存しました`, "ok");
          void load();
        },
      }, "現在の見た目を保存"),
    );
  };
  load().catch(showError);
}

function axisPanel(body: HTMLElement, fig: Figure, which: "x" | "y"): void {
  const key = which === "x" ? "xAxis" : "yAxis";
  const ax = fig[key];
  const set = <K extends keyof Axis>(k: K) => (v: Axis[K]) => commit((f) => void (f[key][k] = v), { key: `${key}.${k}` });
  body.append(
    h("div", { class: "panel-title" }, which === "x" ? "X 軸" : "Y 軸"),
    row("ラベル", textInput(ax.label, set("label"), { placeholder: "例: 電圧 $V$" }), "$...$ で数式を書けます。グラフ上でダブルクリックしても編集できます"),
    row("単位", textInput(ax.unit, set("unit"), { placeholder: "例: V, m/s^2" })),
    row("最小", numInput(ax.min, set("min"), { nullable: true })),
    row("最大", numInput(ax.max, set("max"), { nullable: true })),
    row("目盛り間隔", numInput(ax.tick, (v) => set("tick")(v !== null && v > 0 ? v : null), { nullable: true }), "対数軸では無視されます"),
    row("対数軸", checkInput(ax.log, set("log"))),
    row("グリッド", checkInput(ax.grid, set("grid"))),
  );
}

function seriesOptions(fig: Figure, kind: Series["kind"]): [string, string][] {
  return [["", "（なし）"], ...fig.series.filter((x) => x.kind === kind).map((x) => [x.id, seriesName(x)] as [string, string])];
}

function seriesPanel(body: HTMLElement, fig: Figure, se: Series): void {
  const id = se.id;
  const set = <K extends keyof Series>(k: K, panel = false) => (v: Series[K]) => edit(id, k, (x) => void (x[k] = v), panel);
  const num = <K extends keyof Series>(k: K) => (v: number | null) => v !== null && edit(id, k, (x) => void ((x[k] as number) = v));

  body.append(h("div", { class: "panel-title" }, `${KIND_LABEL[se.kind]}系列`));

  if (se.kind === "data") {
    const ds = datasets().find((d) => d.id === se.dataset);
    const cols: [string, string][] = (ds?.import.columns ?? []).filter((c) => c.used).map((c) => [String(c.index), `${c.name || `列${c.index + 1}`}${c.unit ? ` [${c.unit}]` : ""}`]);
    body.append(
      row("データ", selectInput(se.dataset, [["", "（選択）"], ...datasets().map((d) => [d.id, d.name] as [string, string])], (v) =>
        edit(id, "dataset", (x) => {
          x.dataset = v;
          const c = (datasets().find((d) => d.id === v)?.import.columns ?? []).filter((q) => q.used);
          x.xCol = c[0]?.index ?? 0;
          x.yCol = c[1]?.index ?? c[0]?.index ?? 0;
        }, true))),
      row("X 列", selectInput(String(se.xCol), cols, (v) => edit(id, "xCol", (x) => void (x.xCol = Number(v))))),
      row("Y 列", selectInput(String(se.yCol), cols, (v) => edit(id, "yCol", (x) => void (x.yCol = Number(v))))),
    );
  }

  if (se.kind === "fit") {
    const rangeBtn = h("button", {
      class: `btn small ${G.rangeMode ? "primary" : ""}`,
      onclick: () => {
        setRangeMode(!G.rangeMode);
        rangeBtn.classList.toggle("primary", G.rangeMode);
        rangeBtn.textContent = G.rangeMode ? "グラフ上をドラッグ…" : "ドラッグで指定";
      },
    }, G.rangeMode ? "グラフ上をドラッグ…" : "ドラッグで指定");
    body.append(
      row("対象の系列", selectInput(se.source, seriesOptions(fig, "data"), set("source"))),
      row("種類", selectInput(se.model, MODELS, set("model", true))),
      ...(se.model === "poly" ? [row("次数", numInput(se.degree, (v) => v !== null && edit(id, "degree", (x) => void (x.degree = Math.round(v))), { min: 1, max: 12, step: 1 }))] : []),
      h("div", { class: "field" },
        h("span", { class: "field-label" }, "フィット範囲"),
        h("div", { class: "range-box" },
          numInput(se.range?.[0] ?? null, (v) => edit(id, "range0", (x) => void (x.range = v === null ? null : [v, x.range?.[1] ?? v])), { nullable: true, placeholder: "全体" }),
          h("span", null, "〜"),
          numInput(se.range?.[1] ?? null, (v) => edit(id, "range1", (x) => void (x.range = v === null ? null : [x.range?.[0] ?? v, v])), { nullable: true, placeholder: "全体" }),
        ),
      ),
      h("div", { class: "btn-row" }, rangeBtn, h("button", { class: "btn small", onclick: () => edit(id, "range", (x) => void (x.range = null), true) }, "範囲を解除")),
      row("式をグラフに表示", checkInput(se.showEquation, set("showEquation"))),
      row("R² をグラフに表示", checkInput(se.showR2, set("showR2"))),
      row("マクロ名の接頭辞", textInput(se.macroPrefix, (v) => set("macroPrefix")(v.replace(/[^A-Za-z]/g, "")), { placeholder: "例: fitA（英字のみ）" }), "指定すると係数・誤差・R² を values.tex に書き出します"),
    );
  }

  if (se.kind === "theory") {
    const paramsBox = h("div", { class: "params" });
    const exprMsg = h("div", { class: "hint" });
    const drawParams = (names: string[]) => {
      clear(paramsBox);
      for (const p of names) {
        paramsBox.append(row(p, numInput(G.fig?.series.find((x) => x.id === id)?.params[p] ?? null, (v) => v !== null && edit(id, `param.${p}`, (x) => void (x.params[p] = v)), { placeholder: "値" })));
      }
    };
    const syncExpr = debounce((expr: string) => {
      api.exprInfo(expr).then((info) => {
        exprMsg.textContent = "";
        exprMsg.classList.remove("error");
        edit(id, "expr-params", (x) => {
          const next: Record<string, number> = {};
          for (const p of info.params) next[p] = x.params[p] ?? 1;
          x.params = next;
        });
        drawParams(info.params);
      }).catch((e) => {
        exprMsg.textContent = String(e);
        exprMsg.classList.add("error");
      });
    }, 250);
    body.append(
      row("式  y =", textInput(se.expr, (v) => {
        set("expr")(v);
        syncExpr(v);
      }, { placeholder: "例: V0*exp(-x/tau)" }), "変数は x。使える関数: sin cos tan exp ln log(常用) sqrt abs など。定数: pi, e。x と定数以外の名前はパラメータになります"),
      exprMsg,
      h("div", { class: "panel-title sub" }, "パラメータ"),
      paramsBox,
      row("比較する測定値", selectInput(se.compare, seriesOptions(fig, "data"), set("compare"))),
      row("ずれのしきい値 [%]", numInput(se.threshold, num("threshold"), { min: 0 }), "誤差率がこれを超える点を強調表示します"),
      row("ずれの大きい点を強調", checkInput(se.highlight, set("highlight"))),
      row("マクロ名の接頭辞", textInput(se.macroPrefix, (v) => set("macroPrefix")(v.replace(/[^A-Za-z]/g, "")), { placeholder: "例: theory（英字のみ）" }), "指定すると誤差率の平均・最大を values.tex に書き出します"),
    );
    drawParams(Object.keys(se.params));
  }

  body.append(
    h("div", { class: "panel-title sub" }, "見た目"),
    row("凡例名", textInput(se.legend, set("legend"), { placeholder: "空欄で凡例に出さない" }), "グラフ上でダブルクリックしても編集できます"),
    row("色", colorInput(se.color, set("color"))),
    row("線種", selectInput(se.lineStyle, LINE_STYLES, set("lineStyle"))),
    row("線の太さ [pt]", numInput(se.lineWidth, num("lineWidth"), { min: 0.1, max: 10, step: 0.1 })),
    row("マーカー", selectInput(se.marker, MARKERS, set("marker"))),
    row("マーカーの大きさ [pt]", numInput(se.markerSize, num("markerSize"), { min: 0.2, max: 15, step: 0.25 })),
    row("表示", checkInput(se.visible, set("visible", true))),
  );

  if (se.kind !== "data") {
    resultsHost = h("div", { class: "results" });
    body.append(h("div", { class: "panel-title sub" }, "結果"), resultsHost);
    updateResults();
  }
}

/** 計算結果（係数・誤差・R²・誤差率）の表示だけを更新する。入力欄のフォーカスを奪わない。 */
export function updateResults(): void {
  if (!resultsHost || !resultsHost.isConnected || !G.fig || G.sel.kind !== "series") return;
  const id = G.sel.id;
  const i = G.fig.series.findIndex((x) => x.id === id);
  const cs = G.computed?.series[i];
  const host = resultsHost;
  clear(host);
  if (!cs || cs.id !== id) {
    host.append(h("div", { class: "hint" }, "計算中…"));
    return;
  }
  if (cs.error) {
    host.append(h("div", { class: "hint error" }, cs.error));
    return;
  }
  const sig = G.fig.sigDigits;
  if (cs.fit) {
    const f = cs.fit;
    const label = (n: string, k: number) => (f.model === "poly" ? `x${k === 0 ? "⁰" : k === 1 ? "¹" : `^${k}`} の係数` : n);
    host.append(
      h("table", { class: "result-table" },
        h("tr", null, h("th", null, "係数"), h("th", null, "値"), h("th", null, "標準誤差")),
        f.coeffs.map((v, k) => h("tr", null, h("td", null, label(f.names[k], k)), h("td", { class: "numcell" }, fmt(v, sig)), h("td", { class: "numcell" }, `± ${fmt(f.errors[k], 2)}`))),
        h("tr", null, h("td", null, "R²"), h("td", { class: "numcell", colSpan: 2 }, f.r2 === null ? "—" : f.r2.toFixed(5))),
        h("tr", null, h("td", null, "点数"), h("td", { class: "numcell", colSpan: 2 }, String(f.n))),
      ),
    );
  }
  if (cs.theory) {
    const t = cs.theory;
    host.append(
      h("table", { class: "result-table" },
        h("tr", null, h("td", null, "誤差率の平均"), h("td", { class: "numcell" }, `${fmt(t.meanAbs, 3)} %`)),
        h("tr", null, h("td", null, "誤差率の最大"), h("td", { class: "numcell" }, `${fmt(t.maxAbs, 3)} %`)),
        h("tr", null, h("td", null, "しきい値超え"), h("td", { class: "numcell" }, `${t.outliers.length} / ${t.rates.length} 点`)),
      ),
      h("details", null,
        h("summary", null, "各点の誤差率"),
        h("div", { class: "rate-scroll" },
          h("table", { class: "result-table" },
            h("tr", null, h("th", null, "x"), h("th", null, "測定値"), h("th", null, "誤差率")),
            t.rates.slice(0, 500).map(([x, y, r]) => {
              const th = G.fig?.series[i]?.threshold ?? Infinity;
              return h("tr", { class: Math.abs(r) > th ? "outlier" : "" }, h("td", { class: "numcell" }, fmt(x, 4)), h("td", { class: "numcell" }, fmt(y, 4)), h("td", { class: "numcell" }, `${r >= 0 ? "+" : ""}${fmt(r, 3)} %`));
            }),
          ),
        ),
      ),
    );
  } else if (cs.kind === "theory") {
    host.append(h("div", { class: "hint" }, "「比較する測定値」を選ぶと誤差率を計算します"));
  }
  if (cs.latex) {
    const latex = cs.latex;
    host.append(
      h("div", { class: "latex-box" }, h("code", null, latex)),
      h("div", { class: "btn-row" },
        h("button", { class: "btn small", onclick: () => copyText(latex, "数式を LaTeX 形式でコピーしました") }, "数式を LaTeX でコピー"),
        h("button", { class: "btn small", onclick: () => copyText(`\\begin{equation}\n  ${latex}\n\\end{equation}`, "equation 環境としてコピーしました") }, "equation 環境でコピー"),
      ),
    );
  }
  if (cs.macros.length) {
    host.append(
      h("div", { class: "panel-title sub" }, "values.tex のマクロ（クリックでコピー）"),
      h("div", { class: "macro-list" },
        cs.macros.map((m) => h("button", { class: "macro", title: m.comment, onclick: () => copyText(`\\${m.name}`, `\\${m.name} をコピーしました`) }, h("code", null, `\\${m.name}`), h("span", null, m.value.replace(/\\ensuremath\{(.*)\}$/, "$1").replace("\\times ", "×")))),
      ),
    );
  } else {
    host.append(h("div", { class: "hint" }, "「マクロ名の接頭辞」を入れると、値を本文から \\名前 で参照できます"));
  }
  if (G.buildErrors.length) host.append(h("div", { class: "hint error" }, `図の生成エラー: ${G.buildErrors[0]}`));
}

export async function confirmDeleteFigure(name: string): Promise<boolean> {
  return confirmBox("図の削除", `図「${name}」を削除します（設定 JSON と生成された .tex / .pdf）。\nこの操作は元に戻せません。`, "削除");
}
