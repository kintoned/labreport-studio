//! SyncTeX（TeX Live 付属の synctex コマンド）で PDF 上の位置とソース行を対応付ける。

use crate::latex;
use crate::util::{self, R};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone, Debug)]
pub struct SourcePos {
    pub file: String,
    pub line: u32,
    pub column: i32,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct PdfBox {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub h: f64,
    pub v: f64,
    #[serde(rename = "W")]
    pub w: f64,
    #[serde(rename = "H")]
    pub height: f64,
}

fn run(project_dir: &Path, args: &[String]) -> R<String> {
    let out = util::command(util::tex_bin("synctex"))
        .current_dir(project_dir)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("synctex を起動できませんでした ({e})"))?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// SyncTeX が記録している入力ファイル名の一覧
fn inputs(work_root: &Path, project_dir: &Path, main_rel: &str) -> Vec<String> {
    let pdf = latex::preview_pdf_path(work_root, project_dir, main_rel);
    let Ok(bytes) = std::fs::read(pdf.with_extension("synctex")) else { return vec![] };
    let mut v = Vec::new();
    for l in String::from_utf8_lossy(&bytes).lines() {
        if let Some(rest) = l.strip_prefix("Input:") {
            if let Some((_, path)) = rest.split_once(':') {
                v.push(path.to_string());
            }
        } else if l.starts_with('{') || l.starts_with("Content:") {
            break;
        }
    }
    v
}

fn normalize(project_dir: &Path, path: &str) -> String {
    let p = util::slashes(path).replace("/./", "/");
    let d = util::slashes(&project_dir.to_string_lossy());
    let p = if p.to_lowercase().starts_with(&d.to_lowercase()) { p[d.len()..].to_string() } else { p };
    let mut p = p.trim_start_matches('/').to_string();
    while let Some(r) = p.strip_prefix("./") {
        p = r.to_string();
    }
    p
}

/// PDF 上の点（ページ左上原点、単位 bp）→ ソース位置
pub fn edit(work_root: &Path, project_dir: &Path, main_rel: &str, page: u32, x: f64, y: f64) -> R<Option<SourcePos>> {
    let pdf = latex::preview_pdf_path(work_root, project_dir, main_rel);
    let out = run(project_dir, &["edit".into(), "-o".into(), format!("{page}:{x:.2}:{y:.2}:{}", pdf.display())])?;
    let (mut file, mut line, mut column) = (None, None, -1);
    for l in out.lines() {
        if let Some(v) = l.strip_prefix("Input:") {
            if file.is_some() {
                break;
            }
            file = Some(v.to_string());
        } else if let Some(v) = l.strip_prefix("Line:") {
            line = v.trim().parse::<u32>().ok();
        } else if let Some(v) = l.strip_prefix("Column:") {
            column = v.trim().parse::<i32>().unwrap_or(-1);
        }
    }
    let (Some(file), Some(line)) = (file, line) else { return Ok(None) };
    let mut rel = normalize(project_dir, &file);
    if !project_dir.join(&rel).exists() {
        // パスの文字化けなどで解決できないときはファイル名で探す
        let base = rel.rsplit('/').next().unwrap_or("").to_string();
        rel = if project_dir.join(&base).exists() { base } else { main_rel.to_string() };
    }
    Ok(Some(SourcePos { file: rel, line, column }))
}

/// ソース行 → PDF 上の箱
pub fn view(work_root: &Path, project_dir: &Path, main_rel: &str, file_rel: &str, line: u32) -> R<Vec<PdfBox>> {
    let pdf = latex::preview_pdf_path(work_root, project_dir, main_rel);
    let want = util::slashes(file_rel).to_lowercase();
    let input = inputs(work_root, project_dir, main_rel)
        .into_iter()
        .find(|p| normalize(project_dir, p).to_lowercase() == want)
        .unwrap_or_else(|| project_dir.join(file_rel).to_string_lossy().into_owned());
    let out = run(
        project_dir,
        &["view".into(), "-i".into(), format!("{line}:0:{input}"), "-o".into(), pdf.display().to_string()],
    )?;
    let mut boxes: Vec<PdfBox> = Vec::new();
    for l in out.lines() {
        let Some((k, v)) = l.split_once(':') else { continue };
        if k == "Page" {
            boxes.push(PdfBox { page: v.trim().parse().unwrap_or(0), ..Default::default() });
            continue;
        }
        let (Some(b), Ok(f)) = (boxes.last_mut(), v.trim().parse::<f64>()) else { continue };
        match k {
            "x" => b.x = f,
            "y" => b.y = f,
            "h" => b.h = f,
            "v" => b.v = f,
            "W" => b.w = f,
            "H" => b.height = f,
            _ => {}
        }
    }
    Ok(boxes)
}
