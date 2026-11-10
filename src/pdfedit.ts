// PDF 直接編集。PDF そのものは書き換えず、SyncTeX で対応するソース行を求めて LaTeX を書き換える。
//  - 本文をクリック: ソースの該当行へ移動 / ダブルクリック: その段落をその場で編集
//  - 図をクリック: グラフ編集ビューを開き、サイズ変更ハンドルと配置ツールバーを表示

import { api } from "./api";
import { commit, G, openFigure } from "./graph";
import { getFileText, mainFile, openTex, setFileText } from "./latex";
import { P, placedFigures, pageDiv, setPdfHandlers, type PdfPointer } from "./pdfview";
import { ensureFloatPackage, findFigureAt, getPlacement, moveFigure, paragraphRange, scaleWidth, setPlacement, togglePlacement, type FigureHit } from "./sourceops";
import { emit, on, S } from "./state";
import { normalizeFigure, type PdfBox } from "./types";
import { h, showError, toast } from "./ui";

interface Selection {
  file: string;
  name: string;
}

let selection: Selection | null = null;
let overlay: HTMLElement | null = null;
let popup: HTMLElement | null = null;

export function initPdfEdit(): void {
  setPdfHandlers({ click: (p) => void onClick(p).catch(showError), dblclick: (p) => void onDblClick(p).catch(showError) });
  on("pdf-rendered", () => void restoreSelection().catch(() => undefined));
  on("project", () => {
    selection = null;
    overlay = null;
    popup = null;
  });
}

function clearOverlay(): void {
  overlay?.remove();
  overlay = null;
}

function closePopup(): void {
  popup?.remove();
  popup = null;
}

async function locate(p: PdfPointer): Promise<{ file: string; line: number; lines: string[]; hit: FigureHit | null } | null> {
  const pos = await api.synctexEdit(S.dir, mainFile(), p.page, p.x, p.y);
  if (!pos) return null;
  const lines = (await getFileText(pos.file)).split("\n");
  const line = pos.line - 1;
  return { file: pos.file, line, lines, hit: findFigureAt(lines, line) };
}

async function onClick(p: PdfPointer): Promise<void> {
  closePopup();
  const loc = await locate(p);
  if (!loc) {
    clearOverlay();
    selection = null;
    return;
  }
  if (loc.hit) {
    selection = { file: loc.file, name: loc.hit.name };
    await showFigureOverlay(loc.file, loc.hit, loc.lines, p);
    if (S.tree.figures.includes(loc.hit.name) && G.name !== loc.hit.name) await openFigure(loc.hit.name);
    else if (S.tree.figures.includes(loc.hit.name)) emit("show-graph", loc.hit.name);
  } else {
    clearOverlay();
    selection = null;
    await openTex(loc.file, loc.line + 1);
  }
}

async function onDblClick(p: PdfPointer): Promise<void> {
  const loc = await locate(p);
  if (!loc) return;
  if (loc.hit && loc.hit.gfxLine === loc.line) return; // 図そのものはクリックで選択済み
  openTextPopup(loc.file, loc.line, loc.lines, p);
}

/**
 * SyncTeX は 1 行に対して段落全体の箱なども返す。画像そのものの箱は
 * 「ページ内に収まっている箱のうち最小のもの」とみなす（クリック位置に近いものを優先）。
 */
function pickBox(boxes: PdfBox[], page: number | null, x?: number, y?: number): PdfBox | null {
  const pageW = (n: number) => P.pages.find((q) => q.n === n)?.w ?? Infinity;
  const ok = boxes.filter((b) => b.W > 3 && b.H > 3 && (page === null || b.page === page));
  const onPage = ok.filter((b) => b.h >= -1 && b.h + b.W <= pageW(b.page) + 1);
  const cand = onPage.length ? onPage : ok;
  const near = x === undefined || y === undefined ? [] : cand.filter((b) => x >= b.h - 20 && x <= b.h + b.W + 20 && y >= b.v - b.H - 40 && y <= b.v + 20);
  const pool = near.length ? near : cand;
  return pool.sort((p1, p2) => p1.W * p1.H - p2.W * p2.H)[0] ?? null;
}

async function showFigureOverlay(file: string, hit: FigureHit, lines: string[], p?: PdfPointer): Promise<void> {
  clearOverlay();
  const boxes = await api.synctexView(S.dir, mainFile(), file, hit.gfxLine + 1);
  const sbox = pickBox(boxes, p?.page ?? null, p?.x, p?.y);
  if (!sbox) return;
  // 実際に描かれている範囲（拡大縮小後）を PDF の描画命令から求める。
  // SyncTeX の箱は左下の基準点と元の寸法を与えるので、最も近い貼り込みの拡大率を掛ける。
  let box = sbox;
  const placed = await placedFigures(sbox.page).catch(() => []);
  const dist = (q: { x: number; bottom: number }) => Math.hypot(q.x - sbox.h, q.bottom - sbox.v);
  const real = placed.sort((q1, q2) => dist(q1) - dist(q2))[0];
  if (real && dist(real) < 30) box = { ...sbox, h: real.x, v: real.bottom, W: real.w ?? sbox.W * real.sx, H: real.h ?? sbox.H * real.sy };
  const div = pageDiv(box.page);
  if (!div) return;
  const sc = P.scale;
  const el = h("div", { class: "pdf-overlay fig-sel", style: { left: `${box.h * sc}px`, top: `${(box.v - box.H) * sc}px`, width: `${box.W * sc}px`, height: `${box.H * sc}px` } });

  const placement = hit.hasEnv ? getPlacement(lines, hit.envStart) : "";
  const bar = h("div", { class: "fig-bar" });
  const known = S.tree.figures.includes(hit.name);
  bar.append(h("span", { class: "fig-name" }, hit.name));
  if (known) bar.append(h("button", { class: "btn small", title: "中央のグラフ編集ビューで開く", onclick: () => void openFigure(hit.name) }, "グラフを編集"));
  if (hit.hasEnv) {
    bar.append(h("span", { class: "sep" }, "配置"));
    for (const [letter, tip] of [["h", "ここ (here)"], ["t", "ページ上部 (top)"], ["b", "ページ下部 (bottom)"], ["p", "図だけのページ (page)"], ["H", "厳密にここ（float パッケージ）"]] as const) {
      const active = letter === "H" ? placement === "H" : placement !== "H" && placement.includes(letter);
      bar.append(h("button", { class: `btn small place ${active ? "active" : ""}`, title: tip, onclick: () => void changePlacement(letter).catch(showError) }, letter));
    }
    bar.append(
      h("span", { class: "sep" }, "移動"),
      h("button", { class: "btn small", title: "1 つ前の段落の前へ", onclick: () => void move(-1).catch(showError) }, "↑ 前の段落へ"),
      h("button", { class: "btn small", title: "1 つ後ろの段落の後へ", onclick: () => void move(1).catch(showError) }, "↓ 次の段落へ"),
    );
  }
  bar.append(h("button", { class: "icon-btn", title: "選択を解除", onclick: () => {
    selection = null;
    clearOverlay();
  } }, "×"));
  if (box.v - box.H < 60) bar.classList.add("below");
  // ツールバーは図の位置に関わらずページ幅に収める
  bar.style.left = `${6 - box.h * sc}px`;
  bar.style.maxWidth = `${div.clientWidth - 12}px`;

  const handle = h("div", { class: "fig-handle", title: "ドラッグでサイズ変更（width を書き換えます）" });
  const sizeTag = h("div", { class: "fig-size" });
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const w0 = box.W * sc;
    const h0 = box.H * sc;
    const sx = e.clientX;
    let f = 1;
    const moveFn = (ev: PointerEvent) => {
      f = Math.max(0.1, (w0 + (ev.clientX - sx)) / w0);
      el.style.width = `${w0 * f}px`;
      el.style.height = `${h0 * f}px`;
      sizeTag.textContent = `${Math.round(f * 100)} %（幅 ${((box.W * f * 2.54) / 72).toFixed(1)} cm）`;
    };
    const up = () => {
      window.removeEventListener("pointermove", moveFn);
      window.removeEventListener("pointerup", up);
      sizeTag.textContent = "";
      if (Math.abs(f - 1) > 0.01) void resize(f, box.W * f).catch(showError);
      else {
        el.style.width = `${w0}px`;
        el.style.height = `${h0}px`;
      }
    };
    window.addEventListener("pointermove", moveFn);
    window.addEventListener("pointerup", up);
  });
  el.append(bar, handle, sizeTag);
  div.append(el);
  overlay = el;
}

/** 選択中の図を、いまのソースから探し直す（編集で行番号が変わるため名前で追う） */
async function findSelected(): Promise<{ lines: string[]; hit: FigureHit; file: string } | null> {
  if (!selection) return null;
  const lines = (await getFileText(selection.file)).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("figures/")) continue;
    const hit = findFigureAt(lines, i);
    if (hit && hit.gfxLine === i && hit.name === selection.name) return { lines, hit, file: selection.file };
  }
  return null;
}

async function restoreSelection(): Promise<void> {
  overlay = null; // ページ要素ごと作り直されている
  popup = null;
  const s = await findSelected();
  if (s) await showFigureOverlay(s.file, s.hit, s.lines);
}

async function resize(factor: number, newWidthBp: number): Promise<void> {
  const s = await findSelected();
  if (!s) return;
  if (s.hit.mode === "pdf") {
    s.lines[s.hit.gfxLine] = scaleWidth(s.lines[s.hit.gfxLine], factor, newWidthBp);
    await setFileText(s.file, s.lines.join("\n"));
    return;
  }
  // \input で pgfplots コードを直接読み込んでいる図は、図設定の寸法を変える
  const name = s.hit.name;
  const r2 = (v: number) => Math.round(v * factor * 100) / 100;
  if (G.name === name) {
    commit((f) => {
      f.width = r2(f.width);
      f.height = r2(f.height);
    }, { panel: true });
  } else {
    const fig = normalizeFigure(await api.figureRead(S.dir, name));
    fig.width = r2(fig.width);
    fig.height = r2(fig.height);
    await api.figureBuild(S.dir, S.project?.datasets ?? [], name, fig);
    emit("figure-built", name);
  }
}

async function changePlacement(letter: string): Promise<void> {
  const s = await findSelected();
  if (!s || !s.hit.hasEnv) return;
  const next = togglePlacement(getPlacement(s.lines, s.hit.envStart), letter);
  setPlacement(s.lines, s.hit.envStart, next);
  if (next === "H") {
    if (s.file === mainFile()) {
      if (ensureFloatPackage(s.lines)) toast("[H] に必要な \\usepackage{float} をプリアンブルに追加しました", "info");
    } else {
      const main = (await getFileText(mainFile())).split("\n");
      if (ensureFloatPackage(main)) {
        await api.writeText(S.dir, mainFile(), main.join("\n"));
        toast("[H] に必要な \\usepackage{float} を追加しました", "info");
      }
    }
  }
  await setFileText(s.file, s.lines.join("\n"));
}

async function move(dir: -1 | 1): Promise<void> {
  const s = await findSelected();
  if (!s || !s.hit.hasEnv) return;
  const at = moveFigure(s.lines, s.hit.envStart, s.hit.envEnd, dir);
  if (at === null) {
    toast(dir < 0 ? "これより前には動かせません（節の先頭です）" : "これより後ろには動かせません（節の末尾です）", "info", undefined, 2500);
    return;
  }
  await setFileText(s.file, s.lines.join("\n"));
}

function openTextPopup(file: string, line: number, lines: string[], p: PdfPointer): void {
  closePopup();
  const [a, b] = paragraphRange(lines, line);
  const src = lines.slice(a, b + 1).map((l) => l.replace(/\r$/, "")).join("\n");
  const pageW = p.div.clientWidth;
  const width = Math.min(pageW - 16, 620);
  const left = Math.max(8, Math.min(p.x * P.scale - width / 2, pageW - width - 8));
  const ta = h("textarea", { class: "input", spellcheck: false, rows: Math.min(14, Math.max(3, b - a + 2 + Math.floor(src.length / 70))) });
  ta.value = src;
  const apply = async () => {
    if (ta.value === src) {
      closePopup();
      return;
    }
    const cur = (await getFileText(file)).split("\n");
    if (cur.slice(a, b + 1).map((l) => l.replace(/\r$/, "")).join("\n") !== src) {
      toast("ソースが変更されたため反映できませんでした。もう一度ダブルクリックしてください", "error");
      closePopup();
      return;
    }
    cur.splice(a, b - a + 1, ...ta.value.split("\n"));
    closePopup();
    await setFileText(file, cur.join("\n"));
  };
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") closePopup();
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void apply().catch(showError);
    }
  });
  const el = h("div", { class: "pdf-overlay text-edit", style: { left: `${left}px`, top: `${p.y * P.scale + 14}px`, width: `${width}px` } },
    h("div", { class: "text-edit-head" }, h("span", null, `${file}  ${a + 1}${b > a ? `–${b + 1}` : ""} 行目のソース`), h("span", { class: "hint" }, "Ctrl+Enter で反映 / Esc で取消")),
    ta,
    h("div", { class: "btn-row end" },
      h("button", { class: "btn small", onclick: () => void openTex(file, line + 1).then(() => emit("show-source")) }, "エディタで開く"),
      h("button", { class: "btn small", onclick: closePopup }, "キャンセル"),
      h("button", { class: "btn small primary", onclick: () => void apply().catch(showError) }, "反映して再コンパイル"),
    ),
  );
  p.div.append(el);
  popup = el;
  ta.focus();
}
