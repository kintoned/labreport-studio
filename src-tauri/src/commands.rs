//! フロントエンドから呼ばれるコマンド。重い処理も UI を止めないよう、すべて別スレッドで実行する。

use crate::csvio::{self, DatasetCfg};
use crate::figure::{self, Computed, Figure};
use crate::util::{self, R};
use crate::{config, expr, latex, project, synctex};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

fn config_dir(app: &AppHandle) -> R<PathBuf> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

fn work_root(app: &AppHandle) -> R<PathBuf> {
    app.path().app_local_data_dir().map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    settings_dir: String,
    default_settings_dir: String,
    custom_settings_dir: bool,
    work_dir: String,
    recent: Vec<String>,
}

#[tauri::command(async)]
pub fn app_info(app: AppHandle) -> R<AppInfo> {
    let c = config_dir(&app)?;
    let l = config::load_local(&c);
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        settings_dir: config::settings_dir(&c).to_string_lossy().into_owned(),
        default_settings_dir: c.join("settings").to_string_lossy().into_owned(),
        custom_settings_dir: l.settings_dir.as_ref().map_or(false, |d| !d.trim().is_empty()),
        work_dir: work_root(&app)?.join("work").to_string_lossy().into_owned(),
        recent: l.recent.into_iter().filter(|d| Path::new(d).join("project.json").exists()).collect(),
    })
}

#[tauri::command(async)]
pub fn set_settings_dir(app: AppHandle, dir: Option<String>) -> R<()> {
    let c = config_dir(&app)?;
    let mut l = config::load_local(&c);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).map_err(|e| format!("設定フォルダを作成できません: {e}"))?;
    }
    l.settings_dir = dir;
    config::save_local(&c, &l)
}

#[tauri::command(async)]
pub fn settings_read(app: AppHandle, name: String) -> R<Value> {
    config::read(&config_dir(&app)?, &name)
}

#[tauri::command(async)]
pub fn settings_write(app: AppHandle, name: String, value: Value) -> R<()> {
    config::write(&config_dir(&app)?, &name, &value)
}

#[tauri::command(async)]
pub fn cover_templates(app: AppHandle) -> R<Vec<String>> {
    Ok(config::cover_list(&config_dir(&app)?))
}

#[tauri::command(async)]
pub fn cover_template_read(app: AppHandle, name: String) -> R<String> {
    config::cover_read(&config_dir(&app)?, &name)
}

#[tauri::command(async)]
pub fn cover_template_write(app: AppHandle, name: String, text: String) -> R<()> {
    config::cover_write(&config_dir(&app)?, &name, &text)
}

#[tauri::command(async)]
pub fn cover_template_delete(app: AppHandle, name: String) -> R<()> {
    config::cover_delete(&config_dir(&app)?, &name)
}

#[tauri::command(async)]
pub fn project_create(app: AppHandle, dir: String, name: String) -> R<project::ProjectInfo> {
    let info = project::create(Path::new(&dir), &name)?;
    config::add_recent(&config_dir(&app)?, &dir);
    Ok(info)
}

#[tauri::command(async)]
pub fn project_open(app: AppHandle, dir: String) -> R<project::ProjectInfo> {
    let info = project::open(Path::new(&dir))?;
    config::add_recent(&config_dir(&app)?, &dir);
    Ok(info)
}

#[tauri::command(async)]
pub fn project_save(dir: String, project: Value) -> R<()> {
    project::save(Path::new(&dir), &project)
}

#[tauri::command(async)]
pub fn project_tree(dir: String) -> R<project::Tree> {
    Ok(project::tree(Path::new(&dir)))
}

#[tauri::command(async)]
pub fn import_data(dir: String, src: String) -> R<String> {
    project::import_data(Path::new(&dir), Path::new(&src))
}

#[tauri::command(async)]
pub fn read_text(dir: String, rel: String) -> R<String> {
    project::read_text(Path::new(&dir), &rel)
}

#[tauri::command(async)]
pub fn write_text(dir: String, rel: String, text: String) -> R<bool> {
    project::write_text(Path::new(&dir), &rel, &text)
}

#[tauri::command(async)]
pub fn csv_preview(dir: String, rel: String, encoding: String, delimiter: String) -> R<csvio::Preview> {
    csvio::preview(&util::join_rel(Path::new(&dir), &rel)?, &encoding, &delimiter, 300)
}

#[tauri::command(async)]
pub fn figure_read(dir: String, name: String) -> R<Value> {
    if !util::valid_name(&name) {
        return Err("図の名前が不正です".into());
    }
    let text = util::read_text(&Path::new(&dir).join("figures").join(format!("{name}.json")))?;
    serde_json::from_str(&text).map_err(|e| format!("図設定を読めません: {e}"))
}

#[tauri::command(async)]
pub fn figure_compute(dir: String, datasets: Vec<DatasetCfg>, figure: Value) -> R<Computed> {
    let fig: Figure = serde_json::from_value(figure).map_err(|e| format!("図設定が不正です: {e}"))?;
    Ok(figure::compute(Path::new(&dir), &datasets, &fig))
}

#[tauri::command(async)]
pub fn figure_build(app: AppHandle, dir: String, datasets: Vec<DatasetCfg>, name: String, figure: Value) -> R<latex::BuildResult> {
    latex::build_figure(&work_root(&app)?, Path::new(&dir), &datasets, &name, &figure)
}

#[tauri::command(async)]
pub fn figure_delete(dir: String, name: String) -> R<()> {
    project::delete_figure(Path::new(&dir), &name)
}

#[derive(Serialize)]
pub struct ExprInfo {
    params: Vec<String>,
    latex: String,
}

#[tauri::command(async)]
pub fn expr_info(expr: String) -> R<ExprInfo> {
    let n = expr::parse(&expr)?;
    Ok(ExprInfo { params: n.params(), latex: n.to_latex() })
}

#[tauri::command(async)]
pub fn compile(app: AppHandle, dir: String, main: String) -> R<latex::CompileResult> {
    latex::compile_main(&work_root(&app)?, Path::new(&dir), &main)
}

#[tauri::command(async)]
pub fn read_pdf(app: AppHandle, dir: String, main: String) -> Result<tauri::ipc::Response, String> {
    let p = latex::preview_pdf_path(&work_root(&app)?, Path::new(&dir), &main);
    let bytes = std::fs::read(&p).map_err(|_| "PDF がまだありません".to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command(async)]
pub fn synctex_edit(app: AppHandle, dir: String, main: String, page: u32, x: f64, y: f64) -> R<Option<synctex::SourcePos>> {
    synctex::edit(&work_root(&app)?, Path::new(&dir), &main, page, x, y)
}

#[tauri::command(async)]
pub fn synctex_view(app: AppHandle, dir: String, main: String, file: String, line: u32) -> R<Vec<synctex::PdfBox>> {
    synctex::view(&work_root(&app)?, Path::new(&dir), &main, &file, line)
}

/// 起動引数でプロジェクトフォルダ（または project.json）が渡されていればそのパスを返す。
#[tauri::command(async)]
pub fn startup_project() -> Option<String> {
    let arg = std::env::args().nth(1)?;
    let p = PathBuf::from(&arg);
    let dir = if p.file_name().map_or(false, |n| n == "project.json") { p.parent()?.to_path_buf() } else { p };
    dir.join("project.json").exists().then(|| dir.to_string_lossy().into_owned())
}
