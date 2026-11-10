// 設定ダイアログ: 設定フォルダの場所（同期フォルダに置けば全 PC で共有）、氏名などの既定値、更新確認。

import { open } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { S } from "./state";
import { checkUpdate } from "./updater";
import { clear, h, modal, showError, toast } from "./ui";

export async function openSettings(): Promise<void> {
  const m = modal("設定", { wide: true });
  const draw = async () => {
    S.info = await api.appInfo();
    const info = S.info;
    const defaults = (await api.settingsRead<Record<string, string>>("defaults")) ?? {};
    clear(m.body);
    const field = (key: string, label: string) => {
      const input = h("input", { class: "input", type: "text", value: defaults[key] ?? "" });
      input.addEventListener("change", async () => {
        defaults[key] = input.value;
        await api.settingsWrite("defaults", defaults).catch(showError);
      });
      return h("label", { class: "field" }, h("span", { class: "field-label" }, label), input);
    };
    m.body.append(
      h("div", { class: "panel-title" }, "設定フォルダ"),
      h("p", { class: "hint" }, "CSV 取り込みテンプレート・グラフスタイル・表紙テンプレート・既定値を保存する場所です。Google Drive などの同期フォルダを指定すると、どの PC でも同じ設定を使えます。"),
      h("div", { class: "path-box" }, info.settingsDir, !info.customSettingsDir && h("span", { class: "tag" }, "既定（この PC のみ）")),
      h("div", { class: "btn-row" },
        h("button", {
          class: "btn",
          onclick: async () => {
            const dir = await open({ directory: true, title: "設定フォルダを選択" });
            if (typeof dir !== "string") return;
            await api.setSettingsDir(dir);
            toast("設定フォルダを変更しました", "ok");
            await draw();
          },
        }, "フォルダを変更…"),
        info.customSettingsDir && h("button", {
          class: "btn",
          onclick: async () => {
            await api.setSettingsDir(null);
            await draw();
          },
        }, "既定の場所に戻す"),
      ),
      h("div", { class: "panel-title" }, "既定値（表紙に自動入力）"),
      field("name", "氏名"),
      field("studentId", "学籍番号"),
      field("department", "学部・学科"),
      field("title", "タイトル（科目名など）"),
      h("div", { class: "panel-title" }, "作業フォルダ（この PC のみ）"),
      h("p", { class: "hint" }, "コンパイルの中間ファイル（.aux .log .synctex、図のキャッシュ）はここに置かれ、同期フォルダには書き込みません。削除しても次のコンパイルで作り直されます。"),
      h("div", { class: "path-box" }, info.workDir),
      h("div", { class: "panel-title" }, "バージョン"),
      h("div", { class: "btn-row" },
        h("span", null, `実験レポート統括ソフト  v${info.version}`),
        h("button", { class: "btn", onclick: () => void checkUpdate(true) }, "更新を確認"),
      ),
    );
  };
  m.footer.append(h("button", { class: "btn primary", onclick: m.close }, "閉じる"));
  await draw().catch(showError);
}
