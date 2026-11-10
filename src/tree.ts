// 左ペイン: プロジェクトツリー（データ・図・本文・表紙）

import { open } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { openCover } from "./cover";
import { closeFigure, createFigure, G, openFigure } from "./graph";
import { confirmDeleteFigure } from "./graphprops";
import { L, mainFile, openTex } from "./latex";
import { emit, refreshTree, S, saveProject } from "./state";
import { clear, confirmBox, h, showError } from "./ui";

let host: HTMLElement;
let activeData = "";

export function initTree(el: HTMLElement): void {
  host = el;
}

export function setActiveData(file: string): void {
  activeData = file;
  renderTree();
}

async function addCsv(): Promise<void> {
  const picked = await open({
    multiple: true,
    title: "取り込む CSV を選択（元ファイルは変更せず、プロジェクトの data/ にコピーします）",
    filters: [{ name: "データ", extensions: ["csv", "txt", "tsv", "dat"] }, { name: "すべて", extensions: ["*"] }],
  });
  if (!picked) return;
  const files = Array.isArray(picked) ? picked : [picked];
  let last = "";
  for (const f of files) last = await api.importData(S.dir, f);
  await refreshTree();
  if (last) emit("open-import", last);
}

function section(title: string, action: { label: string; run: () => void } | null, items: HTMLElement[], empty: string): HTMLElement {
  return h("div", { class: "tree-section" },
    h("div", { class: "tree-head" }, h("span", null, title), action && h("button", { class: "btn small", onclick: action.run }, action.label)),
    items.length ? items : h("div", { class: "tree-empty" }, empty),
  );
}

export function renderTree(): void {
  clear(host);
  const p = S.project;
  if (!p) return;

  const registered = new Set(p.datasets.map((d) => d.file));
  const dataItems = [
    ...p.datasets.map((d) =>
      h("div", { class: `tree-item ${activeData === d.file ? "active" : ""}`, title: `${d.file}\nクリックで取り込み設定を開く`, onclick: () => emit("open-import", d.file) },
        h("span", { class: "ico" }, "▦"),
        h("span", { class: "tree-label" }, d.name),
        h("button", {
          class: "icon-btn",
          title: "この取り込み設定を外す（data/ の元ファイルは残ります）",
          onclick: async (e: Event) => {
            e.stopPropagation();
            if (!(await confirmBox("データを外す", `「${d.name}」をプロジェクトから外します。\n元ファイル ${d.file} は削除されません。`, "外す"))) return;
            p.datasets = p.datasets.filter((x) => x.id !== d.id);
            saveProject();
            renderTree();
          },
        }, "×"),
      ),
    ),
    ...S.tree.data.filter((f) => !registered.has(`data/${f}`)).map((f) =>
      h("div", { class: `tree-item dim ${activeData === `data/${f}` ? "active" : ""}`, title: "まだ取り込み設定がありません。クリックで設定", onclick: () => emit("open-import", `data/${f}`) },
        h("span", { class: "ico" }, "▦"),
        h("span", { class: "tree-label" }, f),
        h("span", { class: "tag" }, "未設定"),
      ),
    ),
  ];

  const figItems = S.tree.figures.map((name) =>
    h("div", { class: `tree-item ${G.name === name && !activeData ? "active" : ""}`, onclick: () => void openFigure(name) },
      h("span", { class: "ico" }, "◔"),
      h("span", { class: "tree-label" }, name),
      h("button", {
        class: "icon-btn",
        title: "図を削除",
        onclick: async (e: Event) => {
          e.stopPropagation();
          if (!(await confirmDeleteFigure(name))) return;
          try {
            if (G.name === name) {
              closeFigure();
              emit("show-welcome");
            }
            await api.figureDelete(S.dir, name);
            await refreshTree();
          } catch (err) {
            showError(err);
          }
        },
      }, "×"),
    ),
  );

  const texItems = S.tree.tex.filter((f) => f !== "cover.tex").map((f) =>
    h("div", { class: `tree-item ${L.file === f ? "active" : ""}`, onclick: () => void openTex(f).then(() => emit("show-source")) },
      h("span", { class: "ico" }, "¶"),
      h("span", { class: "tree-label" }, f),
      f === mainFile()
        ? h("span", { class: "tag", title: "コンパイルの起点になるファイル" }, "本文")
        : f !== "values.tex" && h("button", {
            class: "icon-btn",
            title: "このファイルをコンパイルの起点（本文）にする",
            onclick: (e: Event) => {
              e.stopPropagation();
              p.mainFile = f;
              saveProject();
              renderTree();
              emit("main-changed");
            },
          }, "★"),
    ),
  );

  const coverItems = [
    h("div", { class: `tree-item ${L.file === "cover.tex" ? "active" : ""}`, onclick: () => void openCover() },
      h("span", { class: "ico" }, "▣"),
      h("span", { class: "tree-label" }, S.tree.tex.includes("cover.tex") ? "cover.tex（フォームで編集）" : "表紙を作成…"),
    ),
  ];

  host.append(
    section("データ", { label: "＋ CSV", run: () => void addCsv().catch(showError) }, dataItems, "CSV を追加してください"),
    section("図", { label: "＋ 新しい図", run: () => void createFigure() }, figItems, "まだ図がありません"),
    section("本文", null, texItems, ".tex がありません"),
    section("表紙", null, coverItems, ""),
  );
}
