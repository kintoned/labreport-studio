# 実験レポート統括ソフト (LabReport Studio)

実験データ (CSV) の取り込み、グラフの作成・直接編集、フィッティング、理論式の重ね描き、
LaTeX レポートの編集と PDF プレビューを 1 つにまとめた Windows 用デスクトップアプリ。
グラフや PDF を画面上で直接編集すると、その変更がソース（図設定 JSON / LaTeX）へ書き戻される。

- Tauri 2（バックエンド Rust、フロントエンド TypeScript、フレームワーク無し）
- LaTeX はユーザー環境の TeX Live（LuaLaTeX）。図は pgfplots のコードとして保持
- PDF 表示は pdf.js、PDF ↔ ソースの対応付けは SyncTeX
- AI 機能は無し

## 使い方

1. **新規プロジェクト** … 実験名を入れ、フォルダを作る場所（Google Drive の同期フォルダなど）を選ぶ
2. **データ ＋ CSV** … 表のプレビュー上で見出し行・データ開始行・読み飛ばす行をクリックで指定し、
   列ごとに量の名前と単位を入れて「取り込む」。設定はテンプレート保存でき、同じ見出しの CSV には自動適用
3. **図 ＋ 新しい図** … グラフ上の系列・軸・凡例をクリックすると右のパネルに項目が出る。
   ラベルと凡例名はダブルクリックでその場で書き換え。Ctrl+Z / Ctrl+Y で元に戻す・やり直す
4. **＋ フィット / ＋ 理論式** … 一次・多項式・指数・対数・べき乗。範囲は「ドラッグで指定」。
   「マクロ名の接頭辞」を入れると係数・誤差・R² が `values.tex` に書き出される（例 `\ohmSlope`）
5. 本文に `\includegraphics[width=0.8\linewidth]{figures/fig1.pdf}` を書いて **保存 (Ctrl+S)** → 自動コンパイル
6. **PDF 上で編集** … 図をクリックするとグラフ編集が開き、角のハンドルで `width` を変更、
   ツールバーで配置 (h/t/b/p/H) と段落間の移動。本文はダブルクリックでその段落のソースを編集
7. **表紙** … テンプレートを選びフォームに入力 → `cover.tex` を書き出し `\input{cover}` を挿入

## プロジェクトフォルダ

```
実験名/
  project.json     データの取り込み設定など（パスはすべて相対）
  data/            元 CSV（アプリは決して書き換えない）
  figures/         図設定 NAME.json と、生成される NAME.tex / NAME.pdf
  values.tex       数値マクロ（自動生成）
  main.tex         本文（自由に書く。テンプレートを押しつけない）
  cover.tex        表紙（フォームから生成）
  main.pdf         完成 PDF
```

コンパイルの中間ファイル（.aux .log .synctex、図のキャッシュ）は同期フォルダに置かず、
`%LOCALAPPDATA%\io.github.kintoned.labreport-studio\work\` に出力する。

CSV テンプレート・グラフスタイル・表紙テンプレート・氏名などの既定値は「設定フォルダ」に保存される。
**設定 → フォルダを変更** で同期フォルダを指定すれば、どの PC でも同じ設定になる。

## 開発

必要なもの: Node.js、Rust (stable, MSVC)、Visual Studio Build Tools (C++)、TeX Live。

```bash
npm install
npm run app:dev      # 開発モード（ホットリロード）
npm run app:build    # インストーラ作成（下記の署名鍵が必要）
npm test             # ソース書き換えと Rust の単体テスト
npm test -- --test pipeline -- --ignored   # LuaLaTeX を使う結合テスト（--lib に加えて実行）
```

`npm run app:*` は Rust のビルド成果物を `%LOCALAPPDATA%\labreport-studio-build\target` に出すので、
ソースを OneDrive / Google Drive 上に置いても巨大な `target/` は同期されない。

### 構成

| 場所 | 内容 |
| --- | --- |
| `src-tauri/src/csvio.rs` | 文字コード・区切り文字の判定、CSV の読み込み |
| `src-tauri/src/fit.rs` | 最小二乗フィット（QR 分解、Levenberg–Marquardt） |
| `src-tauri/src/expr.rs` | 理論式の構文解析・評価・LaTeX 化 |
| `src-tauri/src/figure.rs` | 図設定のモデル、系列・軸・誤差率の計算、values.tex |
| `src-tauri/src/pgf.rs` | pgfplots コード生成 |
| `src-tauri/src/latex.rs` | LuaLaTeX 実行、ログ解析、図 PDF のキャッシュ |
| `src-tauri/src/synctex.rs` | SyncTeX による PDF ↔ ソース対応 |
| `src/graph*.ts` | グラフ直接編集ビュー（SVG）とプロパティパネル |
| `src/pdfview.ts` `src/pdfedit.ts` `src/sourceops.ts` | PDF プレビューと PDF 直接編集（ソース書き換え） |
| `src/csvimport.ts` `src/cover.ts` `src/settings.ts` | CSV 取り込み、表紙、設定 |

## 配布とアップデート

- バージョンタグを push すると GitHub Actions (`.github/workflows/release.yml`) が Windows 用インストーラを
  ビルドして GitHub Releases に公開する
- アプリは起動時に `releases/latest/download/latest.json` を確認し、新しい版があれば通知 → ワンクリックで更新。
  更新ファイルは `tauri.conf.json` の公開鍵で署名検証される
- 各 PC は最初に 1 回インストーラを実行すれば、以後は自動で最新版に追従する

リリース手順:

```bash
npm run bump -- 0.2.0
git commit -am "v0.2.0"
git tag v0.2.0
git push --follow-tags
```

初回だけ、リポジトリの Secrets に署名鍵を登録する（鍵は `~/.tauri/labreport-studio.key`。**リポジトリには入れない**。
失くすと既存のインストール先へ更新を配れなくなるので、安全な場所に控えを取ること）。

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/labreport-studio.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body ""
```

自動更新は公開リポジトリの Releases を前提にしている（非公開リポジトリでは認証無しでダウンロードできない）。
リポジトリ名を変える場合は `src-tauri/tauri.conf.json` の `plugins.updater.endpoints` も合わせる。
