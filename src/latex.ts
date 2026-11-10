// LaTeX ソースエディタと自動コンパイル。保存すると裏で LuaLaTeX が走り、PDF プレビューが更新される。

import { indentWithTab } from "@codemirror/commands";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { basicSetup, EditorView } from "codemirror";
import { api } from "./api";
import { emit, on, S, setStatus } from "./state";
import type { CompileResult, TexError } from "./types";
import { clear, debounce, errText, h, showError } from "./ui";

export const L = {
  file: null as string | null,
  dirty: false,
  result: null as CompileResult | null,
  autosave: localStorage.getItem("autosave") === "1",
};

let view: EditorView;
let errorHost: HTMLElement;
let loading = false;

const autosave = debounce(() => {
  if (L.autosave && L.dirty) void save();
}, 1500);

function makeState(text: string): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      basicSetup,
      StreamLanguage.define(stex),
      lintGutter(),
      EditorView.lineWrapping,
      keymap.of([
        indentWithTab,
        {
          key: "Mod-s",
          run: () => {
            void save(true);
            return true;
          },
        },
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !loading) {
          if (!L.dirty) {
            L.dirty = true;
            emit("tex-dirty");
          }
          autosave();
        }
      }),
    ],
  });
}

export function initLatex(editorHost: HTMLElement, errors: HTMLElement): void {
  errorHost = errors;
  view = new EditorView({ state: makeState(""), parent: editorHost });
  on("figure-built", () => {
    void reloadIfOpen("values.tex");
    requestCompile();
  });
}

export function mainFile(): string {
  return S.project?.mainFile || "main.tex";
}

export async function openTex(rel: string, line?: number): Promise<void> {
  try {
    if (L.file !== rel) {
      if (L.dirty) await save(false, false);
      const text = await api.readText(S.dir, rel);
      loading = true;
      view.setState(makeState(text));
      loading = false;
      L.file = rel;
      L.dirty = false;
      emit("tex-opened", rel);
      showDiagnostics();
    }
    if (line) gotoLine(line);
  } catch (e) {
    showError(e);
  }
}

export function closeTex(): void {
  loading = true;
  view.setState(makeState(""));
  loading = false;
  L.file = null;
  L.dirty = false;
  L.result = null;
  clear(errorHost);
}

export function gotoLine(line: number): void {
  const n = Math.max(1, Math.min(line, view.state.doc.lines));
  const ln = view.state.doc.line(n);
  view.dispatch({ selection: { anchor: ln.from }, effects: EditorView.scrollIntoView(ln.from, { y: "center" }) });
  view.focus();
}

async function reloadIfOpen(rel: string): Promise<void> {
  if (L.file !== rel || L.dirty) return;
  const text = await api.readText(S.dir, rel);
  if (text === view.state.doc.toString()) return;
  loading = true;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  loading = false;
}

/** 開いているファイルならエディタの内容、そうでなければディスクから読む */
export async function getFileText(rel: string): Promise<string> {
  return rel === L.file ? view.state.doc.toString() : api.readText(S.dir, rel);
}

/** ソースを書き換えて保存し、再コンパイルする（PDF 直接編集・表紙挿入から使う） */
export async function setFileText(rel: string, text: string): Promise<void> {
  if (rel === L.file) {
    loading = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    loading = false;
    L.dirty = false;
    emit("tex-dirty");
  }
  await api.writeText(S.dir, rel, text);
  requestCompile();
}

export async function save(force = false, compileAfter = true): Promise<void> {
  if (!L.file || !S.dir) return;
  if (!L.dirty && !force) return;
  try {
    await api.writeText(S.dir, L.file, view.state.doc.toString());
    L.dirty = false;
    emit("tex-dirty");
    if (compileAfter) requestCompile();
  } catch (e) {
    showError(e);
  }
}

// ---- コンパイル（常に 1 本だけ走らせ、最中の要求は終了後に 1 回にまとめる）----
let compiling = false;
let pending = false;

export function requestCompile(): void {
  if (!S.dir) return;
  if (compiling) {
    pending = true;
    return;
  }
  compiling = true;
  const dir = S.dir;
  setStatus("コンパイル中…", "busy");
  emit("compiling", true);
  api
    .compile(dir, mainFile())
    .then((r) => {
      if (dir !== S.dir) return;
      L.result = r;
      showDiagnostics();
      if (r.ok) setStatus(`コンパイル完了（${(r.durationMs / 1000).toFixed(1)} 秒${r.runs > 1 ? `・${r.runs} 回` : ""}）`, "ok");
      else setStatus(`コンパイルエラー ${r.errors.length} 件`, "error");
      emit("compiled", r);
    })
    .catch((e) => {
      setStatus(`コンパイルできません: ${errText(e)}`, "error");
      L.result = null;
      clear(errorHost);
      errorHost.append(h("div", { class: "err-row" }, errText(e)));
    })
    .finally(() => {
      compiling = false;
      emit("compiling", false);
      if (pending) {
        pending = false;
        requestCompile();
      }
    });
}

function showDiagnostics(): void {
  const r = L.result;
  const errs: TexError[] = r?.errors ?? [];
  // エディタの該当行に表示
  const doc = view.state.doc;
  const diags: Diagnostic[] = [];
  for (const e of errs) {
    if (e.file !== L.file || e.line < 1 || e.line > doc.lines) continue;
    const ln = doc.line(e.line);
    diags.push({ from: ln.from, to: ln.to, severity: "error", message: e.message });
  }
  view.dispatch(setDiagnostics(view.state, diags));
  // 一覧
  clear(errorHost);
  errorHost.classList.toggle("has-errors", errs.length > 0);
  for (const e of errs) {
    errorHost.append(
      h("div", {
        class: "err-row",
        title: "クリックで該当行へ",
        onclick: () => {
          if (e.file && e.line) void openTex(e.file, e.line).then(() => emit("show-source"));
        },
      }, h("span", { class: "err-loc" }, e.file ? `${e.file}:${e.line}` : "LaTeX"), h("span", null, e.message)),
    );
  }
  if (r && errs.length === 0 && r.warnings.length) {
    errorHost.append(h("details", { class: "warn-box" }, h("summary", null, `警告 ${r.warnings.length} 件`), r.warnings.map((w) => h("div", { class: "warn-row" }, w))));
  }
}
