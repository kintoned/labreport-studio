//! 最小二乗フィッティング（一次・多項式・指数・対数・べき乗）。
//! 線形モデルは Householder QR、非線形モデルは対数変換した解を初期値に
//! Levenberg–Marquardt 法で元の空間の残差を最小化する。

use crate::util::R;
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FitResult {
    pub model: String,
    pub coeffs: Vec<f64>,
    pub errors: Vec<f64>,
    pub names: Vec<String>,
    pub r2: f64,
    pub n: usize,
    pub equation_latex: String,
}

type Mat = Vec<Vec<f64>>;

/// min ||A·β − y|| を解く。戻り値は (β, (AᵀA)⁻¹)。
fn lsq(a: &[Vec<f64>], y: &[f64]) -> Option<(Vec<f64>, Mat)> {
    let n = a.len();
    let p = a.first()?.len();
    if n < p || p == 0 {
        return None;
    }
    // 列スケーリングで条件数を改善
    let mut scale = vec![0.0; p];
    for j in 0..p {
        scale[j] = a.iter().map(|r| r[j] * r[j]).sum::<f64>().sqrt();
        if !(scale[j] > 0.0) || !scale[j].is_finite() {
            return None;
        }
    }
    let mut m: Mat = a.iter().map(|r| r.iter().zip(&scale).map(|(v, s)| v / s).collect()).collect();
    let mut b = y.to_vec();
    let mut diag = vec![0.0; p];
    for k in 0..p {
        let norm = (k..n).map(|i| m[i][k] * m[i][k]).sum::<f64>().sqrt();
        if norm < 1e-13 {
            return None;
        }
        let alpha = if m[k][k] > 0.0 { -norm } else { norm };
        let mut v: Vec<f64> = (k..n).map(|i| m[i][k]).collect();
        v[0] -= alpha;
        let vn: f64 = v.iter().map(|x| x * x).sum();
        if vn > 0.0 {
            for j in (k + 1)..p {
                let dot: f64 = (k..n).map(|i| v[i - k] * m[i][j]).sum();
                let f = 2.0 * dot / vn;
                for i in k..n {
                    m[i][j] -= f * v[i - k];
                }
            }
            let dot: f64 = (k..n).map(|i| v[i - k] * b[i]).sum();
            let f = 2.0 * dot / vn;
            for i in k..n {
                b[i] -= f * v[i - k];
            }
        }
        diag[k] = alpha;
    }
    // R の逆行列（上三角）
    let r = |i: usize, j: usize| if i == j { diag[i] } else { m[i][j] };
    let mut rinv = vec![vec![0.0; p]; p];
    for j in 0..p {
        rinv[j][j] = 1.0 / r(j, j);
        for i in (0..j).rev() {
            let s: f64 = ((i + 1)..=j).map(|k| r(i, k) * rinv[k][j]).sum();
            rinv[i][j] = -s / r(i, i);
        }
    }
    let mut beta = vec![0.0; p];
    for i in 0..p {
        beta[i] = (i..p).map(|j| rinv[i][j] * b[j]).sum::<f64>() / scale[i];
    }
    let mut cov = vec![vec![0.0; p]; p];
    for i in 0..p {
        for j in 0..p {
            let s: f64 = (i.max(j)..p).map(|k| rinv[i][k] * rinv[j][k]).sum();
            cov[i][j] = s / (scale[i] * scale[j]);
        }
    }
    if beta.iter().any(|v| !v.is_finite()) {
        return None;
    }
    Some((beta, cov))
}

fn solve(mut a: Mat, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    for c in 0..n {
        let piv = (c..n).max_by(|&i, &j| a[i][c].abs().partial_cmp(&a[j][c].abs()).unwrap_or(std::cmp::Ordering::Equal))?;
        if a[piv][c].abs() < 1e-300 {
            return None;
        }
        a.swap(c, piv);
        b.swap(c, piv);
        for i in (c + 1)..n {
            let f = a[i][c] / a[c][c];
            for j in c..n {
                a[i][j] -= f * a[c][j];
            }
            b[i] -= f * b[c];
        }
    }
    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        let s: f64 = ((i + 1)..n).map(|j| a[i][j] * x[j]).sum();
        x[i] = (b[i] - s) / a[i][i];
    }
    Some(x)
}

fn ssr(xs: &[f64], ys: &[f64], p: &[f64], f: &dyn Fn(f64, &[f64]) -> f64) -> f64 {
    xs.iter().zip(ys).map(|(x, y)| (y - f(*x, p)).powi(2)).sum()
}

fn lm(
    xs: &[f64],
    ys: &[f64],
    p0: Vec<f64>,
    f: &dyn Fn(f64, &[f64]) -> f64,
    jac: &dyn Fn(f64, &[f64]) -> Vec<f64>,
) -> (Vec<f64>, Option<Mat>) {
    let np = p0.len();
    let mut p = p0;
    let mut cur = ssr(xs, ys, &p, f);
    let mut lambda = 1e-3;
    for _ in 0..300 {
        let mut jtj = vec![vec![0.0; np]; np];
        let mut jtr = vec![0.0; np];
        for (x, y) in xs.iter().zip(ys) {
            let j = jac(*x, &p);
            let r = y - f(*x, &p);
            for a in 0..np {
                jtr[a] += j[a] * r;
                for b in 0..np {
                    jtj[a][b] += j[a] * j[b];
                }
            }
        }
        let mut improved = false;
        for _ in 0..30 {
            let mut a = jtj.clone();
            for i in 0..np {
                a[i][i] += lambda * jtj[i][i].max(1e-300);
            }
            if let Some(d) = solve(a, jtr.clone()) {
                let cand: Vec<f64> = p.iter().zip(&d).map(|(a, b)| a + b).collect();
                let s = ssr(xs, ys, &cand, f);
                if s.is_finite() && s <= cur {
                    let rel = (cur - s) / cur.max(1e-300);
                    p = cand;
                    cur = s;
                    lambda = (lambda / 10.0).max(1e-12);
                    improved = rel > 1e-14;
                    break;
                }
            }
            lambda *= 10.0;
            if lambda > 1e12 {
                break;
            }
        }
        if !improved {
            break;
        }
    }
    let j: Mat = xs.iter().map(|x| jac(*x, &p)).collect();
    let cov = lsq(&j, &vec![0.0; xs.len()]).map(|(_, c)| c);
    (p, cov)
}

pub fn eval(model: &str, c: &[f64], x: f64) -> f64 {
    match model {
        "linear" => c[0] * x + c[1],
        "poly" => c.iter().rev().fold(0.0, |acc, k| acc * x + k),
        "exp" => c[0] * (c[1] * x).exp(),
        "log" => c[0] * x.ln() + c[1],
        "power" => c[0] * x.powf(c[1]),
        _ => f64::NAN,
    }
}

pub fn fit(model: &str, degree: usize, pts: &[[f64; 2]], sig: usize) -> R<FitResult> {
    let mut pts: Vec<[f64; 2]> = pts.iter().copied().filter(|p| p[0].is_finite() && p[1].is_finite()).collect();
    if matches!(model, "log" | "power") {
        pts.retain(|p| p[0] > 0.0);
    }
    let xs: Vec<f64> = pts.iter().map(|p| p[0]).collect();
    let ys: Vec<f64> = pts.iter().map(|p| p[1]).collect();
    let n = pts.len();
    let singular = || "フィットできません（データ点が不足しているか、縮退しています）".to_string();

    let (coeffs, cov, names): (Vec<f64>, Option<Mat>, Vec<String>) = match model {
        "linear" => {
            if n < 2 {
                return Err(singular());
            }
            let a: Mat = xs.iter().map(|x| vec![*x, 1.0]).collect();
            let (b, c) = lsq(&a, &ys).ok_or_else(singular)?;
            (b, Some(c), vec!["a".into(), "b".into()])
        }
        "poly" => {
            let d = degree.clamp(1, 12);
            if n < d + 1 {
                return Err(format!("{d} 次多項式には {} 点以上必要です", d + 1));
            }
            let a: Mat = xs.iter().map(|x| (0..=d).map(|k| x.powi(k as i32)).collect()).collect();
            let (b, c) = lsq(&a, &ys).ok_or_else(singular)?;
            (b, Some(c), (0..=d).map(|k| format!("c{k}")).collect())
        }
        "log" => {
            if n < 2 {
                return Err("対数フィットには x > 0 の点が 2 点以上必要です".into());
            }
            let a: Mat = xs.iter().map(|x| vec![x.ln(), 1.0]).collect();
            let (b, c) = lsq(&a, &ys).ok_or_else(singular)?;
            (b, Some(c), vec!["a".into(), "b".into()])
        }
        "exp" | "power" => {
            // 対数変換による初期値。y の符号が揃っている点だけを使う。
            let pos = ys.iter().filter(|y| **y > 0.0).count();
            let sign = if pos * 2 >= n { 1.0 } else { -1.0 };
            let idx: Vec<usize> = (0..n).filter(|i| ys[*i] * sign > 0.0).collect();
            if idx.len() < 2 || n < 2 {
                return Err("このモデルには同符号の y を持つ点が 2 点以上必要です".into());
            }
            let tx = |x: f64| if model == "exp" { x } else { x.ln() };
            let a: Mat = idx.iter().map(|i| vec![tx(xs[*i]), 1.0]).collect();
            let ly: Vec<f64> = idx.iter().map(|i| (ys[*i] * sign).ln()).collect();
            let (b, _) = lsq(&a, &ly).ok_or_else(singular)?;
            let p0 = vec![sign * b[1].exp(), b[0]];
            let (p, cov) = if model == "exp" {
                lm(&xs, &ys, p0, &|x, p| p[0] * (p[1] * x).exp(), &|x, p| {
                    let e = (p[1] * x).exp();
                    vec![e, p[0] * x * e]
                })
            } else {
                lm(&xs, &ys, p0, &|x, p| p[0] * x.powf(p[1]), &|x, p| {
                    let e = x.powf(p[1]);
                    vec![e, p[0] * e * x.ln()]
                })
            };
            (p, cov, vec!["a".into(), "b".into()])
        }
        other => return Err(format!("未対応のフィット種類です: {other}")),
    };

    let np = coeffs.len();
    let mean = ys.iter().sum::<f64>() / n as f64;
    let ss_tot: f64 = ys.iter().map(|y| (y - mean).powi(2)).sum();
    let ss_res: f64 = xs.iter().zip(&ys).map(|(x, y)| (y - eval(model, &coeffs, *x)).powi(2)).sum();
    let r2 = if ss_tot > 0.0 { 1.0 - ss_res / ss_tot } else { f64::NAN };
    let errors: Vec<f64> = match (&cov, n > np) {
        (Some(c), true) => {
            let s2 = ss_res / (n - np) as f64;
            (0..np).map(|i| (c[i][i] * s2).sqrt()).collect()
        }
        _ => vec![f64::NAN; np],
    };
    let equation_latex = equation(model, &coeffs, sig);
    Ok(FitResult { model: model.into(), coeffs, errors, names, r2, n, equation_latex })
}

/// 有効数字 sig 桁。通常表記 or 指数表記 ("1.23e-5")
pub fn fmt_sig(v: f64, sig: usize) -> String {
    let (m, e) = split_sig(v, sig);
    match e {
        None => m,
        Some(e) => format!("{m}e{e}"),
    }
}

/// LaTeX 数式モード用（"1.23\times 10^{-5}"）
pub fn fmt_latex(v: f64, sig: usize) -> String {
    let (m, e) = split_sig(v, sig);
    match e {
        None => m,
        Some(e) => format!("{m}\\times 10^{{{e}}}"),
    }
}

fn split_sig(v: f64, sig: usize) -> (String, Option<i32>) {
    let sig = sig.clamp(1, 15) as i32;
    if v == 0.0 {
        return ("0".into(), None);
    }
    if !v.is_finite() {
        return ("\\mathrm{NaN}".into(), None);
    }
    let mut e = v.abs().log10().floor() as i32;
    // 丸めで桁が繰り上がる場合の補正
    let rounded = format!("{:.*e}", (sig - 1) as usize, v);
    if let Some(pos) = rounded.find('e') {
        if let Ok(re) = rounded[pos + 1..].parse::<i32>() {
            e = re;
        }
    }
    if (-3..5).contains(&e) {
        let dec = (sig - 1 - e).max(0) as usize;
        (format!("{:.*}", dec, v), None)
    } else {
        let pos = rounded.find('e').unwrap_or(rounded.len());
        (rounded[..pos].to_string(), Some(e))
    }
}

fn signed(v: f64, sig: usize) -> String {
    if v < 0.0 {
        format!("- {}", fmt_latex(-v, sig))
    } else {
        format!("+ {}", fmt_latex(v, sig))
    }
}

pub fn equation(model: &str, c: &[f64], sig: usize) -> String {
    match model {
        "linear" => format!("y = {}x {}", fmt_latex(c[0], sig), signed(c[1], sig)),
        "poly" => {
            let mut s = String::from("y = ");
            for k in (0..c.len()).rev() {
                let first = k == c.len() - 1;
                let num = if first { fmt_latex(c[k], sig) } else { format!(" {}", signed(c[k], sig)) };
                s.push_str(&num);
                match k {
                    0 => {}
                    1 => s.push('x'),
                    _ => s.push_str(&format!("x^{{{k}}}")),
                }
            }
            s
        }
        "exp" => format!("y = {}\\,e^{{{}x}}", fmt_latex(c[0], sig), fmt_latex(c[1], sig)),
        "log" => format!("y = {}\\ln x {}", fmt_latex(c[0], sig), signed(c[1], sig)),
        "power" => format!("y = {}\\,x^{{{}}}", fmt_latex(c[0], sig), fmt_latex(c[1], sig)),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol * (1.0 + b.abs())
    }

    #[test]
    fn linear_exact_and_errors() {
        // NIST 風の小さな例: y = 2x + 1 にノイズ
        let pts = [[1.0, 3.1], [2.0, 4.9], [3.0, 7.2], [4.0, 8.8], [5.0, 11.0]];
        let r = fit("linear", 1, &pts, 4).unwrap();
        assert!(close(r.coeffs[0], 1.97, 1e-9), "{:?}", r.coeffs);
        assert!(close(r.coeffs[1], 1.09, 1e-9));
        // 手計算: 残差平方和 0.091, s² = 0.091/3, Sxx = 10, x̄ = 3
        let s2 = 0.091f64 / 3.0;
        assert!(close(r.errors[0], (s2 / 10.0).sqrt(), 1e-9), "{:?}", r.errors);
        assert!(close(r.errors[1], (s2 * (1.0 / 5.0 + 9.0 / 10.0)).sqrt(), 1e-9));
        assert!(r.r2 > 0.99 && r.r2 < 1.0);
    }

    #[test]
    fn poly_exp_log_power() {
        let xs: Vec<f64> = (1..=12).map(|i| i as f64 * 0.5).collect();
        let p: Vec<[f64; 2]> = xs.iter().map(|x| [*x, 0.5 * x * x * x - 2.0 * x + 3.0]).collect();
        let r = fit("poly", 3, &p, 4).unwrap();
        for (got, want) in r.coeffs.iter().zip([3.0, -2.0, 0.0, 0.5]) {
            assert!((got - want).abs() < 1e-8, "{:?}", r.coeffs);
        }
        let p: Vec<[f64; 2]> = xs.iter().map(|x| [*x, 2.5 * (-0.7 * x).exp()]).collect();
        let r = fit("exp", 1, &p, 4).unwrap();
        assert!(close(r.coeffs[0], 2.5, 1e-8) && close(r.coeffs[1], -0.7, 1e-8), "{:?}", r.coeffs);
        let p: Vec<[f64; 2]> = xs.iter().map(|x| [*x, 1.5 * x.ln() - 4.0]).collect();
        let r = fit("log", 1, &p, 4).unwrap();
        assert!(close(r.coeffs[0], 1.5, 1e-9) && close(r.coeffs[1], -4.0, 1e-9));
        let p: Vec<[f64; 2]> = xs.iter().map(|x| [*x, 3.0 * x.powf(1.5)]).collect();
        let r = fit("power", 1, &p, 4).unwrap();
        assert!(close(r.coeffs[0], 3.0, 1e-8) && close(r.coeffs[1], 1.5, 1e-8));
        assert!(close(r.r2, 1.0, 1e-9));
    }

    #[test]
    fn exp_with_noise_minimises_original_residuals() {
        let pts = [[0.0, 2.1], [1.0, 5.2], [2.0, 15.4], [3.0, 39.0], [4.0, 111.0]];
        let r = fit("exp", 1, &pts, 4).unwrap();
        let s0 = pts.iter().map(|p| (p[1] - eval("exp", &r.coeffs, p[0])).powi(2)).sum::<f64>();
        for d in [[1e-3, 0.0], [-1e-3, 0.0], [0.0, 1e-4], [0.0, -1e-4]] {
            let c = [r.coeffs[0] + d[0], r.coeffs[1] + d[1]];
            let s = pts.iter().map(|p| (p[1] - eval("exp", &c, p[0])).powi(2)).sum::<f64>();
            assert!(s >= s0);
        }
    }

    #[test]
    fn number_format() {
        assert_eq!(fmt_sig(1.23456, 4), "1.235");
        assert_eq!(fmt_sig(0.00123456, 3), "0.00123");
        assert_eq!(fmt_sig(123456.0, 3), "1.23e5");
        assert_eq!(fmt_sig(0.0000999999, 3), "1.00e-4");
        assert_eq!(fmt_sig(9.9999, 3), "10.0");
        assert_eq!(fmt_latex(-4.5e-7, 2), "-4.5\\times 10^{-7}");
        assert_eq!(equation("linear", &[2.0, -1.0], 3), "y = 2.00x - 1.00");
    }
}
