//! 図設定(JSON) のデータモデルと、描画に必要な数値（系列の点列・フィット結果・
//! 理論式との誤差率・軸の範囲と目盛り）の計算。
//! プレビュー(SVG) と pgfplots 出力の両方がこの結果を使うので、見た目が一致する。

use crate::csvio::{self, DatasetCfg};
use crate::expr;
use crate::fit::{self, FitResult};
use crate::util::{self, R};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Axis {
    pub label: String,
    pub unit: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub tick: Option<f64>,
    pub log: bool,
    pub grid: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Series {
    pub id: String,
    /// "data" | "fit" | "theory"
    pub kind: String,
    pub legend: String,
    pub visible: bool,
    pub color: String,
    pub line_width: f64,
    /// "solid" | "dashed" | "dotted" | "dashdotted" | "none"
    pub line_style: String,
    /// pgfplots のマーク名: "none" | "o" | "*" | "square" | "square*" | "triangle" | "triangle*" | "diamond" | "diamond*" | "x" | "+"
    pub marker: String,
    pub marker_size: f64,
    // --- data ---
    pub dataset: String,
    pub x_col: usize,
    pub y_col: usize,
    // --- fit ---
    pub source: String,
    pub model: String,
    pub degree: usize,
    pub range: Option<[f64; 2]>,
    pub show_equation: bool,
    pub show_r2: bool,
    /// 式ラベルの位置（軸領域に対する相対座標、左下原点）
    pub eq_pos: [f64; 2],
    pub macro_prefix: String,
    // --- theory ---
    pub expr: String,
    pub params: BTreeMap<String, f64>,
    pub compare: String,
    /// 強調表示する誤差率のしきい値 [%]
    pub threshold: f64,
    pub highlight: bool,
    pub samples: usize,
}

impl Default for Series {
    fn default() -> Self {
        Series {
            id: String::new(),
            kind: "data".into(),
            legend: String::new(),
            visible: true,
            color: "#1f77b4".into(),
            line_width: 1.0,
            line_style: "solid".into(),
            marker: "none".into(),
            marker_size: 2.0,
            dataset: String::new(),
            x_col: 0,
            y_col: 1,
            source: String::new(),
            model: "linear".into(),
            degree: 2,
            range: None,
            show_equation: true,
            show_r2: true,
            eq_pos: [0.05, 0.95],
            macro_prefix: String::new(),
            expr: String::new(),
            params: BTreeMap::new(),
            compare: String::new(),
            threshold: 5.0,
            highlight: true,
            samples: 200,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Figure {
    pub version: u32,
    /// 軸領域の幅・高さ [cm]
    pub width: f64,
    pub height: f64,
    /// [pt]
    pub font_size: f64,
    pub legend_pos: String,
    pub sig_digits: usize,
    pub x_axis: Axis,
    pub y_axis: Axis,
    pub series: Vec<Series>,
}

impl Default for Figure {
    fn default() -> Self {
        Figure {
            version: 1,
            width: 8.0,
            height: 6.0,
            font_size: 10.0,
            legend_pos: "south east".into(),
            sig_digits: 4,
            x_axis: Axis::default(),
            y_axis: Axis::default(),
            series: vec![],
        }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct Tick {
    pub v: f64,
    pub label: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ResolvedAxis {
    pub min: f64,
    pub max: f64,
    pub log: bool,
    pub ticks: Vec<Tick>,
    /// 目盛りラベルの共通指数（0 なら無し）。ラベルは v / 10^exp
    pub exp: i32,
}

#[derive(Serialize, Clone, Debug)]
pub struct Macro {
    pub name: String,
    pub value: String,
    pub comment: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TheoryStats {
    /// [x, 測定値, 誤差率%]
    pub rates: Vec<[f64; 3]>,
    pub mean_abs: f64,
    pub max_abs: f64,
    pub outliers: Vec<[f64; 2]>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComputedSeries {
    pub id: String,
    pub kind: String,
    pub points: Vec<[f64; 2]>,
    pub fit: Option<FitResult>,
    pub theory: Option<TheoryStats>,
    pub latex: Option<String>,
    pub macros: Vec<Macro>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Computed {
    pub series: Vec<ComputedSeries>,
    pub x_axis: ResolvedAxis,
    pub y_axis: ResolvedAxis,
}

fn nice_step(raw: f64) -> f64 {
    if !(raw > 0.0) || !raw.is_finite() {
        return 1.0;
    }
    let p = 10f64.powf(raw.log10().floor());
    let f = raw / p;
    let n = if f < 1.5 {
        1.0
    } else if f < 3.5 {
        2.0
    } else if f < 7.5 {
        5.0
    } else {
        10.0
    };
    n * p
}

pub fn resolve_axis(ax: &Axis, extent: Option<[f64; 2]>) -> ResolvedAxis {
    if ax.log {
        let (lo, hi) = match extent {
            Some([a, b]) if a > 0.0 && b > 0.0 => (a, b),
            _ => (1.0, 10.0),
        };
        let min = ax.min.filter(|v| *v > 0.0).unwrap_or_else(|| 10f64.powf((lo.log10() + 1e-9).floor()));
        let mut max = ax.max.filter(|v| *v > 0.0).unwrap_or_else(|| 10f64.powf((hi.log10() - 1e-9).ceil()));
        if !(max > min) {
            max = min * 10.0;
        }
        let k0 = (min.log10() - 1e-9).ceil() as i32;
        let k1 = (max.log10() + 1e-9).floor() as i32;
        let ticks = (k0..=k1).map(|k| Tick { v: 10f64.powi(k), label: format!("10^{{{k}}}") }).collect();
        return ResolvedAxis { min, max, log: true, ticks, exp: 0 };
    }
    let (mut lo, mut hi) = match extent {
        Some([a, b]) if a.is_finite() && b.is_finite() => (a, b),
        _ => (0.0, 1.0),
    };
    if hi - lo <= 0.0 {
        let pad = if lo == 0.0 { 0.5 } else { lo.abs() * 0.1 };
        lo -= pad;
        hi += pad;
    }
    let s0 = nice_step((hi - lo) / 5.0);
    let min = ax.min.unwrap_or_else(|| (lo / s0 + 1e-9).floor() * s0);
    let mut max = ax.max.unwrap_or_else(|| (hi / s0 - 1e-9).ceil() * s0);
    if !(max > min) {
        max = min + s0.max(f64::MIN_POSITIVE);
    }
    let mut step = ax.tick.filter(|t| *t > 0.0).unwrap_or_else(|| nice_step((max - min) / 5.0));
    if (max - min) / step > 200.0 {
        step = nice_step((max - min) / 5.0);
    }
    let m = min.abs().max(max.abs());
    let e = if m > 0.0 { m.log10().floor() as i32 } else { 0 };
    let exp = if e >= 5 || e <= -3 { e } else { 0 };
    let scale = 10f64.powi(exp);
    let s = step / scale;
    let mut dec = 0usize;
    while dec < 8 {
        let t = s * 10f64.powi(dec as i32);
        if (t - t.round()).abs() < 1e-6 * t.abs().max(1.0) {
            break;
        }
        dec += 1;
    }
    let k0 = (min / step - 1e-9).ceil() as i64;
    let k1 = (max / step + 1e-9).floor() as i64;
    let ticks = (k0..=k1)
        .map(|k| {
            let v = k as f64 * step;
            let mut label = format!("{:.*}", dec, v / scale);
            if label.trim_start_matches('-').chars().all(|c| c == '0' || c == '.') {
                label = label.trim_start_matches('-').to_string();
            }
            Tick { v, label }
        })
        .collect();
    ResolvedAxis { min, max, log: false, ticks, exp }
}

fn letters_only(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphabetic()).collect()
}

/// values.tex に書く値。指数表記は本文中でも使えるよう \ensuremath で包む。
fn tex_value(v: f64, sig: usize) -> String {
    if !v.is_finite() {
        return "--".into();
    }
    let s = fit::fmt_latex(v, sig);
    if s.contains("\\times") {
        format!("\\ensuremath{{{s}}}")
    } else {
        s
    }
}

fn fit_macros(prefix: &str, legend: &str, r: &FitResult, sig: usize) -> Vec<Macro> {
    let p = letters_only(prefix);
    if p.is_empty() {
        return vec![];
    }
    let coef_names: Vec<String> = match r.model.as_str() {
        "linear" => vec!["Slope".into(), "Intercept".into()],
        _ => (0..r.coeffs.len()).map(|i| ((b'A' + (i as u8 % 26)) as char).to_string()).collect(),
    };
    let desc: Vec<String> = match r.model.as_str() {
        "linear" => vec!["傾き a (y = ax + b)".into(), "切片 b (y = ax + b)".into()],
        "poly" => (0..r.coeffs.len()).map(|i| format!("x^{i} の係数")).collect(),
        "exp" => vec!["a (y = a e^{bx})".into(), "b (y = a e^{bx})".into()],
        "log" => vec!["a (y = a ln x + b)".into(), "b (y = a ln x + b)".into()],
        _ => vec!["a (y = a x^b)".into(), "b (y = a x^b)".into()],
    };
    let mut out = Vec::new();
    for i in 0..r.coeffs.len() {
        out.push(Macro {
            name: format!("{p}{}", coef_names[i]),
            value: tex_value(r.coeffs[i], sig),
            comment: format!("{legend}: {}", desc[i]),
        });
        out.push(Macro {
            name: format!("{p}{}Err", coef_names[i]),
            value: tex_value(r.errors[i], 2),
            comment: format!("{legend}: {} の標準誤差", desc[i]),
        });
    }
    out.push(Macro {
        name: format!("{p}Rsq"),
        value: if r.r2.is_finite() { format!("{:.4}", r.r2) } else { "--".into() },
        comment: format!("{legend}: 決定係数 R^2"),
    });
    out
}

fn extent(pts: impl Iterator<Item = f64>) -> Option<[f64; 2]> {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for v in pts.filter(|v| v.is_finite()) {
        lo = lo.min(v);
        hi = hi.max(v);
    }
    (lo <= hi).then_some([lo, hi])
}

fn sample(lo: f64, hi: f64, n: usize, log: bool) -> Vec<f64> {
    let n = n.clamp(2, 5000);
    (0..n)
        .map(|i| {
            let t = i as f64 / (n - 1) as f64;
            if log && lo > 0.0 && hi > 0.0 {
                (lo.ln() + (hi.ln() - lo.ln()) * t).exp()
            } else {
                lo + (hi - lo) * t
            }
        })
        .collect()
}

pub fn compute(dir: &Path, datasets: &[DatasetCfg], fig: &Figure) -> Computed {
    let mut out: Vec<ComputedSeries> = fig
        .series
        .iter()
        .map(|s| ComputedSeries { id: s.id.clone(), kind: s.kind.clone(), ..Default::default() })
        .collect();
    let (xlog, ylog) = (fig.x_axis.log, fig.y_axis.log);
    let sig = fig.sig_digits.clamp(1, 12);

    // 1) データ系列
    for (i, s) in fig.series.iter().enumerate() {
        if s.kind != "data" {
            continue;
        }
        let r: R<Vec<[f64; 2]>> = (|| {
            let ds = datasets
                .iter()
                .find(|d| d.id == s.dataset)
                .ok_or_else(|| "データが選択されていません".to_string())?;
            let table = csvio::load(dir, ds)?;
            let x = table.column(s.x_col).ok_or_else(|| "X 列が取り込み対象になっていません".to_string())?;
            let y = table.column(s.y_col).ok_or_else(|| "Y 列が取り込み対象になっていません".to_string())?;
            Ok(x.values
                .iter()
                .zip(&y.values)
                .filter(|(a, b)| a.is_finite() && b.is_finite() && (!xlog || **a > 0.0) && (!ylog || **b > 0.0))
                .map(|(a, b)| [*a, *b])
                .collect())
        })();
        match r {
            Ok(p) => out[i].points = p,
            Err(e) => out[i].error = Some(e),
        }
    }

    let data_x = extent(
        fig.series
            .iter()
            .zip(&out)
            .filter(|(s, _)| s.kind == "data" && s.visible)
            .flat_map(|(_, c)| c.points.iter().map(|p| p[0])),
    );
    let find = |id: &str, out: &Vec<ComputedSeries>| -> Option<Vec<[f64; 2]>> {
        fig.series
            .iter()
            .position(|s| s.id == id && s.kind == "data")
            .map(|k| out[k].points.clone())
    };

    // 2) フィット
    for (i, s) in fig.series.iter().enumerate() {
        if s.kind != "fit" {
            continue;
        }
        let Some(src) = find(&s.source, &out) else {
            out[i].error = Some("フィット対象の系列が選択されていません".into());
            continue;
        };
        let range = s.range.map(|r| [r[0].min(r[1]), r[0].max(r[1])]);
        let used: Vec<[f64; 2]> = match range {
            Some(r) => src.iter().copied().filter(|p| p[0] >= r[0] && p[0] <= r[1]).collect(),
            None => src.clone(),
        };
        match fit::fit(&s.model, s.degree, &used, sig) {
            Ok(res) => {
                let ext = range.or_else(|| extent(src.iter().map(|p| p[0])));
                if let Some([lo, hi]) = ext {
                    let lo = if matches!(s.model.as_str(), "log" | "power") { lo.max(f64::MIN_POSITIVE) } else { lo };
                    out[i].points =
                        sample(lo, hi, 201, xlog).into_iter().map(|x| [x, fit::eval(&s.model, &res.coeffs, x)]).collect();
                }
                let legend = if s.legend.is_empty() { s.id.clone() } else { s.legend.clone() };
                out[i].macros = fit_macros(&s.macro_prefix, &legend, &res, sig);
                out[i].latex = Some(res.equation_latex.clone());
                out[i].fit = Some(res);
            }
            Err(e) => out[i].error = Some(e),
        }
    }

    // 3) 理論式
    for (i, s) in fig.series.iter().enumerate() {
        if s.kind != "theory" {
            continue;
        }
        let node = match expr::parse(&s.expr) {
            Ok(n) => n,
            Err(e) => {
                out[i].error = Some(e);
                continue;
            }
        };
        let missing: Vec<String> = node.params().into_iter().filter(|p| !s.params.contains_key(p)).collect();
        if !missing.is_empty() {
            out[i].error = Some(format!("パラメータが未設定です: {}", missing.join(", ")));
            continue;
        }
        let pf = |n: &str| s.params.get(n).copied().unwrap_or(f64::NAN);
        out[i].latex = Some(format!("y = {}", node.to_latex()));
        let lo = fig.x_axis.min.or(data_x.map(|e| e[0])).unwrap_or(0.0);
        let hi = fig.x_axis.max.or(data_x.map(|e| e[1])).unwrap_or(1.0);
        if hi > lo {
            out[i].points = sample(lo, hi, s.samples.max(2), xlog).into_iter().map(|x| [x, node.eval(x, &pf)]).collect();
        }
        if let Some(src) = find(&s.compare, &out) {
            let mut st = TheoryStats::default();
            let mut sum = 0.0;
            for p in &src {
                let t = node.eval(p[0], &pf);
                let rate = (p[1] - t) / t * 100.0;
                if !rate.is_finite() {
                    continue;
                }
                st.rates.push([p[0], p[1], rate]);
                sum += rate.abs();
                st.max_abs = st.max_abs.max(rate.abs());
                if rate.abs() > s.threshold {
                    st.outliers.push(*p);
                }
            }
            if !st.rates.is_empty() {
                st.mean_abs = sum / st.rates.len() as f64;
                let p = letters_only(&s.macro_prefix);
                if !p.is_empty() {
                    let legend = if s.legend.is_empty() { s.id.clone() } else { s.legend.clone() };
                    out[i].macros = vec![
                        Macro {
                            name: format!("{p}MeanErr"),
                            value: tex_value(st.mean_abs, 3),
                            comment: format!("{legend}: 理論値との誤差率の平均 [%]"),
                        },
                        Macro {
                            name: format!("{p}MaxErr"),
                            value: tex_value(st.max_abs, 3),
                            comment: format!("{legend}: 理論値との誤差率の最大 [%]"),
                        },
                    ];
                }
            }
            out[i].theory = Some(st);
        }
    }

    // 4) 軸。データがあればデータの範囲、無ければ曲線の範囲から決める。
    let vis = |kind_data: bool, k: usize| {
        fig.series
            .iter()
            .zip(&out)
            .filter(move |(s, _)| s.visible && (s.kind == "data") == kind_data)
            .flat_map(move |(_, c)| c.points.iter().map(move |p| p[k]))
    };
    let pos = |log: bool, it: &mut dyn Iterator<Item = f64>| extent(it.filter(|v| !log || *v > 0.0));
    let x_ext = pos(xlog, &mut vis(true, 0)).or_else(|| pos(xlog, &mut vis(false, 0)));
    let y_ext = pos(ylog, &mut vis(true, 1)).or_else(|| pos(ylog, &mut vis(false, 1)));
    let x_axis = resolve_axis(&fig.x_axis, x_ext);
    let y_axis = resolve_axis(&fig.y_axis, y_ext);

    // 曲線の発散点は線を切る（pgfplots の "Dimension too large" 回避）
    for (s, c) in fig.series.iter().zip(out.iter_mut()) {
        if s.kind == "data" {
            continue;
        }
        for p in c.points.iter_mut() {
            let ok = if ylog {
                p[1] > y_axis.min * 1e-12 && p[1] < y_axis.max * 1e12
            } else {
                let span = y_axis.max - y_axis.min;
                p[1] > y_axis.min - 20.0 * span && p[1] < y_axis.max + 20.0 * span
            };
            if !ok || (xlog && p[0] <= 0.0) {
                p[1] = f64::NAN;
            }
        }
    }
    Computed { series: out, x_axis, y_axis }
}

/// 全ての図のフィット結果などを values.tex の内容にまとめる。
pub fn values_tex(dir: &Path, datasets: &[DatasetCfg]) -> String {
    let mut s = String::from(
        "% 自動生成: 実験レポート統括ソフト\n% 図の設定から毎回作り直されます。手で編集しても上書きされます。\n",
    );
    let mut names: Vec<String> = std::fs::read_dir(dir.join("figures"))
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".json").map(String::from)))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    let mut seen = std::collections::HashSet::new();
    for name in names {
        let Ok(text) = util::read_text(&dir.join("figures").join(format!("{name}.json"))) else { continue };
        let Ok(fig) = serde_json::from_str::<Figure>(&text) else { continue };
        let c = compute(dir, datasets, &fig);
        let macros: Vec<&Macro> = c.series.iter().flat_map(|x| x.macros.iter()).collect();
        if macros.is_empty() {
            continue;
        }
        s.push_str(&format!("\n% --- 図: {name} ---\n"));
        for m in macros {
            if seen.insert(m.name.clone()) {
                s.push_str(&format!("\\newcommand{{\\{}}}{{{}}} % {}\n", m.name, m.value, m.comment));
            } else {
                s.push_str(&format!("% (名前が重複しています) \\{} = {} % {}\n", m.name, m.value, m.comment));
            }
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn axis_ticks() {
        let a = resolve_axis(&Axis::default(), Some([0.3, 9.7]));
        assert_eq!((a.min, a.max), (0.0, 10.0));
        assert_eq!(a.ticks.iter().map(|t| t.label.as_str()).collect::<Vec<_>>(), ["0", "2", "4", "6", "8", "10"]);
        let a = resolve_axis(&Axis::default(), Some([-0.012, 0.031]));
        assert_eq!(a.exp, 0);
        assert_eq!(a.ticks.first().unwrap().label, "-0.02");
        let a = resolve_axis(&Axis::default(), Some([0.0, 250000.0]));
        assert_eq!(a.exp, 5);
        assert_eq!(a.ticks.iter().map(|t| t.label.as_str()).collect::<Vec<_>>(), ["0.0", "0.5", "1.0", "1.5", "2.0", "2.5"]);
        let a = resolve_axis(&Axis { log: true, ..Default::default() }, Some([0.02, 350.0]));
        assert_eq!((a.min, a.max), (0.01, 1000.0));
        assert_eq!(a.ticks.len(), 6);
        let a = resolve_axis(&Axis { min: Some(0.0), max: Some(1.0), tick: Some(0.25), ..Default::default() }, None);
        assert_eq!(a.ticks.iter().map(|t| t.label.as_str()).collect::<Vec<_>>(), ["0.00", "0.25", "0.50", "0.75", "1.00"]);
    }
}
