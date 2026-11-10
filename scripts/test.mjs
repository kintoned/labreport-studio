// 単体テスト一式。Rust のビルド成果物は tauri.mjs と同じく PC ローカルへ出す。
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const env = { ...process.env };
env.CARGO_TARGET_DIR ||= join(env.LOCALAPPDATA || join(homedir(), ".cache"), "labreport-studio-build", "target");
env.PATH = `${join(homedir(), ".cargo", "bin")}${process.platform === "win32" ? ";" : ":"}${env.PATH ?? env.Path ?? ""}`;
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", env, shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run("node", ["scripts/test-sourceops.mjs"]);
run("cargo", ["test", "--lib", "--manifest-path", "src-tauri/Cargo.toml", ...process.argv.slice(2)]);
