//! LuaLaTeX の実行とログ解析。中間ファイルはすべて PC ローカルの作業フォルダへ出す。

use crate::csvio::DatasetCfg;
use crate::figure::{self, Computed, Figure};
use crate::pgf;
use crate::util::{self, R};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Serialize, Clone, Debug)]
pub struct TexError {
    pub file: String,
    pub line: u32,
    pub message: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    pub ok: bool,
    pub errors: Vec<TexError>,
    pub warnings: Vec<String>,
    pub log_tail: String,
    pub duration_ms: u64,
    pub pdf_exists: bool,
    pub runs: u32,
}

pub fn work_dir(work_root: &Path, project_dir: &Path) -> PathBuf {
    let key = project_dir.to_string_lossy().to_lowercase().replace('\\', "/");
    work_root.join("work").join(util::hash_hex(key.trim_end_matches('/').as_bytes()))
}

fn stem(file: &str) -> String {
    Path::new(file).file_stem().and_then(|s| s.to_str()).unwrap_or("main").to_string()
}

fn run_lualatex(cwd: &Path, outdir: &Path, file: &str, synctex: bool) -> R<(bool, String)> {
    std::fs::create_dir_all(outdir).map_err(|e| format!("作業フォルダを作成できません: {e}"))?;
    let mut c = util::command(util::tex_bin("lualatex"));
    c.current_dir(cwd)
        .arg("-interaction=nonstopmode")
        .arg("-file-line-error")
        .arg("-no-shell-escape");
    if synctex {
        c.arg("-synctex=-1"); // 非圧縮: ローカルにしか置かないので読みやすさ優先
    }
    c.arg(format!("-output-directory={}", outdir.display()))
        .arg(file)
        .env("max_print_line", "10000")
        .env("error_line", "254")
        .env("half_error_line", "238")
        .stdin(std::process::Stdio::null());
    let out = c.output().map_err(|e| {
        format!("LuaLaTeX を起動できませんでした。TeX Live がインストールされ、PATH が通っているか確認してください。({e})")
    })?;
    let log_path = outdir.join(format!("{}.log", stem(file)));
    let log = std::fs::read(&log_path)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_else(|_| String::from_utf8_lossy(&out.stdout).into_owned());
    Ok((out.status.success(), log))
}

fn split_file_line(line: &str) -> Option<(String, u32, String)> {
    // "<file>:<line>: <message>"（Windows のドライブ文字 "C:" を含みうる）
    let mut from = 0;
    while let Some(rel) = line[from..].find(": ") {
        let pos = from + rel;
        let head = &line[..pos];
        if let Some(c) = head.rfind(':') {
            let (file, n) = (&head[..c], &head[c + 1..]);
            if !file.is_empty() && !n.is_empty() && n.chars().all(|d| d.is_ascii_digit()) && file.contains('.') {
                return Some((file.to_string(), n.parse().ok()?, line[pos + 2..].to_string()));
            }
        }
        from = pos + 2;
    }
    None
}

fn rel_file(project_dir: &Path, file: &str) -> String {
    let f = util::slashes(file);
    let d = util::slashes(&project_dir.to_string_lossy());
    let f = if f.to_lowercase().starts_with(&d.to_lowercase()) { f[d.len()..].to_string() } else { f };
    let mut f = f.trim_start_matches('/').to_string();
    while let Some(r) = f.strip_prefix("./") {
        f = r.to_string();
    }
    f
}

pub fn parse_log(project_dir: &Path, log: &str) -> (Vec<TexError>, Vec<String>) {
    let lines: Vec<&str> = log.lines().collect();
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        if let Some((file, line, mut msg)) = split_file_line(l) {
            // 直後の "l.12 \foo" を文脈として付ける
            for next in lines.iter().skip(i + 1).take(8) {
                if let Some(rest) = next.strip_prefix("l.") {
                    let ctx = rest.trim_start_matches(|c: char| c.is_ascii_digit()).trim();
                    if !ctx.is_empty() {
                        msg.push_str(&format!("  ⟶ {ctx}"));
                    }
                    break;
                }
            }
            errors.push(TexError { file: rel_file(project_dir, &file), line, message: msg });
        } else if let Some(m) = l.strip_prefix("! ") {
            if !m.starts_with("Emergency stop") && !m.starts_with(" ==>") {
                errors.push(TexError { file: String::new(), line: 0, message: m.to_string() });
            }
        } else if (l.starts_with("LaTeX Warning:") || (l.starts_with("Package ") && l.contains(" Warning:")))
            && warnings.len() < 50
        {
            warnings.push(l.to_string());
        }
    }
    (errors, warnings)
}

fn tail(log: &str, n: usize) -> String {
    let v: Vec<&str> = log.lines().collect();
    v[v.len().saturating_sub(n)..].join("\n")
}

/// 本文をコンパイルする。cwd はプロジェクトフォルダ、出力はローカル作業フォルダ。
/// 成功したら完成 PDF だけをプロジェクトへコピーする。
pub fn compile_main(work_root: &Path, project_dir: &Path, main_rel: &str) -> R<CompileResult> {
    let t0 = Instant::now();
    util::join_rel(project_dir, main_rel)?;
    if !project_dir.join(main_rel).exists() {
        return Err(format!("{main_rel} がプロジェクトにありません"));
    }
    let out = work_dir(work_root, project_dir);
    let mut runs = 0;
    let (mut status, mut log);
    loop {
        (status, log) = run_lualatex(project_dir, &out, main_rel, true)?;
        runs += 1;
        let rerun = log.contains("Rerun to get") || log.contains("Rerun LaTeX") || log.contains("rerunfilecheck Warning");
        if !rerun || runs >= 3 || log.contains("Fatal error") {
            break;
        }
    }
    let (mut errors, warnings) = parse_log(project_dir, &log);
    let pdf = out.join(format!("{}.pdf", stem(main_rel)));
    let pdf_exists = pdf.exists();
    if !status && errors.is_empty() {
        errors.push(TexError { file: String::new(), line: 0, message: "LuaLaTeX が異常終了しました（ログを確認してください）".into() });
    }
    let ok = errors.is_empty() && pdf_exists;
    if ok {
        if let Ok(bytes) = std::fs::read(&pdf) {
            let dest = project_dir.join(format!("{}.pdf", stem(main_rel)));
            // 完成 PDF を開いているビューアがロックしていても、プレビューは続行する
            let _ = util::write_if_changed(&dest, &bytes);
        }
    }
    Ok(CompileResult {
        ok,
        errors,
        warnings,
        log_tail: tail(&log, 60),
        duration_ms: t0.elapsed().as_millis() as u64,
        pdf_exists,
        runs,
    })
}

pub fn preview_pdf_path(work_root: &Path, project_dir: &Path, main_rel: &str) -> PathBuf {
    work_dir(work_root, project_dir).join(format!("{}.pdf", stem(main_rel)))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuildResult {
    pub computed: Computed,
    pub tex: String,
    pub pdf_changed: bool,
    pub values_changed: bool,
    pub errors: Vec<TexError>,
    pub log_tail: String,
    pub cached: bool,
}

fn wrapper(body_file: &str, japanese: bool) -> String {
    format!(
        "\\documentclass[border=3pt]{{standalone}}\n{}\\usepackage{{pgfplots}}\n\\pgfplotsset{{compat=1.18}}\n\\begin{{document}}\n\\input{{{body_file}}}\n\\end{{document}}\n",
        if japanese { "\\usepackage{luatexja}\n" } else { "" }
    )
}

/// 図を保存し、pgfplots コードを再生成し、内容が変わっていれば PDF を作り直す。
pub fn build_figure(
    work_root: &Path,
    project_dir: &Path,
    datasets: &[DatasetCfg],
    name: &str,
    figure_json: &serde_json::Value,
) -> R<BuildResult> {
    if !util::valid_name(name) {
        return Err(format!("図の名前に使えない文字が含まれています: {name}"));
    }
    let fig: Figure = serde_json::from_value(figure_json.clone()).map_err(|e| format!("図設定が不正です: {e}"))?;
    let figs = project_dir.join("figures");
    let json = serde_json::to_string_pretty(figure_json).map_err(|e| e.to_string())?;
    util::write_if_changed(&figs.join(format!("{name}.json")), json.as_bytes())?;

    let computed = figure::compute(project_dir, datasets, &fig);
    let tex = pgf::generate(&fig, &computed);
    util::write_if_changed(&figs.join(format!("{name}.tex")), tex.as_bytes())?;

    let values = figure::values_tex(project_dir, datasets);
    let values_changed = util::write_if_changed(&project_dir.join("values.tex"), values.as_bytes())?;

    // --- PDF キャッシュ ---
    let fwork = work_dir(work_root, project_dir).join("figs");
    std::fs::create_dir_all(&fwork).map_err(|e| format!("作業フォルダを作成できません: {e}"))?;
    let job = format!("fig_{}", util::hash_hex(name.as_bytes()));
    let body = format!("{job}_body.tex");
    let wrap = wrapper(&body, !tex.is_ascii());
    let hash = util::hash_hex(format!("{wrap}\u{0}{tex}").as_bytes());
    let hash_file = fwork.join(format!("{job}.hash"));
    let dest = figs.join(format!("{name}.pdf"));
    if dest.exists() && std::fs::read_to_string(&hash_file).map_or(false, |h| h == hash) {
        return Ok(BuildResult { computed, tex, pdf_changed: false, values_changed, errors: vec![], log_tail: String::new(), cached: true });
    }
    std::fs::write(fwork.join(&body), &tex).map_err(|e| e.to_string())?;
    let wrap_file = format!("{job}.tex");
    std::fs::write(fwork.join(&wrap_file), &wrap).map_err(|e| e.to_string())?;
    let built = fwork.join(format!("{job}.pdf"));
    let _ = std::fs::remove_file(&built);
    let (status, log) = run_lualatex(&fwork, &fwork, &wrap_file, false)?;
    let (mut errors, _) = parse_log(&fwork, &log);
    for e in errors.iter_mut() {
        e.file = format!("figures/{name}.tex");
    }
    if (!status || !built.exists()) && errors.is_empty() {
        errors.push(TexError { file: format!("figures/{name}.tex"), line: 0, message: "図の PDF を生成できませんでした".into() });
    }
    let mut pdf_changed = false;
    if errors.is_empty() {
        let bytes = std::fs::read(&built).map_err(|e| e.to_string())?;
        pdf_changed = util::write_if_changed(&dest, &bytes)?;
        let _ = std::fs::write(&hash_file, &hash);
    }
    Ok(BuildResult { computed, tex, pdf_changed, values_changed, errors, log_tail: tail(&log, 40), cached: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_parsing() {
        let log = "(./main.tex\n./main.tex:12: Undefined control sequence.\nl.12 \\foo\n         bar\nC:/proj/sub/a.tex:3: LaTeX Error: Environment x undefined.\n\nLaTeX Warning: Reference `a' on page 1 undefined on input line 4.\n! Emergency stop.\n";
        let (e, w) = parse_log(Path::new("C:\\proj"), log);
        assert_eq!(e.len(), 2);
        assert_eq!((e[0].file.as_str(), e[0].line), ("main.tex", 12));
        assert!(e[0].message.contains("\\foo"));
        assert_eq!((e[1].file.as_str(), e[1].line), ("sub/a.tex", 3));
        assert_eq!(w.len(), 1);
    }
}
