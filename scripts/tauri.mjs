// Tauri CLI のラッパー。
// ソースを OneDrive / Google Drive 等の同期フォルダに置いても、巨大な Rust の
// ビルド成果物 (target/) が同期されないよう、PC ローカルへ逃がす。
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const env = { ...process.env };
if (!env.CARGO_TARGET_DIR) {
  const base = env.LOCALAPPDATA || join(homedir(), ".cache");
  env.CARGO_TARGET_DIR = join(base, "labreport-studio-build", "target");
}
const cargoBin = join(homedir(), ".cargo", "bin");
env.PATH = `${cargoBin}${process.platform === "win32" ? ";" : ":"}${env.PATH ?? env.Path ?? ""}`;

const r = spawnSync("npx", ["tauri", ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
  shell: true,
});
process.exit(r.status ?? 1);
