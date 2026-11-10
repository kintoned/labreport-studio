import { invoke } from "@tauri-apps/api/core";
import type {
  AppInfo,
  BuildResult,
  CompileResult,
  Computed,
  CsvPreview,
  Dataset,
  Figure,
  PdfBox,
  Project,
  ProjectInfo,
  SourcePos,
  Tree,
} from "./types";

export const api = {
  startupProject: () => invoke<string | null>("startup_project"),
  appInfo: () => invoke<AppInfo>("app_info"),
  setSettingsDir: (dir: string | null) => invoke<void>("set_settings_dir", { dir }),
  settingsRead: <T>(name: string) => invoke<T | null>("settings_read", { name }),
  settingsWrite: (name: string, value: unknown) => invoke<void>("settings_write", { name, value }),
  coverTemplates: () => invoke<string[]>("cover_templates"),
  coverTemplateRead: (name: string) => invoke<string>("cover_template_read", { name }),
  coverTemplateWrite: (name: string, text: string) => invoke<void>("cover_template_write", { name, text }),
  coverTemplateDelete: (name: string) => invoke<void>("cover_template_delete", { name }),
  projectCreate: (dir: string, name: string) => invoke<ProjectInfo>("project_create", { dir, name }),
  projectOpen: (dir: string) => invoke<ProjectInfo>("project_open", { dir }),
  projectSave: (dir: string, project: Project) => invoke<void>("project_save", { dir, project }),
  projectTree: (dir: string) => invoke<Tree>("project_tree", { dir }),
  importData: (dir: string, src: string) => invoke<string>("import_data", { dir, src }),
  readText: (dir: string, rel: string) => invoke<string>("read_text", { dir, rel }),
  writeText: (dir: string, rel: string, text: string) => invoke<boolean>("write_text", { dir, rel, text }),
  csvPreview: (dir: string, rel: string, encoding: string, delimiter: string) =>
    invoke<CsvPreview>("csv_preview", { dir, rel, encoding, delimiter }),
  figureRead: (dir: string, name: string) => invoke<unknown>("figure_read", { dir, name }),
  figureCompute: (dir: string, datasets: Dataset[], figure: Figure) =>
    invoke<Computed>("figure_compute", { dir, datasets, figure }),
  figureBuild: (dir: string, datasets: Dataset[], name: string, figure: Figure) =>
    invoke<BuildResult>("figure_build", { dir, datasets, name, figure }),
  figureDelete: (dir: string, name: string) => invoke<void>("figure_delete", { dir, name }),
  exprInfo: (expr: string) => invoke<{ params: string[]; latex: string }>("expr_info", { expr }),
  compile: (dir: string, main: string) => invoke<CompileResult>("compile", { dir, main }),
  readPdf: (dir: string, main: string) => invoke<ArrayBuffer>("read_pdf", { dir, main }),
  synctexEdit: (dir: string, main: string, page: number, x: number, y: number) =>
    invoke<SourcePos | null>("synctex_edit", { dir, main, page, x, y }),
  synctexView: (dir: string, main: string, file: string, line: number) =>
    invoke<PdfBox[]>("synctex_view", { dir, main, file, line }),
};
