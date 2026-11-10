//! MVP の一連の流れ（CSV 取り込み → 図の生成 → 本文コンパイル → SyncTeX）を
//! 実際の LuaLaTeX で通す結合テスト。TeX Live が必要なので `--ignored` で実行する。
//!   cargo test --test pipeline -- --ignored --nocapture

use labreport_lib::csvio::{ColumnCfg, DatasetCfg, ImportCfg};
use labreport_lib::{latex, project, synctex};
use serde_json::json;

#[test]
#[ignore]
fn csv_to_pdf() {
    let root = std::env::temp_dir().join(format!("labreport_test_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let dir = root.join("実験1 オームの法則");
    let work = root.join("local");
    std::fs::create_dir_all(&dir).unwrap();

    project::create(&dir, "オームの法則").unwrap();

    // Shift_JIS・ヘッダ前に機器情報がある CSV
    let src = root.join("meas.csv");
    let (bytes, _, _) = encoding_rs::SHIFT_JIS.encode("測定器,XYZ-100\r\n電流 [mA],電圧 [V]\r\n1,0.52\r\n2,0.98\r\n3,1.55\r\n4,2.01\r\n5,2.47\r\n6,3.60\r\n");
    std::fs::write(&src, &bytes).unwrap();
    let rel = project::import_data(&dir, &src).unwrap();
    assert_eq!(rel, "data/meas.csv");
    assert_eq!(project::import_data(&dir, &src).unwrap(), "data/meas.csv");
    assert!(project::write_text(&dir, "data/meas.csv", "x").is_err());

    let ds = DatasetCfg {
        id: "d1".into(),
        name: "meas".into(),
        file: rel,
        import: ImportCfg {
            header_row: 1,
            data_start: 2,
            columns: vec![
                ColumnCfg { index: 0, name: "電流".into(), unit: "mA".into(), used: true },
                ColumnCfg { index: 1, name: "電圧".into(), unit: "V".into(), used: true },
            ],
            ..Default::default()
        },
    };
    let fig = json!({
        "width": 8, "height": 5.5, "fontSize": 10, "legendPos": "north west", "sigDigits": 4,
        "xAxis": {"label": "電流 $I$", "unit": "mA", "grid": true},
        "yAxis": {"label": "電圧 $V$", "unit": "V", "grid": true},
        "series": [
            {"id": "s1", "kind": "data", "dataset": "d1", "xCol": 0, "yCol": 1, "legend": "測定値", "lineStyle": "none", "marker": "*", "color": "#1f77b4"},
            {"id": "s2", "kind": "fit", "source": "s1", "model": "linear", "legend": "一次フィット", "color": "#d62728", "macroPrefix": "ohm", "range": [0.5, 5.5]},
            {"id": "s3", "kind": "theory", "expr": "R*x", "params": {"R": 0.5}, "compare": "s1", "threshold": 10, "legend": "理論", "color": "#2ca02c", "lineStyle": "dashed", "macroPrefix": "th"}
        ]
    });
    let t = std::time::Instant::now();
    let r = latex::build_figure(&work, &dir, &[ds.clone()], "fig1", &fig).unwrap();
    println!("figure build: {:?}  errors={:?}\n{}", t.elapsed(), r.errors, r.log_tail);
    assert!(r.errors.is_empty());
    assert!(r.pdf_changed && r.values_changed && !r.cached);
    assert!(dir.join("figures/fig1.pdf").exists() && dir.join("figures/fig1.tex").exists());
    let fitres = r.computed.series[1].fit.as_ref().unwrap();
    assert_eq!(fitres.n, 5); // 範囲外の 6 点目は除外
    assert!((fitres.coeffs[0] - 0.493).abs() < 1e-9, "{:?}", fitres.coeffs);
    let th = r.computed.series[2].theory.as_ref().unwrap();
    assert_eq!(th.outliers, vec![[6.0, 3.6]]);
    let values = std::fs::read_to_string(dir.join("values.tex")).unwrap();
    println!("{values}");
    assert!(values.contains("\\newcommand{\\ohmSlope}{0.4930}"));
    assert!(values.contains("\\thMaxErr"));

    // 変更なし → キャッシュ
    let t = std::time::Instant::now();
    let r2 = latex::build_figure(&work, &dir, &[ds.clone()], "fig1", &fig).unwrap();
    println!("cached build: {:?}", t.elapsed());
    assert!(r2.cached && !r2.pdf_changed && !r2.values_changed);

    // 本文
    let main = "\\documentclass[11pt,a4paper]{ltjsarticle}\n\\usepackage{graphicx}\n\\input{values}\n\\begin{document}\n\\section{結果}\n傾きは \\ohmSlope{} であった。\n\n\\begin{figure}[htbp]\n\\centering\n\\includegraphics[width=0.8\\linewidth]{figures/fig1.pdf}\n\\caption{測定結果}\\label{fig:a}\n\\end{figure}\n\n図\\ref{fig:a}を見よ。\n\\end{document}\n";
    project::write_text(&dir, "main.tex", main).unwrap();
    let t = std::time::Instant::now();
    let c = latex::compile_main(&work, &dir, "main.tex").unwrap();
    println!("compile: {:?} runs={} errors={:?} warnings={:?}", t.elapsed(), c.runs, c.errors, c.warnings);
    assert!(c.ok, "{}", c.log_tail);
    assert!(c.runs >= 2);
    assert!(dir.join("main.pdf").exists());
    // 中間ファイルはプロジェクトに置かない
    for ext in ["aux", "log", "synctex", "synctex.gz"] {
        assert!(!dir.join(format!("main.{ext}")).exists());
    }

    // SyncTeX: ソース → PDF → ソース
    let boxes = synctex::view(&work, &dir, "main.tex", "main.tex", 6).unwrap();
    println!("view line 6: {boxes:?}");
    assert!(!boxes.is_empty());
    let b = &boxes[0];
    let pos = synctex::edit(&work, &dir, "main.tex", b.page, b.h + 20.0, b.v - 2.0).unwrap().unwrap();
    println!("edit: {pos:?}");
    assert_eq!((pos.file.as_str(), pos.line), ("main.tex", 6));
    let fb = synctex::view(&work, &dir, "main.tex", "main.tex", 10).unwrap();
    println!("view line 10 (figure): {fb:?}");
    assert!(!fb.is_empty());

    // エラー行
    project::write_text(&dir, "main.tex", &main.replace("傾きは", "\\undefinedmacro 傾きは")).unwrap();
    let c = latex::compile_main(&work, &dir, "main.tex").unwrap();
    println!("errors: {:?}", c.errors);
    assert!(!c.ok);
    assert_eq!((c.errors[0].file.as_str(), c.errors[0].line), ("main.tex", 6));

    let _ = std::fs::remove_dir_all(&root);
}
