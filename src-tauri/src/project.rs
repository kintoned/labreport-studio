//! 実験プロジェクト（1 実験 = 1 フォルダ）の作成・読み込み。
//! プロジェクト内のパスはすべて相対パスで持つ。data/ の元データは決して書き換えない。

use crate::util::{self, R};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;

const DEFAULT_MAIN: &str = r"\documentclass[11pt,a4paper]{ltjsarticle}
\usepackage{graphicx}
\usepackage{amsmath}
\usepackage{siunitx}
\usepackage{float}
\input{values} % ソフトが書き出す数値マクロ

\begin{document}

\section{目的}

ここに本文を書く。

\section{結果}

図は左の「図」で作成し、次のように読み込む。

% \begin{figure}[htbp]
%   \centering
%   \includegraphics[width=0.8\linewidth]{figures/fig1.pdf}
%   \caption{測定結果}
%   \label{fig:fig1}
% \end{figure}

\end{document}
";

#[derive(Serialize, Clone, Debug, Default)]
pub struct Tree {
    pub data: Vec<String>,
    pub figures: Vec<String>,
    pub tex: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProjectInfo {
    pub dir: String,
    pub project: Value,
    pub tree: Tree,
}

fn list(dir: &Path, ext: &[&str], strip: bool) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().map_or(false, |t| t.is_file()))
                .filter_map(|e| e.file_name().to_str().map(String::from))
                .filter_map(|n| {
                    let lower = n.to_lowercase();
                    let hit = ext.iter().find(|x| lower.ends_with(&format!(".{x}")))?;
                    Some(if strip { n[..n.len() - hit.len() - 1].to_string() } else { n })
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort_by_key(|a| a.to_lowercase());
    v
}

pub fn tree(dir: &Path) -> Tree {
    Tree {
        data: list(&dir.join("data"), &["csv", "txt", "tsv", "dat"], false),
        figures: list(&dir.join("figures"), &["json"], true),
        tex: list(dir, &["tex"], false),
    }
}

pub fn create(dir: &Path, name: &str) -> R<ProjectInfo> {
    if dir.join("project.json").exists() {
        return Err("このフォルダには既にプロジェクトがあります。「開く」を使ってください。".into());
    }
    for sub in ["data", "figures"] {
        std::fs::create_dir_all(dir.join(sub)).map_err(|e| format!("フォルダを作成できません: {e}"))?;
    }
    if !dir.join("main.tex").exists() {
        util::write_if_changed(&dir.join("main.tex"), DEFAULT_MAIN.as_bytes())?;
    }
    if !dir.join("values.tex").exists() {
        util::write_if_changed(&dir.join("values.tex"), "% 自動生成: 実験レポート統括ソフト\n".as_bytes())?;
    }
    let project = json!({ "version": 1, "name": name, "mainFile": "main.tex", "datasets": [], "cover": {} });
    save(dir, &project)?;
    open(dir)
}

pub fn open(dir: &Path) -> R<ProjectInfo> {
    let p = dir.join("project.json");
    if !p.exists() {
        return Err(format!("project.json がありません。実験プロジェクトのフォルダを選んでください: {}", dir.display()));
    }
    let text = util::read_text(&p)?;
    let project: Value = serde_json::from_str(&text).map_err(|e| format!("project.json を読めません: {e}"))?;
    Ok(ProjectInfo { dir: dir.to_string_lossy().into_owned(), project, tree: tree(dir) })
}

pub fn save(dir: &Path, project: &Value) -> R<()> {
    let s = serde_json::to_string_pretty(project).map_err(|e| e.to_string())?;
    util::write_if_changed(&dir.join("project.json"), s.as_bytes())?;
    Ok(())
}

/// 元 CSV を data/ にコピーする。既存ファイルは上書きせず、内容が違えば連番を付ける。
pub fn import_data(dir: &Path, src: &Path) -> R<String> {
    let bytes = util::read_bytes(src)?;
    let name = src.file_name().and_then(|n| n.to_str()).ok_or("ファイル名が不正です")?.to_string();
    let data = dir.join("data");
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.clone(), String::new()),
    };
    for i in 0..1000 {
        let cand = if i == 0 { name.clone() } else { format!("{stem}_{i}{ext}") };
        let dest = data.join(&cand);
        if dest.exists() {
            if std::fs::read(&dest).map_or(false, |b| b == bytes) {
                return Ok(format!("data/{cand}"));
            }
            continue;
        }
        std::fs::write(&dest, &bytes).map_err(|e| format!("コピーできませんでした: {e}"))?;
        return Ok(format!("data/{cand}"));
    }
    Err("同名のファイルが多すぎます".into())
}

pub fn read_text(dir: &Path, rel: &str) -> R<String> {
    util::read_text(&util::join_rel(dir, rel)?)
}

pub fn write_text(dir: &Path, rel: &str, text: &str) -> R<bool> {
    let norm = util::slashes(rel).to_lowercase();
    if norm.trim_start_matches("./").starts_with("data/") {
        return Err("data/ の元データは書き換えません".into());
    }
    util::write_if_changed(&util::join_rel(dir, rel)?, text.as_bytes())
}

pub fn delete_figure(dir: &Path, name: &str) -> R<()> {
    if !util::valid_name(name) {
        return Err("図の名前が不正です".into());
    }
    for ext in ["json", "tex", "pdf"] {
        let _ = std::fs::remove_file(dir.join("figures").join(format!("{name}.{ext}")));
    }
    Ok(())
}
