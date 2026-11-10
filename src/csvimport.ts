// CSV 取り込み画面。表としてプレビューし、見出し行・データ開始行・読み飛ばす行・使用列を
// クリックで指定する。設定はテンプレートとして保存でき、同じ形式のファイルには自動適用される。

import { api } from "./api";
import { createFigure, refreshData } from "./graph";
import { emit, newId, S, saveProject } from "./state";
import type { ColumnCfg, CsvPreview, CsvTemplate, Dataset, ImportCfg } from "./types";
import { clear, h, promptText, selectInput, showError, toast } from "./ui";

const ENCODINGS: [string, string][] = [["auto", "自動判定"], ["utf-8", "UTF-8"], ["shift_jis", "Shift_JIS"], ["euc-jp", "EUC-JP"], ["utf-16le", "UTF-16 LE"], ["utf-16be", "UTF-16 BE"], ["windows-1252", "Windows-1252"]];
const DELIMS: [string, string][] = [["auto", "自動判定"], [",", "カンマ ,"], ["tab", "タブ"], [";", "セミコロン ;"], ["space", "空白"]];

type Mode = "header" | "start" | "exclude";

const isNum = (v: string) => v.trim() !== "" && Number.isFinite(Number(v.trim().replace(/^"|"$/g, "").replace("−", "-")));

export function splitNameUnit(cell: string): { name: string; unit: string } {
  const m = cell.match(/^(.*?)\s*[\[(（［]\s*([^\])）］]+?)\s*[\])）］]\s*$/);
  return m && m[1].trim() ? { name: m[1].trim(), unit: m[2].trim() } : { name: cell.trim(), unit: "" };
}

/** 形式の初期推定: 最初に「全部数値」の行が続く所をデータ開始、その直前を見出しとみなす */
export function guess(rows: string[][]): Pick<ImportCfg, "headerRow" | "dataStart" | "columns"> {
  const numeric = (r: string[] | undefined) => !!r && r.filter((c) => c.trim() !== "").length > 0 && r.filter((c) => c.trim() !== "").every(isNum);
  let start = rows.findIndex((r, i) => numeric(r) && (numeric(rows[i + 1]) || i === rows.length - 1));
  if (start < 0) start = 0;
  const n = rows[start]?.length ?? 0;
  const prev = rows[start - 1];
  const headerRow = start > 0 && prev && prev.filter((c) => c.trim() !== "").length >= Math.min(n, 1) && !numeric(prev) && prev.length >= Math.max(1, n - 1) ? start - 1 : -1;
  return { headerRow, dataStart: start, columns: columnsFrom(rows, headerRow, n) };
}

function columnsFrom(rows: string[][], headerRow: number, n: number, old: ColumnCfg[] = []): ColumnCfg[] {
  const head = headerRow >= 0 ? rows[headerRow] ?? [] : [];
  return Array.from({ length: n }, (_, i) => {
    const prev = old.find((c) => c.index === i);
    const nu = head[i] ? splitNameUnit(head[i]) : { name: "", unit: "" };
    return { index: i, name: nu.name || prev?.name || `列${i + 1}`, unit: nu.unit || (head[i] ? "" : prev?.unit ?? ""), used: prev?.used ?? true };
  });
}

function signatureOf(rows: string[][], headerRow: number): string {
  return headerRow >= 0 ? (rows[headerRow] ?? []).map((c) => c.trim()).join("|") : "";
}

async function loadTemplates(): Promise<CsvTemplate[]> {
  return (await api.settingsRead<{ templates: CsvTemplate[] }>("csv_templates"))?.templates ?? [];
}

export async function openImport(host: HTMLElement, file: string): Promise<void> {
  const project = S.project!;
  const existing = project.datasets.find((d) => d.file === file);
  const baseName = file.replace(/^data\//, "").replace(/\.[^.]+$/, "");
  const ds: Dataset = existing
    ? JSON.parse(JSON.stringify(existing))
    : { id: newId("d", project.datasets.map((d) => d.id)), name: baseName, file, import: { encoding: "auto", delimiter: "auto", headerRow: -1, dataStart: 0, excludedRows: [], columns: [] } };
  const cfg = ds.import;
  let preview: CsvPreview | null = null;
  let mode: Mode = "header";
  let templates: CsvTemplate[] = [];
  let note = "";

  const tableHost = h("div", { class: "csv-table-host" });
  const bar = h("div", { class: "csv-bar" });
  clear(host);
  host.append(bar, tableHost);

  const reload = async (reguess: boolean) => {
    preview = await api.csvPreview(S.dir, file, cfg.encoding, cfg.delimiter);
    if (reguess) Object.assign(cfg, guess(preview.rows), { excludedRows: [] });
    else if (cfg.columns.length < preview.maxCols) cfg.columns = columnsFrom(preview.rows, -1, preview.maxCols, cfg.columns);
  };

  const applyTemplate = async (t: CsvTemplate) => {
    Object.assign(cfg, JSON.parse(JSON.stringify({ encoding: t.encoding, delimiter: t.delimiter, headerRow: t.headerRow, dataStart: t.dataStart, excludedRows: t.excludedRows, columns: t.columns })));
    await reload(false);
  };

  const renderBar = () => {
    clear(bar);
    const modeBtn = (m: Mode, label: string, cls: string) =>
      h("button", { class: `btn small mode ${cls} ${mode === m ? "active" : ""}`, onclick: () => {
        mode = m;
        renderBar();
      } }, label);
    const nameInput = h("input", { class: "input", type: "text", value: ds.name, style: { width: "150px" }, oninput: (e: Event) => (ds.name = (e.target as HTMLInputElement).value) });
    const tplSel = h("select", { class: "input" }, h("option", { value: "" }, "テンプレートを適用…"), templates.map((t) => h("option", { value: t.name }, t.name)));
    tplSel.addEventListener("change", () => {
      const t = templates.find((x) => x.name === tplSel.value);
      if (t) applyTemplate(t).then(() => {
        note = `テンプレート「${t.name}」を適用しました`;
        renderAll();
      }).catch(showError);
    });
    bar.append(
      h("div", { class: "csv-row" },
        h("strong", null, file),
        preview && h("span", { class: "hint" }, `全 ${preview.totalRows} 行（先頭 ${preview.rows.length} 行を表示）・${ENCODINGS.find((e) => e[0] === preview!.encoding)?.[1] ?? preview.encoding}`),
        note && h("span", { class: "badge" }, note),
      ),
      h("div", { class: "csv-row" },
        h("label", { class: "inline" }, "文字コード", selectInput(cfg.encoding, ENCODINGS, (v) => {
          cfg.encoding = v;
          reload(false).then(renderAll).catch(showError);
        })),
        h("label", { class: "inline" }, "区切り文字", selectInput(cfg.delimiter, DELIMS, (v) => {
          cfg.delimiter = v;
          reload(true).then(renderAll).catch(showError);
        })),
        tplSel,
        h("button", { class: "btn small", onclick: saveTemplate }, "この設定をテンプレート保存"),
      ),
      h("div", { class: "csv-row" },
        h("span", { class: "hint" }, "行をクリックして指定:"),
        modeBtn("header", "見出し行", "m-header"),
        modeBtn("start", "データ開始行", "m-start"),
        modeBtn("exclude", "読み飛ばす行", "m-exclude"),
        h("span", { class: "hint" }, "列の見出しのチェックで使用する列を選び、量の名前と単位を入力します"),
        h("span", { class: "spacer" }),
        h("label", { class: "inline" }, "データ名", nameInput),
        h("button", { class: "btn primary", onclick: commitImport }, existing ? "設定を更新" : "取り込む"),
      ),
    );
  };

  const renderTable = () => {
    clear(tableHost);
    if (!preview) return;
    const n = Math.max(preview.maxCols, cfg.columns.length);
    if (cfg.columns.length < n) cfg.columns = columnsFrom(preview.rows, -1, n, cfg.columns);
    const excluded = new Set(cfg.excludedRows);
    const headRow = h("tr", null, h("th", { class: "rownum" }, "行"));
    cfg.columns.slice(0, n).forEach((c) => {
      const th = h("th", { class: c.used ? "" : "unused" },
        h("label", { class: "col-use" },
          h("input", { type: "checkbox", checked: c.used, onchange: (e: Event) => {
            c.used = (e.target as HTMLInputElement).checked;
            th.classList.toggle("unused", !c.used);
            tableHost.querySelectorAll(`td[data-c="${c.index}"]`).forEach((td) => td.classList.toggle("unused", !c.used));
          } }),
          `列 ${c.index + 1}`,
        ),
        h("input", { class: "input", type: "text", value: c.name, placeholder: "量の名前", oninput: (e: Event) => (c.name = (e.target as HTMLInputElement).value) }),
        h("input", { class: "input", type: "text", value: c.unit, placeholder: "単位", oninput: (e: Event) => (c.unit = (e.target as HTMLInputElement).value) }),
      );
      headRow.append(th);
    });
    const body = h("tbody");
    preview.rows.forEach((r, i) => {
      const cls = i === cfg.headerRow ? "r-header" : i < cfg.dataStart || excluded.has(i) ? "r-skip" : r.every((c) => c.trim() === "") ? "r-skip" : "r-data";
      const tr = h("tr", { class: cls, onclick: () => rowClick(i) },
        h("td", { class: "rownum" }, i === cfg.headerRow ? `${i + 1} 見出し` : i === cfg.dataStart ? `${i + 1} 開始` : String(i + 1)),
      );
      for (let k = 0; k < n; k++) tr.append(h("td", { "data-c": k, class: cfg.columns[k]?.used ? "" : "unused" }, r[k] ?? ""));
      body.append(tr);
    });
    tableHost.append(h("table", { class: "csv-table" }, h("thead", null, headRow), body));
  };

  const rowClick = (i: number) => {
    if (!preview) return;
    if (mode === "header") {
      cfg.headerRow = cfg.headerRow === i ? -1 : i;
      if (cfg.headerRow >= 0) {
        cfg.columns = columnsFrom(preview.rows, cfg.headerRow, Math.max(preview.maxCols, cfg.columns.length), cfg.columns.map((c) => ({ ...c, name: "", unit: "" })));
        if (cfg.dataStart <= i) cfg.dataStart = i + 1;
      }
    } else if (mode === "start") {
      cfg.dataStart = i;
      if (cfg.headerRow >= i) cfg.headerRow = -1;
    } else {
      cfg.excludedRows = cfg.excludedRows.includes(i) ? cfg.excludedRows.filter((x) => x !== i) : [...cfg.excludedRows, i].sort((a, b) => a - b);
    }
    const top = tableHost.scrollTop;
    renderTable();
    tableHost.scrollTop = top;
  };

  const renderAll = () => {
    renderBar();
    renderTable();
  };

  const saveTemplate = async () => {
    if (!preview) return;
    const name = await promptText("取り込みテンプレートを保存", "テンプレート名（測定器名など）", "", "保存");
    if (!name) return;
    const t: CsvTemplate = { ...JSON.parse(JSON.stringify(cfg)), name, signature: signatureOf(preview.rows, cfg.headerRow) };
    templates = [...templates.filter((x) => x.name !== name), t];
    await api.settingsWrite("csv_templates", { templates });
    toast(`テンプレート「${name}」を保存しました。同じ見出しの CSV には次回から自動で適用されます`, "ok");
    renderBar();
  };

  const commitImport = () => {
    if (!cfg.columns.some((c) => c.used)) {
      toast("使用する列を 1 つ以上選んでください", "error");
      return;
    }
    ds.name = ds.name.trim() || baseName;
    const i = project.datasets.findIndex((d) => d.id === ds.id);
    const isNew = i < 0;
    if (isNew) project.datasets.push(JSON.parse(JSON.stringify(ds)));
    else project.datasets[i] = JSON.parse(JSON.stringify(ds));
    saveProject();
    emit("tree");
    refreshData();
    if (isNew) toast(`「${ds.name}」を取り込みました`, "ok", { label: "このデータで図を作る", run: () => void createFigure(ds.id) }, 9000);
    else toast(`「${ds.name}」の取り込み設定を更新しました`, "ok");
    emit("import-done", ds.id);
  };

  try {
    templates = await loadTemplates();
    await reload(!existing);
    if (!existing) {
      // 保存済みテンプレートの自動適用（見出し行の内容が一致するもの）
      for (const t of templates) {
        if (!t.signature) continue;
        const p = await api.csvPreview(S.dir, file, t.encoding, t.delimiter);
        if (signatureOf(p.rows, t.headerRow) === t.signature) {
          await applyTemplate(t);
          note = `テンプレート「${t.name}」を自動適用しました`;
          break;
        }
      }
    }
    renderAll();
  } catch (e) {
    clear(host);
    host.append(h("div", { class: "empty error" }, String(e)));
  }
}
