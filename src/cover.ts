// 表紙: テンプレート（設定フォルダに保存、全 PC 共有）＋フォーム入力 → cover.tex を書き出す。
// テンプレート中の <<キー>> がフォームの値に置き換わる。

import { api } from "./api";
import { getFileText, mainFile, requestCompile, setFileText } from "./latex";
import { ensureCoverInput } from "./sourceops";
import { refreshTree, S, saveProject } from "./state";
import { clear, confirmBox, h, modal, showError, toast } from "./ui";

const LABELS: Record<string, string> = {
  title: "タイトル（科目名など）",
  experiment: "実験名",
  date: "実験日",
  studentId: "学籍番号",
  name: "氏名",
  partners: "共同実験者",
  submitDate: "提出日",
  group: "班",
  teacher: "担当教員",
  department: "学部・学科",
};
/** PC・実験をまたいで使い回す項目（既定値として保存する対象） */
const PERSONAL = ["studentId", "name", "department", "title", "group", "teacher"];

export function placeholders(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(/<<\s*([A-Za-z][A-Za-z0-9_]*)\s*>>/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

function escapeTex(v: string): string {
  return v.replace(/(^|[^\\])([%&#_])/g, "$1\\$2").replace(/(^|[^\\])([%&#_])/g, "$1\\$2");
}

export function fillTemplate(template: string, fields: Record<string, string>): string {
  const body = template.replace(/<<\s*([A-Za-z][A-Za-z0-9_]*)\s*>>/g, (_, k: string) => escapeTex(fields[k] ?? ""));
  return `% 自動生成: 実験レポート統括ソフト（表紙）。左の「表紙」のフォームから作り直せます。\n${body}`;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export async function openCover(): Promise<void> {
  const project = S.project;
  if (!project) return;
  try {
    let names = await api.coverTemplates();
    const defaults = (await api.settingsRead<Record<string, string>>("defaults")) ?? {};
    project.cover ??= {};
    const fields: Record<string, string> = { ...(project.cover.fields ?? {}) };
    let current = project.cover.template && names.includes(project.cover.template) ? project.cover.template : names[0] ?? "";
    let template = current ? await api.coverTemplateRead(current) : "";

    const m = modal("表紙", { wide: true });
    const form = h("div", { class: "cover-form" });
    const preview = h("pre", { class: "cover-preview" });
    const tplSel = h("select", { class: "input" });
    const initial = (k: string) => fields[k] ?? defaults[k] ?? (k === "experiment" ? project.name : k === "date" || k === "submitDate" ? today() : "");

    const draw = () => {
      clear(tplSel);
      tplSel.append(...names.map((n) => h("option", { value: n, selected: n === current }, n)));
      tplSel.value = current;
      clear(form);
      const keys = placeholders(template);
      if (!keys.length) form.append(h("div", { class: "hint" }, "このテンプレートには入力項目（<<キー>>）がありません"));
      for (const k of keys) {
        fields[k] = initial(k);
        const input = h("input", { class: "input", type: "text", value: fields[k] });
        input.addEventListener("input", () => {
          fields[k] = input.value;
          preview.textContent = fillTemplate(template, fields);
        });
        form.append(h("label", { class: "field" }, h("span", { class: "field-label" }, LABELS[k] ?? k), input));
      }
      preview.textContent = fillTemplate(template, fields);
    };

    tplSel.addEventListener("change", async () => {
      current = tplSel.value;
      template = await api.coverTemplateRead(current);
      draw();
    });

    const editTemplate = async (asNew: boolean) => {
      const em = modal(asNew ? "表紙テンプレートを新規作成" : `表紙テンプレートを編集: ${current}`, { wide: true });
      const nameInput = h("input", { class: "input", type: "text", value: asNew ? "" : current, placeholder: "テンプレート名" });
      const ta = h("textarea", { class: "input code", rows: 20, spellcheck: false });
      ta.value = template;
      em.body.append(
        h("label", { class: "field" }, h("span", { class: "field-label" }, "名前"), nameInput),
        h("div", { class: "hint" }, "LaTeX で自由に書けます。<<title>> <<experiment>> <<date>> <<studentId>> <<name>> <<partners>> のほか、<<好きな英字名>> を書くとフォームの入力欄が増えます。"),
        ta,
      );
      em.footer.append(
        h("button", { class: "btn", onclick: em.close }, "キャンセル"),
        h("button", {
          class: "btn primary",
          onclick: async () => {
            const name = nameInput.value.trim();
            if (!name) return toast("テンプレート名を入力してください", "error");
            try {
              await api.coverTemplateWrite(name, ta.value);
              names = await api.coverTemplates();
              current = name;
              template = ta.value;
              em.close();
              draw();
              toast(`テンプレート「${name}」を保存しました`, "ok");
            } catch (e) {
              showError(e);
            }
          },
        }, "保存"),
      );
    };

    m.body.append(
      h("div", { class: "cover-grid" },
        h("div", null,
          h("div", { class: "btn-row" },
            h("span", { class: "field-label" }, "テンプレート"),
            tplSel,
            h("button", { class: "btn small", onclick: () => void editTemplate(false) }, "編集"),
            h("button", { class: "btn small", onclick: () => void editTemplate(true) }, "複製して新規"),
            h("button", {
              class: "btn small",
              onclick: async () => {
                if (!current || !(await confirmBox("テンプレートの削除", `テンプレート「${current}」を削除します。`, "削除"))) return;
                await api.coverTemplateDelete(current);
                names = await api.coverTemplates();
                current = names[0] ?? "";
                template = current ? await api.coverTemplateRead(current) : "";
                draw();
              },
            }, "削除"),
          ),
          form,
        ),
        h("div", null, h("div", { class: "field-label" }, "生成される cover.tex"), preview),
      ),
    );
    m.footer.append(
      h("button", {
        class: "btn",
        title: "氏名・学籍番号などを設定フォルダに保存し、次の実験から自動で入るようにします",
        onclick: async () => {
          const next = { ...defaults };
          for (const k of placeholders(template)) if (PERSONAL.includes(k)) next[k] = fields[k] ?? "";
          await api.settingsWrite("defaults", next);
          toast("氏名・学籍番号などを既定値として保存しました", "ok");
        },
      }, "氏名などを既定値として保存"),
      h("span", { class: "spacer" }),
      h("button", { class: "btn", onclick: m.close }, "閉じる"),
      h("button", {
        class: "btn primary",
        onclick: async () => {
          try {
            project.cover = { template: current, fields: { ...fields } };
            saveProject();
            await api.writeText(S.dir, "cover.tex", fillTemplate(template, fields));
            const lines = (await getFileText(mainFile())).split("\n");
            if (ensureCoverInput(lines)) {
              await setFileText(mainFile(), lines.join("\n"));
              toast("cover.tex を書き出し、本文の先頭に \\input{cover} を挿入しました", "ok");
            } else {
              requestCompile();
              toast("cover.tex を更新しました", "ok");
            }
            await refreshTree();
            m.close();
          } catch (e) {
            showError(e);
          }
        },
      }, "表紙を書き出して本文に挿入"),
    );
    draw();
  } catch (e) {
    showError(e);
  }
}

