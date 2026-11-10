//! 設定の保存場所。
//! - PC ごとの設定（設定フォルダの場所、最近開いたプロジェクト）: アプリの設定フォルダ内 local.json
//! - 共有したい設定（CSV テンプレート、グラフスタイル、表紙テンプレート、既定値）: ユーザーが指定できる
//!   「設定フォルダ」。同期フォルダに置けば全 PC で同じ設定になる。

use crate::util::{self, R};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Local {
    pub settings_dir: Option<String>,
    pub recent: Vec<String>,
}

pub fn load_local(config_dir: &Path) -> Local {
    std::fs::read_to_string(config_dir.join("local.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_local(config_dir: &Path, l: &Local) -> R<()> {
    let s = serde_json::to_string_pretty(l).map_err(|e| e.to_string())?;
    util::write_if_changed(&config_dir.join("local.json"), s.as_bytes())?;
    Ok(())
}

pub fn settings_dir(config_dir: &Path) -> PathBuf {
    match load_local(config_dir).settings_dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => config_dir.join("settings"),
    }
}

pub fn add_recent(config_dir: &Path, dir: &str) {
    let mut l = load_local(config_dir);
    l.recent.retain(|d| !d.eq_ignore_ascii_case(dir));
    l.recent.insert(0, dir.to_string());
    l.recent.truncate(12);
    let _ = save_local(config_dir, &l);
}

fn key_ok(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn read(config_dir: &Path, name: &str) -> R<Value> {
    if !key_ok(name) {
        return Err("設定名が不正です".into());
    }
    let p = settings_dir(config_dir).join(format!("{name}.json"));
    if !p.exists() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&util::read_text(&p)?).map_err(|e| format!("{name}.json を読めません: {e}"))
}

pub fn write(config_dir: &Path, name: &str, value: &Value) -> R<()> {
    if !key_ok(name) {
        return Err("設定名が不正です".into());
    }
    let s = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    util::write_if_changed(&settings_dir(config_dir).join(format!("{name}.json")), s.as_bytes())?;
    Ok(())
}

const COVER_STANDARD: &str = r"% 表紙テンプレート: 標準
% <<キー>> がフォームの入力値に置き換わります。
\begin{titlepage}
  \centering
  \vspace*{30mm}
  {\LARGE <<title>> \par}
  \vspace{12mm}
  {\huge\bfseries <<experiment>> \par}
  \vfill
  \begin{tabular}{rl}
    実験日 & <<date>> \\[2mm]
    学籍番号 & <<studentId>> \\[2mm]
    氏名 & <<name>> \\[2mm]
    共同実験者 & <<partners>> \\
  \end{tabular}
  \vspace{30mm}
\end{titlepage}
";

const COVER_SIMPLE: &str = r"% 表紙テンプレート: 簡易（本文と同じページの先頭に置く見出し）
\begin{center}
  {\Large\bfseries <<experiment>> \par}
  \vspace{3mm}
  <<title>> \par
  \vspace{2mm}
  <<date>> \quad <<studentId>> \quad <<name>> \par
  共同実験者: <<partners>>
\end{center}
\vspace{5mm}
";

fn covers_dir(config_dir: &Path) -> PathBuf {
    let d = settings_dir(config_dir).join("cover_templates");
    if !d.exists() && std::fs::create_dir_all(&d).is_ok() {
        let _ = std::fs::write(d.join("標準.tex"), COVER_STANDARD);
        let _ = std::fs::write(d.join("簡易.tex"), COVER_SIMPLE);
    }
    d
}

pub fn cover_list(config_dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(covers_dir(config_dir))
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".tex").map(String::from)))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

pub fn cover_read(config_dir: &Path, name: &str) -> R<String> {
    if !util::valid_name(name) {
        return Err("テンプレート名が不正です".into());
    }
    util::read_text(&covers_dir(config_dir).join(format!("{name}.tex")))
}

pub fn cover_write(config_dir: &Path, name: &str, text: &str) -> R<()> {
    if !util::valid_name(name) {
        return Err("テンプレート名に使えない文字が含まれています".into());
    }
    util::write_if_changed(&covers_dir(config_dir).join(format!("{name}.tex")), text.as_bytes())?;
    Ok(())
}

pub fn cover_delete(config_dir: &Path, name: &str) -> R<()> {
    if !util::valid_name(name) {
        return Err("テンプレート名が不正です".into());
    }
    std::fs::remove_file(covers_dir(config_dir).join(format!("{name}.tex"))).map_err(|e| e.to_string())
}
