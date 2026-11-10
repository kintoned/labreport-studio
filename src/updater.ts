// 自動アップデート: 起動時に GitHub Releases の最新版を確認し、ワンクリックで更新する。
// 更新ファイルは tauri.conf.json の公開鍵で署名検証される。

import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { errText, toast } from "./ui";

let busy = false;

export async function checkUpdate(manual = false): Promise<void> {
  if (busy) return;
  try {
    const update = await check();
    if (!update) {
      if (manual) toast("最新版を使用しています", "ok");
      return;
    }
    toast(`新しいバージョン ${update.version} があります`, "info", {
      label: "更新して再起動",
      run: () => {
        busy = true;
        const t = toast("更新をダウンロードしています…", "info", undefined, 0);
        let total = 0;
        let done = 0;
        update
          .downloadAndInstall((ev) => {
            if (ev.event === "Started") total = ev.data.contentLength ?? 0;
            else if (ev.event === "Progress") {
              done += ev.data.chunkLength;
              const msg = t.querySelector(".toast-msg");
              if (msg && total) msg.textContent = `更新をダウンロードしています… ${Math.round((done / total) * 100)} %`;
            }
          })
          .then(() => relaunch())
          .catch((e) => {
            busy = false;
            t.remove();
            toast(`更新に失敗しました: ${errText(e)}`, "error");
          });
      },
    }, 0);
  } catch (e) {
    // リリースがまだ無い・オフライン等。起動時の自動確認では黙っておく。
    if (manual) toast(`更新を確認できませんでした: ${errText(e)}`, "error");
  }
}
