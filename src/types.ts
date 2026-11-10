export interface ColumnCfg {
  index: number;
  name: string;
  unit: string;
  used: boolean;
}

export interface ImportCfg {
  encoding: string;
  delimiter: string;
  /** 見出し行（0始まり、無ければ -1） */
  headerRow: number;
  dataStart: number;
  excludedRows: number[];
  columns: ColumnCfg[];
}

export interface Dataset {
  id: string;
  name: string;
  file: string;
  import: ImportCfg;
}

export interface CsvTemplate extends ImportCfg {
  name: string;
  /** 見出し行の内容（自動適用の照合に使う） */
  signature: string;
}

export interface Project {
  version: number;
  name: string;
  mainFile: string;
  datasets: Dataset[];
  cover: { template?: string; fields?: Record<string, string> };
}

export interface Tree {
  data: string[];
  figures: string[];
  tex: string[];
}

export interface ProjectInfo {
  dir: string;
  project: Project;
  tree: Tree;
}

export interface Axis {
  label: string;
  unit: string;
  min: number | null;
  max: number | null;
  tick: number | null;
  log: boolean;
  grid: boolean;
}

export type SeriesKind = "data" | "fit" | "theory";

export interface Series {
  id: string;
  kind: SeriesKind;
  legend: string;
  visible: boolean;
  color: string;
  lineWidth: number;
  lineStyle: string;
  marker: string;
  markerSize: number;
  dataset: string;
  xCol: number;
  yCol: number;
  source: string;
  model: string;
  degree: number;
  range: [number, number] | null;
  showEquation: boolean;
  showR2: boolean;
  eqPos: [number, number];
  macroPrefix: string;
  expr: string;
  params: Record<string, number>;
  compare: string;
  threshold: number;
  highlight: boolean;
  samples: number;
}

export interface Figure {
  version: number;
  width: number;
  height: number;
  fontSize: number;
  legendPos: string;
  sigDigits: number;
  xAxis: Axis;
  yAxis: Axis;
  series: Series[];
}

export interface Tick {
  v: number;
  label: string;
}

export interface RAxis {
  min: number;
  max: number;
  log: boolean;
  ticks: Tick[];
  exp: number;
}

export interface FitResult {
  model: string;
  coeffs: number[];
  errors: (number | null)[];
  names: string[];
  r2: number | null;
  n: number;
  equationLatex: string;
}

export interface Macro {
  name: string;
  value: string;
  comment: string;
}

export interface TheoryStats {
  rates: [number, number, number][];
  meanAbs: number;
  maxAbs: number;
  outliers: [number, number][];
}

export interface CSeries {
  id: string;
  kind: SeriesKind;
  points: [number, number | null][];
  fit: FitResult | null;
  theory: TheoryStats | null;
  latex: string | null;
  macros: Macro[];
  error: string | null;
}

export interface Computed {
  series: CSeries[];
  xAxis: RAxis;
  yAxis: RAxis;
}

export interface TexError {
  file: string;
  line: number;
  message: string;
}

export interface CompileResult {
  ok: boolean;
  errors: TexError[];
  warnings: string[];
  logTail: string;
  durationMs: number;
  pdfExists: boolean;
  runs: number;
}

export interface BuildResult {
  computed: Computed;
  tex: string;
  pdfChanged: boolean;
  valuesChanged: boolean;
  errors: TexError[];
  logTail: string;
  cached: boolean;
}

export interface CsvPreview {
  encoding: string;
  delimiter: string;
  rows: string[][];
  totalRows: number;
  maxCols: number;
}

export interface AppInfo {
  version: string;
  settingsDir: string;
  defaultSettingsDir: string;
  customSettingsDir: boolean;
  workDir: string;
  recent: string[];
}

export interface SourcePos {
  file: string;
  line: number;
  column: number;
}

export interface PdfBox {
  page: number;
  x: number;
  y: number;
  h: number;
  v: number;
  W: number;
  H: number;
}

export const PALETTE = ["#1f77b4", "#d62728", "#2ca02c", "#ff7f0e", "#9467bd", "#8c564b", "#e377c2", "#17becf", "#7f7f7f", "#bcbd22"];

export function defaultAxis(): Axis {
  return { label: "", unit: "", min: null, max: null, tick: null, log: false, grid: false };
}

export function defaultSeries(kind: SeriesKind, id: string, color: string): Series {
  return {
    id,
    kind,
    legend: "",
    visible: true,
    color,
    lineWidth: 1,
    lineStyle: kind === "data" ? "none" : kind === "theory" ? "dashed" : "solid",
    marker: kind === "data" ? "*" : "none",
    markerSize: 2,
    dataset: "",
    xCol: 0,
    yCol: 1,
    source: "",
    model: "linear",
    degree: 2,
    range: null,
    showEquation: true,
    showR2: true,
    eqPos: [0.05, 0.95],
    macroPrefix: "",
    expr: "",
    params: {},
    compare: "",
    threshold: 5,
    highlight: true,
    samples: 200,
  };
}

export function defaultFigure(): Figure {
  return {
    version: 1,
    width: 8,
    height: 6,
    fontSize: 10,
    legendPos: "south east",
    sigDigits: 4,
    xAxis: defaultAxis(),
    yAxis: defaultAxis(),
    series: [],
  };
}

/** 古い版や手編集で欠けた項目を既定値で補う */
export function normalizeFigure(raw: unknown): Figure {
  const r = (raw ?? {}) as Partial<Figure>;
  const f = { ...defaultFigure(), ...r };
  f.xAxis = { ...defaultAxis(), ...(r.xAxis ?? {}) };
  f.yAxis = { ...defaultAxis(), ...(r.yAxis ?? {}) };
  f.series = (r.series ?? []).map((s, i) => ({
    ...defaultSeries(s.kind ?? "data", s.id ?? `s${i + 1}`, PALETTE[i % PALETTE.length]),
    ...s,
  }));
  return f;
}
