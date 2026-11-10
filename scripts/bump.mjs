// バージョンを 3 か所（package.json / tauri.conf.json / Cargo.toml）まとめて書き換える。
//   npm run bump -- 0.2.0
// その後:  git commit -am "v0.2.0" && git tag v0.2.0 && git push --follow-tags
import fs from "node:fs";

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) {
  console.error("使い方: npm run bump -- <major.minor.patch>");
  process.exit(1);
}
const json = (p) => {
  const t = fs.readFileSync(p, "utf8");
  fs.writeFileSync(p, t.replace(/("version":\s*")\d+\.\d+\.\d+(")/, `$1${v}$2`));
};
json("package.json");
json("src-tauri/tauri.conf.json");
const cargo = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
fs.writeFileSync("src-tauri/Cargo.toml", cargo.replace(/^version = "\d+\.\d+\.\d+"/m, `version = "${v}"`));
console.log(`version -> ${v}`);
