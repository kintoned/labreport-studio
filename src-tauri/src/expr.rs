//! 理論式の構文解析と評価。例: "a*exp(-x/tau) + 2 pi f x"
//! 変数 x、定数 pi / e、任意名のパラメータ、暗黙の乗算に対応する。

use crate::util::R;
use std::collections::BTreeSet;

#[derive(Debug, Clone)]
pub enum Node {
    Num(f64),
    Var(String),
    Neg(Box<Node>),
    Bin(char, Box<Node>, Box<Node>),
    Call(String, Box<Node>),
}

const FUNCS: &[&str] = &[
    "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh", "exp", "ln", "log", "log10", "log2", "sqrt",
    "abs",
];

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Id(String),
    Op(char),
}

fn tokenize(s: &str) -> R<Vec<Tok>> {
    let cs: Vec<char> = s.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    while i < cs.len() {
        let c = cs[i];
        if c.is_whitespace() {
            i += 1;
        } else if c.is_ascii_digit() || (c == '.' && cs.get(i + 1).map_or(false, |d| d.is_ascii_digit())) {
            let st = i;
            while i < cs.len() && (cs[i].is_ascii_digit() || cs[i] == '.') {
                i += 1;
            }
            // 指数部は後ろに数字が続くときだけ（"2e" は 2×e と解釈）
            if i < cs.len() && (cs[i] == 'e' || cs[i] == 'E') {
                let mut j = i + 1;
                if j < cs.len() && (cs[j] == '+' || cs[j] == '-') {
                    j += 1;
                }
                if j < cs.len() && cs[j].is_ascii_digit() {
                    while j < cs.len() && cs[j].is_ascii_digit() {
                        j += 1;
                    }
                    i = j;
                }
            }
            let t: String = cs[st..i].iter().collect();
            out.push(Tok::Num(t.parse::<f64>().map_err(|_| format!("数値として読めません: {t}"))?));
        } else if c.is_alphabetic() || c == '_' {
            let st = i;
            while i < cs.len() && (cs[i].is_alphanumeric() || cs[i] == '_') {
                i += 1;
            }
            out.push(Tok::Id(cs[st..i].iter().collect()));
        } else {
            let op = match c {
                '+' | '-' | '/' | '^' | '(' | ')' => c,
                '−' => '-',
                '×' | '·' => '*',
                '÷' => '/',
                '*' => {
                    if cs.get(i + 1) == Some(&'*') {
                        i += 1;
                        '^'
                    } else {
                        '*'
                    }
                }
                _ => return Err(format!("使えない文字です: {c}")),
            };
            out.push(Tok::Op(op));
            i += 1;
        }
    }
    Ok(out)
}

struct Parser {
    t: Vec<Tok>,
    i: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.t.get(self.i)
    }
    fn eat(&mut self, c: char) -> bool {
        if self.peek() == Some(&Tok::Op(c)) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn expr(&mut self) -> R<Node> {
        let mut l = self.term()?;
        loop {
            if self.eat('+') {
                l = Node::Bin('+', Box::new(l), Box::new(self.term()?));
            } else if self.eat('-') {
                l = Node::Bin('-', Box::new(l), Box::new(self.term()?));
            } else {
                return Ok(l);
            }
        }
    }
    fn term(&mut self) -> R<Node> {
        let mut l = self.unary()?;
        loop {
            if self.eat('*') {
                l = Node::Bin('*', Box::new(l), Box::new(self.unary()?));
            } else if self.eat('/') {
                l = Node::Bin('/', Box::new(l), Box::new(self.unary()?));
            } else if matches!(self.peek(), Some(Tok::Num(_)) | Some(Tok::Id(_)) | Some(Tok::Op('('))) {
                // 暗黙の乗算: 2x, a(x+1), 2 pi x
                l = Node::Bin('*', Box::new(l), Box::new(self.power()?));
            } else {
                return Ok(l);
            }
        }
    }
    fn unary(&mut self) -> R<Node> {
        if self.eat('-') {
            return Ok(Node::Neg(Box::new(self.unary()?)));
        }
        if self.eat('+') {
            return self.unary();
        }
        self.power()
    }
    fn power(&mut self) -> R<Node> {
        let base = self.primary()?;
        if self.eat('^') {
            let e = self.unary()?;
            return Ok(Node::Bin('^', Box::new(base), Box::new(e)));
        }
        Ok(base)
    }
    fn primary(&mut self) -> R<Node> {
        match self.t.get(self.i).cloned() {
            Some(Tok::Num(v)) => {
                self.i += 1;
                Ok(Node::Num(v))
            }
            Some(Tok::Id(name)) => {
                self.i += 1;
                if FUNCS.contains(&name.as_str()) {
                    if !self.eat('(') {
                        return Err(format!("関数 {name} の後には ( が必要です"));
                    }
                    let a = self.expr()?;
                    if !self.eat(')') {
                        return Err("括弧 ) が足りません".into());
                    }
                    Ok(Node::Call(name, Box::new(a)))
                } else {
                    Ok(Node::Var(name))
                }
            }
            Some(Tok::Op('(')) => {
                self.i += 1;
                let a = self.expr()?;
                if !self.eat(')') {
                    return Err("括弧 ) が足りません".into());
                }
                Ok(a)
            }
            Some(Tok::Op(c)) => Err(format!("ここに {c} は置けません")),
            None => Err("式が途中で終わっています".into()),
        }
    }
}

pub fn parse(s: &str) -> R<Node> {
    if s.trim().is_empty() {
        return Err("式が空です".into());
    }
    let mut p = Parser { t: tokenize(s)?, i: 0 };
    let n = p.expr()?;
    if p.i < p.t.len() {
        return Err(match &p.t[p.i] {
            Tok::Op(c) => format!("余分な {c} があります"),
            _ => "式を解釈できません".into(),
        });
    }
    Ok(n)
}

fn constant(name: &str) -> Option<f64> {
    match name {
        "pi" | "π" => Some(std::f64::consts::PI),
        "e" => Some(std::f64::consts::E),
        _ => None,
    }
}

impl Node {
    pub fn eval(&self, x: f64, params: &dyn Fn(&str) -> f64) -> f64 {
        match self {
            Node::Num(v) => *v,
            Node::Var(n) => {
                if n == "x" {
                    x
                } else if let Some(c) = constant(n) {
                    c
                } else {
                    params(n)
                }
            }
            Node::Neg(a) => -a.eval(x, params),
            Node::Bin(op, a, b) => {
                let (l, r) = (a.eval(x, params), b.eval(x, params));
                match op {
                    '+' => l + r,
                    '-' => l - r,
                    '*' => l * r,
                    '/' => l / r,
                    _ => l.powf(r),
                }
            }
            Node::Call(f, a) => {
                let v = a.eval(x, params);
                match f.as_str() {
                    "sin" => v.sin(),
                    "cos" => v.cos(),
                    "tan" => v.tan(),
                    "asin" => v.asin(),
                    "acos" => v.acos(),
                    "atan" => v.atan(),
                    "sinh" => v.sinh(),
                    "cosh" => v.cosh(),
                    "tanh" => v.tanh(),
                    "exp" => v.exp(),
                    "ln" => v.ln(),
                    "log" | "log10" => v.log10(),
                    "log2" => v.log2(),
                    "sqrt" => v.sqrt(),
                    "abs" => v.abs(),
                    _ => f64::NAN,
                }
            }
        }
    }

    /// x と定数以外の識別子（＝パラメータ）
    pub fn params(&self) -> Vec<String> {
        fn walk(n: &Node, out: &mut BTreeSet<String>) {
            match n {
                Node::Var(v) => {
                    if v != "x" && constant(v).is_none() {
                        out.insert(v.clone());
                    }
                }
                Node::Neg(a) | Node::Call(_, a) => walk(a, out),
                Node::Bin(_, a, b) => {
                    walk(a, out);
                    walk(b, out);
                }
                Node::Num(_) => {}
            }
        }
        let mut s = BTreeSet::new();
        walk(self, &mut s);
        s.into_iter().collect()
    }

    fn prec(&self) -> u8 {
        match self {
            Node::Bin('+', ..) | Node::Bin('-', ..) => 1,
            Node::Neg(_) => 2,
            Node::Bin('*', ..) => 3,
            Node::Bin('/', ..) => 5, // \frac は括弧不要
            Node::Bin(..) => 4,
            _ => 5,
        }
    }

    fn wrap(&self, min: u8) -> String {
        let s = self.to_latex();
        if self.prec() < min {
            format!("\\left({s}\\right)")
        } else {
            s
        }
    }

    pub fn to_latex(&self) -> String {
        match self {
            Node::Num(v) => {
                let s = format!("{v}");
                if s.len() > 12 {
                    crate::fit::fmt_latex(*v, 6)
                } else {
                    s
                }
            }
            Node::Var(n) => var_latex(n),
            Node::Neg(a) => format!("-{}", a.wrap(3)),
            Node::Bin(op, a, b) => match op {
                '+' => format!("{} + {}", a.to_latex(), b.wrap(1)),
                '-' => format!("{} - {}", a.to_latex(), b.wrap(2)),
                '*' => {
                    let (l, r) = (a.wrap(3), b.wrap(3));
                    let digit_right = r.chars().next().map_or(false, |c| c.is_ascii_digit() || c == '-');
                    if digit_right {
                        format!("{l} \\cdot {r}")
                    } else {
                        format!("{l} {r}")
                    }
                }
                '/' => format!("\\frac{{{}}}{{{}}}", a.to_latex(), b.to_latex()),
                _ => {
                    let base = match **a {
                        Node::Num(v) if v >= 0.0 => a.to_latex(),
                        Node::Var(_) => a.to_latex(),
                        _ => format!("\\left({}\\right)", a.to_latex()),
                    };
                    format!("{base}^{{{}}}", b.to_latex())
                }
            },
            Node::Call(f, a) => {
                let s = a.to_latex();
                match f.as_str() {
                    "sqrt" => format!("\\sqrt{{{s}}}"),
                    "abs" => format!("\\left|{s}\\right|"),
                    "exp" => format!("e^{{{s}}}"),
                    "log" | "log10" => format!("\\log_{{10}}\\left({s}\\right)"),
                    "log2" => format!("\\log_{{2}}\\left({s}\\right)"),
                    "asin" => format!("\\arcsin\\left({s}\\right)"),
                    "acos" => format!("\\arccos\\left({s}\\right)"),
                    "atan" => format!("\\arctan\\left({s}\\right)"),
                    other => format!("\\{other}\\left({s}\\right)"),
                }
            }
        }
    }
}

const GREEK: &[&str] = &[
    "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu", "nu", "xi",
    "pi", "rho", "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega", "Gamma", "Delta", "Theta", "Lambda", "Xi",
    "Pi", "Sigma", "Phi", "Psi", "Omega",
];

fn var_latex(n: &str) -> String {
    let (head, sub) = match n.split_once('_') {
        Some((h, s)) if !h.is_empty() && !s.is_empty() => (h, Some(s)),
        _ => (n, None),
    };
    let base = if GREEK.contains(&head) {
        format!("\\{head}")
    } else if head.chars().count() == 1 {
        head.to_string()
    } else {
        // V0 のような「1文字＋数字」は添字にする
        let mut cs = head.chars();
        let first = cs.next().unwrap();
        let rest: String = cs.collect();
        if rest.chars().all(|c| c.is_ascii_digit()) {
            format!("{first}_{{{rest}}}")
        } else {
            format!("\\mathrm{{{}}}", head.replace('_', "\\_"))
        }
    };
    match sub {
        Some(s) => format!("{base}_{{{}}}", if s.chars().count() > 1 { format!("\\mathrm{{{}}}", s.replace('_', "\\_")) } else { s.to_string() }),
        None => base,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(s: &str, x: f64) -> f64 {
        parse(s).unwrap().eval(x, &|n| match n {
            "a" => 2.0,
            "tau" => 4.0,
            _ => f64::NAN,
        })
    }

    #[test]
    fn evaluates() {
        assert_eq!(ev("1+2*3", 0.0), 7.0);
        assert_eq!(ev("-x^2", 3.0), -9.0);
        assert_eq!(ev("2^3^2", 0.0), 512.0);
        assert_eq!(ev("2x(x+1)", 3.0), 24.0);
        assert_eq!(ev("2e", 0.0), 2.0 * std::f64::consts::E);
        assert_eq!(ev("1e3 + 2.5E-1", 0.0), 1000.25);
        assert!((ev("a exp(-x/tau)", 4.0) - 2.0 / std::f64::consts::E).abs() < 1e-15);
        assert!((ev("sin(pi/2) + log(100) + ln(e)", 0.0) - 4.0).abs() < 1e-12);
        assert_eq!(ev("2**-1", 0.0), 0.5);
    }

    #[test]
    fn params_and_errors() {
        assert_eq!(parse("V0*exp(-x/(R*C)) + pi").unwrap().params(), vec!["C", "R", "V0"]);
        assert!(parse("2*(x+1").is_err());
        assert!(parse("sin x").is_err());
        assert!(parse("x + ").is_err());
        assert!(parse("x $ 2").is_err());
    }

    #[test]
    fn latex() {
        assert_eq!(parse("a*x/(2*pi)").unwrap().to_latex(), "\\frac{a x}{2 \\pi}");
        assert_eq!(parse("V0*exp(-x/tau)").unwrap().to_latex(), "V_{0} e^{\\frac{-x}{\\tau}}");
        assert_eq!(parse("(a+1)^2 - (x-1)").unwrap().to_latex(), "\\left(a + 1\\right)^{2} - \\left(x - 1\\right)");
    }
}
