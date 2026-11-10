//! CSV の読み込み。測定器ごとに形式がバラバラである前提で、
//! 文字コード・区切り文字・見出し行・除外行・使用列をすべて設定で受け取る。

use crate::util::{self, R};
use encoding_rs::Encoding;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ColumnCfg {
    pub index: usize,
    pub name: String,
    pub unit: String,
    pub used: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportCfg {
    pub encoding: String,
    pub delimiter: String,
    /// 見出し行（0始まり）。無ければ -1
    pub header_row: i64,
    /// データ開始行（0始まり）
    pub data_start: usize,
    /// 個別に読み飛ばす行（0始まり）
    pub excluded_rows: Vec<usize>,
    pub columns: Vec<ColumnCfg>,
}

impl Default for ImportCfg {
    fn default() -> Self {
        ImportCfg {
            encoding: "auto".into(),
            delimiter: "auto".into(),
            header_row: -1,
            data_start: 0,
            excluded_rows: vec![],
            columns: vec![],
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DatasetCfg {
    pub id: String,
    pub name: String,
    /// プロジェクトからの相対パス (data/xxx.csv)
    pub file: String,
    pub import: ImportCfg,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub encoding: String,
    pub delimiter: String,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    pub max_cols: usize,
}

#[derive(Serialize, Clone, Debug)]
pub struct Column {
    pub index: usize,
    pub name: String,
    pub unit: String,
    pub values: Vec<f64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Table {
    pub columns: Vec<Column>,
    pub rows: usize,
}

impl Table {
    pub fn column(&self, index: usize) -> Option<&Column> {
        self.columns.iter().find(|c| c.index == index)
    }
}

pub fn decode(bytes: &[u8], enc: &str) -> (String, String) {
    if enc != "auto" && !enc.is_empty() {
        if let Some(e) = Encoding::for_label(enc.as_bytes()) {
            let (s, used, _) = e.decode(bytes);
            return (s.into_owned(), used.name().to_lowercase());
        }
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return (String::from_utf8_lossy(&bytes[3..]).into_owned(), "utf-8".into());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (s, _, _) = encoding_rs::UTF_16LE.decode(bytes);
        return (s.into_owned(), "utf-16le".into());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (s, _, _) = encoding_rs::UTF_16BE.decode(bytes);
        return (s.into_owned(), "utf-16be".into());
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return (s.to_string(), "utf-8".into());
    }
    for e in [encoding_rs::SHIFT_JIS, encoding_rs::EUC_JP] {
        let (s, _, bad) = e.decode(bytes);
        if !bad {
            return (s.into_owned(), e.name().to_lowercase());
        }
    }
    let (s, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
    (s.into_owned(), "windows-1252".into())
}

fn lines(text: &str) -> Vec<&str> {
    let mut v: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    // 古い Mac 形式 (CR のみ)
    if v.len() == 1 && text.contains('\r') {
        v = text.split('\r').collect();
    }
    while v.last().map_or(false, |l| l.trim().is_empty()) {
        v.pop();
    }
    v
}

pub fn detect_delimiter(ls: &[&str]) -> String {
    let sample: Vec<&&str> = ls.iter().filter(|l| !l.trim().is_empty()).take(40).collect();
    let mut best = (",", 0usize);
    for (name, ch) in [("tab", '\t'), (",", ','), (";", ';')] {
        let n = sample.iter().filter(|l| l.contains(ch)).count();
        if n > best.1 {
            best = (name, n);
        }
    }
    if best.1 == 0 {
        let n = sample.iter().filter(|l| l.trim().split_whitespace().count() > 1).count();
        if n > 0 {
            return "space".into();
        }
    }
    best.0.into()
}

pub fn split_line(line: &str, delim: &str) -> Vec<String> {
    if delim == "space" {
        return line.split_whitespace().map(String::from).collect();
    }
    let d = match delim {
        "tab" => '\t',
        ";" => ';',
        _ => ',',
    };
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut inq = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if inq {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    cur.push('"');
                    chars.next();
                } else {
                    inq = false;
                }
            } else {
                cur.push(c);
            }
        } else if c == '"' && cur.trim().is_empty() {
            inq = true;
            cur.clear();
        } else if c == d {
            out.push(std::mem::take(&mut cur).trim().to_string());
        } else {
            cur.push(c);
        }
    }
    out.push(cur.trim().to_string());
    out
}

pub fn parse_num(s: &str, allow_decimal_comma: bool) -> f64 {
    let t = s.trim().trim_matches('"').trim();
    if t.is_empty() {
        return f64::NAN;
    }
    let t = t.replace(['\u{2212}', '\u{FF0D}', '\u{2013}'], "-");
    if let Ok(v) = t.parse::<f64>() {
        return v;
    }
    if allow_decimal_comma && t.contains(',') && !t.contains('.') {
        if let Ok(v) = t.replace(',', ".").parse::<f64>() {
            return v;
        }
    }
    f64::NAN
}

fn resolve<'a>(text: &'a str, delimiter: &str) -> (Vec<&'a str>, String) {
    let ls = lines(text);
    let d = if delimiter == "auto" || delimiter.is_empty() {
        detect_delimiter(&ls)
    } else {
        delimiter.to_string()
    };
    (ls, d)
}

pub fn preview(path: &Path, encoding: &str, delimiter: &str, max_rows: usize) -> R<Preview> {
    let bytes = util::read_bytes(path)?;
    let (text, enc) = decode(&bytes, encoding);
    let (ls, d) = resolve(&text, delimiter);
    let rows: Vec<Vec<String>> = ls.iter().take(max_rows).map(|l| split_line(l, &d)).collect();
    let max_cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    Ok(Preview { encoding: enc, delimiter: d, total_rows: ls.len(), rows, max_cols })
}

type CacheEntry = (SystemTime, u64, u64, Arc<Table>);

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static C: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 設定に従って数値表として読み込む。使用列だけを返す。ファイルの更新時刻と設定でキャッシュする。
pub fn load(dir: &Path, ds: &DatasetCfg) -> R<Arc<Table>> {
    let path = util::join_rel(dir, &ds.file)?;
    let key = path.to_string_lossy().to_string();
    let cfg_hash = util::fnv(serde_json::to_string(&ds.import).unwrap_or_default().as_bytes());
    let meta = std::fs::metadata(&path).ok();
    let stamp = meta.as_ref().and_then(|m| m.modified().ok());
    let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    if let Some(st) = stamp {
        if let Some((t, l, h, tab)) = cache().lock().unwrap().get(&key) {
            if *t == st && *l == len && *h == cfg_hash {
                return Ok(tab.clone());
            }
        }
    }
    let bytes = util::read_bytes(&path)?;
    let table = Arc::new(parse(&bytes, &ds.import));
    if let Some(st) = stamp {
        cache().lock().unwrap().insert(key, (st, len, cfg_hash, table.clone()));
    }
    Ok(table)
}

pub fn parse(bytes: &[u8], cfg: &ImportCfg) -> Table {
    let (text, _) = decode(bytes, &cfg.encoding);
    let (ls, d) = resolve(&text, &cfg.delimiter);
    let used: Vec<&ColumnCfg> = cfg.columns.iter().filter(|c| c.used).collect();
    let mut cols: Vec<Column> = used
        .iter()
        .map(|c| Column { index: c.index, name: c.name.clone(), unit: c.unit.clone(), values: Vec::new() })
        .collect();
    let excluded: std::collections::HashSet<usize> = cfg.excluded_rows.iter().copied().collect();
    let decimal_comma = d != ",";
    let mut rows = 0;
    for (i, line) in ls.iter().enumerate() {
        if i < cfg.data_start || i as i64 == cfg.header_row || excluded.contains(&i) || line.trim().is_empty() {
            continue;
        }
        let cells = split_line(line, &d);
        for (k, c) in used.iter().enumerate() {
            let v = cells.get(c.index).map_or(f64::NAN, |s| parse_num(s, decimal_comma));
            cols[k].values.push(v);
        }
        rows += 1;
    }
    Table { columns: cols, rows }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoted_and_shift_jis() {
        assert_eq!(split_line("\"a,b\", 2 ,\"x\"\"y\"", ","), vec!["a,b", "2", "x\"y"]);
        let (bytes, _, _) = encoding_rs::SHIFT_JIS.encode("電圧,電流\r\n1.0,2.5\r\n");
        let (s, enc) = decode(&bytes, "auto");
        assert_eq!(enc, "shift_jis");
        assert!(s.starts_with("電圧"));
    }

    #[test]
    fn parse_messy() {
        let src = "Instrument: XYZ\nDate; 2026\n\nt [s]\tV [V]\n0\t1,5\n1\t2.5\nbad\tline\n2\t−3e-1\n";
        let cfg = ImportCfg {
            header_row: 3,
            data_start: 4,
            excluded_rows: vec![6],
            columns: vec![
                ColumnCfg { index: 0, name: "t".into(), unit: "s".into(), used: true },
                ColumnCfg { index: 1, name: "V".into(), unit: "V".into(), used: true },
            ],
            ..Default::default()
        };
        let t = parse(src.as_bytes(), &cfg);
        assert_eq!(t.rows, 3);
        assert_eq!(t.columns[0].values, vec![0.0, 1.0, 2.0]);
        assert_eq!(t.columns[1].values, vec![1.5, 2.5, -0.3]);
    }
}
