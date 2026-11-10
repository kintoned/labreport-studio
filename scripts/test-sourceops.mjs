// node scripts/test-sourceops.mjs — ソース書き換え関数の簡易テスト
import assert from "node:assert/strict";
import * as so from "../src/sourceops.ts";

const doc = () => String.raw`\documentclass{ltjsarticle}
\usepackage{graphicx}
\begin{document}
\section{結果}
段落A一行目
段落A二行目

\begin{figure}[htbp]
  \centering
  \includegraphics[width=0.8\linewidth]{figures/fig1.pdf}
  \caption{測定}
\end{figure}

段落B

段落C
\end{document}`.split("\n");

let L = doc();
const hit = so.findFigureAt(L, 10);
assert.deepEqual(hit, { envStart: 7, envEnd: 11, hasEnv: true, gfxLine: 9, name: "fig1", mode: "pdf" });
assert.equal(so.findFigureAt(L, 4), null);
assert.equal(so.findFigureAt(L, 13), null);
assert.equal(so.findFigureAt([String.raw`\input{figures/図2.tex}`], 0).mode, "input");
assert.equal(so.findFigureAt([String.raw`% \includegraphics{figures/a.pdf}`], 0), null);

assert.equal(so.scaleWidth(L[9], 0.5, 100).trim(), String.raw`\includegraphics[width=0.4\linewidth]{figures/fig1.pdf}`);
assert.equal(so.scaleWidth(String.raw`\includegraphics[width=8cm,clip]{a}`, 1.25, 0), String.raw`\includegraphics[width=10cm,clip]{a}`);
assert.equal(so.scaleWidth(String.raw`\includegraphics[width=\linewidth]{a}`, 0.6, 0), String.raw`\includegraphics[width=0.6\linewidth]{a}`);
assert.equal(so.scaleWidth(String.raw`\includegraphics{a}`, 2, 283.465), String.raw`\includegraphics[width=10cm]{a}`);
assert.equal(so.scaleWidth(String.raw`\includegraphics[scale=0.5]{a}`, 2, 0), String.raw`\includegraphics[scale=1]{a}`);

assert.equal(so.getPlacement(L, 7), "htbp");
so.setPlacement(L, 7, "H"); assert.equal(L[7], String.raw`\begin{figure}[H]`);
so.setPlacement(L, 7, ""); assert.equal(L[7], String.raw`\begin{figure}`);
assert.equal(so.togglePlacement("htbp", "t"), "hbp");
assert.equal(so.togglePlacement("hb", "t"), "htb");
assert.equal(so.togglePlacement("htbp", "H"), "H");
assert.equal(so.togglePlacement("H", "t"), "t");
assert.equal(so.ensureFloatPackage(L), true); assert.equal(L[2], String.raw`\usepackage{float}`);
assert.equal(so.ensureFloatPackage(L), false);

L = doc();
let at = so.moveFigure(L, 7, 11, -1);
assert.equal(L[at], String.raw`\begin{figure}[htbp]`);
assert.equal(L.slice(3, 6).join("|"), String.raw`\section{結果}||\begin{figure}[htbp]`); // 図は節見出しの直後（空行を挟む）
assert.ok(L.indexOf("段落A一行目") > at);
assert.equal(so.moveFigure(L, at, at + 4, -1), null); // 節見出しは越えない
L = doc();
at = so.moveFigure(L, 7, 11, 1);
assert.ok(L.indexOf("段落B") < at && at < L.indexOf("段落C"));
at = so.moveFigure(L, at, at + 4, 1);
assert.ok(L.indexOf("段落C") < at && at < L.length - 1);
assert.equal(so.moveFigure(L, at, at + 4, 1), null); // \end{document} は越えない
assert.equal(L.filter((l) => l.includes("includegraphics")).length, 1);

L = doc();
assert.deepEqual(so.paragraphRange(L, 5), [4, 5]);
assert.deepEqual(so.paragraphRange(L, 3), [3, 3]);
assert.equal(so.ensureCoverInput(L), true); assert.equal(L[3], String.raw`\input{cover}`);
assert.equal(so.ensureCoverInput(L), false);
console.log("sourceops: all ok");
