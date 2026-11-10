mod commands;
pub mod config;
pub mod csvio;
pub mod expr;
pub mod figure;
pub mod fit;
pub mod latex;
pub mod pgf;
pub mod project;
pub mod synctex;
pub mod util;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::set_settings_dir,
            commands::settings_read,
            commands::settings_write,
            commands::cover_templates,
            commands::cover_template_read,
            commands::cover_template_write,
            commands::cover_template_delete,
            commands::project_create,
            commands::project_open,
            commands::project_save,
            commands::project_tree,
            commands::import_data,
            commands::read_text,
            commands::write_text,
            commands::csv_preview,
            commands::figure_read,
            commands::figure_compute,
            commands::figure_build,
            commands::figure_delete,
            commands::expr_info,
            commands::compile,
            commands::read_pdf,
            commands::synctex_edit,
            commands::synctex_view,
            commands::startup_project,
        ])
        .run(tauri::generate_context!())
        .expect("アプリの起動に失敗しました");
}
