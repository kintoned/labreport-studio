import { open } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { openCover } from "./cover";
import { openImport } from "./csvimport";
import { canRedo, canUndo, closeFigure, G, initGraph, openFigure, redo, runBuild, undo } from "./graph";
import { closeTex, initLatex, L, mainFile, openTex, requestCompile, save } from "./latex";
import { initPdfEdit } from "./pdfedit";
import { clearPdf, initPdf, P, reloadPdf, setZoom } from "./pdfview";
import { openSettings } from "./settings";
import { emit, on, S } from "./state";
import "./styles.css";
import { initTree, renderTree, setActiveData } from "./tree";
import type { ProjectInfo } from "./types";
import { checkUpdate } from "./updater";
import { clear, h, promptText, showError, toast } from "./ui";

type RightMode = "source" | "split" | "pdf";

const app = document.getElementById("app")!;

// ---- 骨組み ----
const projectName = h("span", { class: "project-name" });
const statusEl = h("span", { class: "status" });
const recentBtn = h("button", { class: "btn", onclick: () => showRecent() }, "最近 ▾");
const coverBtn = h("button", { class: "btn", disabled: true, onclick: () => void openCover() }, "表紙");
const topbar = h("div", { class: "topbar" },
  h("span", { class: "brand" }, "実験レポート統括"),
  h("button", { class: "btn", onclick: () => void newProject() }, "新規プロジェクト"),
  h("button", { class: "btn", onclick: () => void pickProject() }, "開く"),
  recentBtn,
  projectName,
  h("span", { class: "spacer" }),
  statusEl,
  coverBtn,
  h("button", { class: "btn", onclick: () => void openSettings() }, "設定"),
);

const treeHost = h("div", { class: "pane left" });

const centerTitle = h("span", { class: "pane-title" });
const undoBtn = h("button", { class: "btn small", title: "元に戻す (Ctrl+Z)", onclick: undo }, "↶ 元に戻す");
const redoBtn = h("button", { class: "btn small", title: "やり直す (Ctrl+Y)", onclick: redo }, "↷ やり直す");
const graphTools = h("span", { class: "tools" }, undoBtn, redoBtn, h("button", { class: "btn small", title: "図を今すぐ保存して PDF に反映", onclick: () => void runBuild() }, "PDF に反映"));
const graphView = h("div", { class: "graph-view" });
const graphPanel = h("div", { class: "graph-panel" });
const graphArea = h("div", { class: "graph-area" }, graphView, graphPanel);
const csvArea = h("div", { class: "csv-area" });
const welcome = h("div", { class: "welcome" });
const center = h("div", { class: "pane center" }, h("div", { class: "pane-head" }, centerTitle, h("span", { class: "spacer" }), graphTools), graphArea, csvArea, welcome);

const fileLabel = h("span", { class: "pane-title" });
const saveBtn = h("button", { class: "btn small primary", title: "保存してコンパイル (Ctrl+S)", onclick: () => void save(true) }, "保存 ▸ コンパイル");
const autosaveBox = h("input", { type: "checkbox", checked: L.autosave });
autosaveBox.addEventListener("change", () => {
  L.autosave = autosaveBox.checked;
  localStorage.setItem("autosave", L.autosave ? "1" : "0");
});
const modeBtns: Record<RightMode, HTMLButtonElement> = {
  source: h("button", { class: "btn small seg", onclick: () => setRightMode("source") }, "ソース"),
  split: h("button", { class: "btn small seg", onclick: () => setRightMode("split") }, "分割"),
  pdf: h("button", { class: "btn small seg", onclick: () => setRightMode("pdf") }, "PDF"),
};
const editorHost = h("div", { class: "editor-host" });
const pdfHost = h("div", { class: "pdf-host" });
const errorHost = h("div", { class: "errors" });
const rightBody = h("div", { class: "right-body" }, editorHost, h("div", { class: "hsplit", "data-split": "h" }), h("div", { class: "pdf-wrap" },
  h("div", { class: "pdf-tools" },
    h("button", { class: "btn small", title: "縮小", onclick: () => setZoom(P.zoom / 1.2) }, "−"),
    h("button", { class: "btn small", title: "幅に合わせる", onclick: () => setZoom(1) }, "幅"),
    h("button", { class: "btn small", title: "拡大", onclick: () => setZoom(P.zoom * 1.2) }, "＋"),
    h("span", { class: "hint" }, "クリック: ソースへ移動／図を選択　ダブルクリック: 本文をその場で編集"),
  ),
  pdfHost,
));
const right = h("div", { class: "pane right" },
  h("div", { class: "pane-head" }, fileLabel, saveBtn, h("label", { class: "inline", title: "入力が止まって 1.5 秒後に自動で保存・コンパイルします" }, autosaveBox, "自動保存"), h("span", { class: "spacer" }), modeBtns.source, modeBtns.split, modeBtns.pdf),
  rightBody,
  errorHost,
);

const main = h("div", { class: "main" }, treeHost, h("div", { class: "vsplit", "data-split": "left" }), center, h("div", { class: "vsplit", "data-split": "right" }), right);
app.append(topbar, main);

// ---- ペインの境界をドラッグで調整 ----
function initSplitters(): void {
  const saved = JSON.parse(localStorage.getItem("layout") || "{}") as { left?: number; right?: number; editor?: number };
  let left = saved.left ?? 230;
  let rightW = saved.right ?? Math.round(window.innerWidth * 0.36);
  let editor = saved.editor ?? 45;
  const apply = () => {
    main.style.gridTemplateColumns = `${left}px 5px minmax(360px, 1fr) 5px ${rightW}px`;
    rightBody.style.setProperty("--editor", `${editor}%`);
    localStorage.setItem("layout", JSON.stringify({ left, right: rightW, editor }));
  };
  apply();
  document.querySelectorAll<HTMLElement>("[data-split]").forEach((el) => {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const kind = el.dataset.split;
      const move = (ev: PointerEvent) => {
        if (kind === "left") left = Math.max(150, Math.min(500, ev.clientX));
        else if (kind === "right") rightW = Math.max(300, Math.min(window.innerWidth - 600, window.innerWidth - ev.clientX));
        else {
          const r = rightBody.getBoundingClientRect();
          editor = Math.max(10, Math.min(90, ((ev.clientY - r.top) / r.height) * 100));
        }
        apply();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.classList.remove("dragging");
      };
      document.body.classList.add("dragging");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  });
}

function setRightMode(mode: RightMode): void {
  rightBody.dataset.mode = mode;
  localStorage.setItem("rightMode", mode);
  for (const [k, b] of Object.entries(modeBtns)) b.classList.toggle("active", k === mode);
}

function showCenter(which: "graph" | "csv" | "welcome", title = ""): void {
  graphArea.style.display = which === "graph" ? "" : "none";
  csvArea.style.display = which === "csv" ? "" : "none";
  welcome.style.display = which === "welcome" ? "" : "none";
  graphTools.style.display = which === "graph" ? "" : "none";
  centerTitle.textContent = title;
  if (which !== "csv") setActiveData("");
  if (which === "welcome") renderWelcome();
}

function renderWelcome(): void {
  clear(welcome);
  if (S.project) {
    welcome.append(
      h("h2", null, S.project.name),
      h("p", null, "左のツリーから始めます。"),
      h("ol", null,
        h("li", null, "「データ」の ＋ CSV で測定データを取り込む（見出し行・単位などをクリックで指定）"),
        h("li", null, "「図」の ＋ 新しい図 でグラフを作り、グラフ上の要素をクリックして編集する"),
        h("li", null, "右のソースに \\includegraphics{figures/図の名前.pdf} を書いて保存すると PDF に反映される"),
      ),
    );
    return;
  }
  const recent = S.info?.recent ?? [];
  welcome.append(
    h("h2", null, "実験レポート統括ソフト"),
    h("p", null, "CSV の取り込み、グラフの直接編集、フィッティング、LaTeX レポートの編集と PDF プレビューを 1 つにまとめます。"),
    h("div", { class: "btn-row" },
      h("button", { class: "btn primary", onclick: () => void newProject() }, "新規プロジェクトを作成"),
      h("button", { class: "btn", onclick: () => void pickProject() }, "既存のプロジェクトを開く"),
    ),
  );
  if (recent.length > 0) {
    welcome.append(h("div", { class: "recent" }, h("div", { class: "panel-title" }, "最近のプロジェクト"), recent.map((d) => h("button", { class: "recent-item", onclick: () => void openProject(d) }, h("strong", null, d.split(/[\\/]/).pop() ?? d), h("span", null, d)))));
  }
}

function showRecent(): void {
  document.querySelector(".menu")?.remove();
  const recent = S.info?.recent ?? [];
  const r = recentBtn.getBoundingClientRect();
  const menu = h("div", { class: "menu", style: { left: `${r.left}px`, top: `${r.bottom + 2}px` } },
    recent.length ? recent.map((d) => h("button", { class: "menu-item", onclick: () => void openProject(d) }, h("strong", null, d.split(/[\\/]/).pop() ?? d), h("span", null, d))) : h("div", { class: "tree-empty" }, "履歴はありません"),
  );
  document.body.append(menu);
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }));
}

// ---- プロジェクト ----
async function loadProject(info: ProjectInfo): Promise<void> {
  if (S.dir) {
    await runBuild().catch(() => undefined);
    await save(false, false);
  }
  closeFigure();
  closeTex();
  S.dir = info.dir;
  S.project = { ...info.project, datasets: info.project.datasets ?? [], cover: info.project.cover ?? {}, mainFile: info.project.mainFile || "main.tex" };
  S.tree = info.tree;
  localStorage.setItem("lastProject", info.dir);
  projectName.textContent = `${S.project.name}  —  ${info.dir}`;
  projectName.title = info.dir;
  coverBtn.disabled = false;
  emit("project");
  clearPdf();
  showCenter("welcome");
  renderTree();
  S.info = await api.appInfo();
  if (S.tree.tex.includes(mainFile())) {
    await openTex(mainFile());
    await reloadPdf(); // 前回のプレビューがあればすぐ表示
    requestCompile();
  } else {
    toast(`${mainFile()} が見つかりません。左の「本文」で ★ を押して起点ファイルを選んでください`, "error");
  }
  if (S.tree.figures.length) await openFigure(S.tree.figures[0]);
}

async function openProject(dir: string): Promise<void> {
  try {
    await loadProject(await api.projectOpen(dir));
  } catch (e) {
    showError(e);
  }
}

async function pickProject(): Promise<void> {
  const dir = await open({ directory: true, title: "実験プロジェクトのフォルダを選択" });
  if (typeof dir === "string") await openProject(dir);
}

async function newProject(): Promise<void> {
  const name = await promptText("新規プロジェクト", "実験名（この名前のフォルダを作ります）", "", "次へ");
  if (!name) return;
  if (/[\\/:*?"<>|]/.test(name)) {
    toast("実験名に \\ / : * ? \" < > | は使えません", "error");
    return;
  }
  const parent = await open({ directory: true, title: `「${name}」フォルダを作る場所を選択（Google Drive の同期フォルダなど）` });
  if (typeof parent !== "string") return;
  try {
    await loadProject(await api.projectCreate(`${parent.replace(/[\\/]+$/, "")}\\${name}`, name));
    toast(`プロジェクト「${name}」を作成しました`, "ok");
  } catch (e) {
    showError(e);
  }
}

// ---- イベント配線 ----
on("status", (p) => {
  const { text, kind } = p as { text: string; kind: string };
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
});
on("tree", renderTree);
on("show-graph", (name) => {
  showCenter("graph", `図: ${String(name)}`);
  renderTree();
});
on("show-welcome", () => showCenter("welcome"));
on("open-import", (file) => {
  const f = String(file);
  showCenter("csv", `CSV 取り込み: ${f.replace(/^data\//, "")}`);
  setActiveData(f);
  void openImport(csvArea, f);
});
on("import-done", () => {
  if (G.name) showCenter("graph", `図: ${G.name}`);
  renderTree();
});
on("graph-history", () => {
  undoBtn.disabled = !canUndo();
  redoBtn.disabled = !canRedo();
});
const updateFileLabel = () => {
  fileLabel.textContent = L.file ? `${L.file}${L.dirty ? " ●" : ""}` : "";
  saveBtn.disabled = !L.file;
};
on("tex-opened", () => {
  updateFileLabel();
  renderTree();
});
on("tex-dirty", updateFileLabel);
on("show-source", () => {
  if (rightBody.dataset.mode === "pdf") setRightMode("split");
});
on("compiled", () => void reloadPdf());
on("main-changed", () => {
  clearPdf();
  requestCompile();
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && !(e.target as HTMLElement).closest(".cm-editor")) {
    e.preventDefault();
    void runBuild();
    void save(true);
  }
});
window.addEventListener("beforeunload", () => {
  void runBuild();
  void save(false, false);
});

// ---- 起動 ----
async function start(): Promise<void> {
  initSplitters();
  initTree(treeHost);
  initGraph(graphView, graphPanel);
  initLatex(editorHost, errorHost);
  initPdf(pdfHost);
  initPdfEdit();
  setRightMode((localStorage.getItem("rightMode") as RightMode) || "split");
  updateFileLabel();
  emit("graph-history");
  clearPdf();
  try {
    S.info = await api.appInfo();
  } catch (e) {
    showError(e);
  }
  showCenter("welcome");
  const fromArg = await api.startupProject().catch(() => null);
  const last = localStorage.getItem("lastProject");
  if (fromArg) await openProject(fromArg);
  else if (last && S.info?.recent.includes(last)) await openProject(last);
  void checkUpdate(false);
}

void start();
