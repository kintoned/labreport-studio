// PDF 直接編集のための LaTeX ソース書き換え（純粋関数）。
// 行番号はすべて 0 始まりの配列インデックス。

export interface FigureHit {
  /** figure 環境の開始・終了行（環境が無ければ画像の行そのもの） */
  envStart: number;
  envEnd: number;
  hasEnv: boolean;
  /** \includegraphics / \input のある行 */
  gfxLine: number;
  /** figures/NAME の NAME */
  name: string;
  /** pdf: \includegraphics、input: \input（pgfplots コードを直接読み込み） */
  mode: "pdf" | "input";
}

const GFX = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{\s*(?:\.\/)?figures\/([^}]+?)(?:\.pdf)?\s*\}/;
const INPUT = /\\input\s*\{\s*(?:\.\/)?figures\/([^}]+?)(?:\.tex)?\s*\}/;
const BEGIN = /\\begin\{figure\*?\}/;
const END = /\\end\{figure\*?\}/;

const code = (l: string) => l.replace(/(^|[^\\])%.*$/, "$1");

function gfxAt(line: string): { name: string; mode: "pdf" | "input" } | null {
  const c = code(line);
  const a = c.match(GFX);
  if (a) return { name: a[1], mode: "pdf" };
  const b = c.match(INPUT);
  if (b) return { name: b[1], mode: "input" };
  return null;
}

/** line を含む figure 環境、または line 上の図の読み込みを探す */
export function findFigureAt(lines: string[], line: number): FigureHit | null {
  if (line < 0 || line >= lines.length) return null;
  let start = -1;
  for (let i = line; i >= 0 && i > line - 200; i--) {
    const c = code(lines[i]);
    if (i < line && END.test(c)) break;
    if (BEGIN.test(c)) {
      start = i;
      break;
    }
  }
  if (start >= 0) {
    let end = -1;
    for (let i = start; i < lines.length && i < start + 400; i++) {
      if (END.test(code(lines[i]))) {
        end = i;
        break;
      }
    }
    if (end >= line) {
      for (let i = start; i <= end; i++) {
        const g = gfxAt(lines[i]);
        if (g) return { envStart: start, envEnd: end, hasEnv: true, gfxLine: i, ...g };
      }
      return null;
    }
  }
  const g = gfxAt(lines[line]);
  return g ? { envStart: line, envEnd: line, hasEnv: false, gfxLine: line, ...g } : null;
}

const round = (v: number, d: number) => String(Number(v.toFixed(d)));

/**
 * \includegraphics の width 指定を factor 倍にする。
 * width が無ければ newWidthBp（ドラッグ後の実寸）から cm で追加する。
 */
export function scaleWidth(line: string, factor: number, newWidthBp: number): string {
  const m = line.match(/\\includegraphics\s*(\[[^\]]*\])?/);
  if (!m) return line;
  const opts = m[1] ? m[1].slice(1, -1) : "";
  let next: string;
  const w = opts.match(/(^|,)\s*width\s*=\s*([^,]*)/);
  const sc = opts.match(/(^|,)\s*scale\s*=\s*([0-9.]+)/);
  if (w) {
    const val = w[2].trim();
    const num = val.match(/^([0-9]*\.?[0-9]+)\s*(.*)$/);
    let nv: string;
    if (num) nv = `${round(parseFloat(num[1]) * factor, num[2].startsWith("\\") ? 3 : 2)}${num[2]}`;
    else if (val.startsWith("\\")) nv = `${round(factor, 3)}${val}`;
    else nv = `${round((newWidthBp / 72) * 2.54, 2)}cm`;
    next = opts.replace(w[0], `${w[1]}width=${nv}`);
  } else if (sc) {
    next = opts.replace(sc[0], `${sc[1]}scale=${round(parseFloat(sc[2]) * factor, 3)}`);
  } else {
    const add = `width=${round((newWidthBp / 72) * 2.54, 2)}cm`;
    next = opts.trim() ? `${add}, ${opts.replace(/(^|,)\s*height\s*=\s*[^,]*/, "").replace(/^\s*,\s*/, "")}` : add;
  }
  return line.replace(m[0], `\\includegraphics[${next}]`);
}

/** figure 環境の配置指定を読む（無ければ空文字） */
export function getPlacement(lines: string[], envStart: number): string {
  const m = code(lines[envStart]).match(/\\begin\{figure\*?\}\s*\[([^\]]*)\]/);
  return m ? m[1] : "";
}

export function setPlacement(lines: string[], envStart: number, placement: string): void {
  const l = lines[envStart];
  const m = l.match(/(\\begin\{figure\*?\})(\s*\[[^\]]*\])?/);
  if (!m) return;
  lines[envStart] = l.replace(m[0], placement ? `${m[1]}[${placement}]` : m[1]);
}

/** h/t/b/p は組み合わせ、H は単独。クリックした文字をトグルした結果を返す。 */
export function togglePlacement(current: string, letter: string): string {
  if (letter === "H") return current === "H" ? "htbp" : "H";
  const set = new Set(current.replace(/[^htbp]/g, "").split(""));
  if (set.has(letter)) set.delete(letter);
  else set.add(letter);
  return ["h", "t", "b", "p"].filter((x) => set.has(x)).join("");
}

/** [H] には float パッケージが要る。無ければプリアンブルに足す。変更したら true。 */
export function ensureFloatPackage(lines: string[]): boolean {
  const doc = lines.findIndex((l) => /\\begin\{document\}/.test(code(l)));
  if (doc < 0) return false;
  for (let i = 0; i < doc; i++) if (/\\usepackage(\[[^\]]*\])?\{[^}]*\bfloat\b[^}]*\}/.test(code(lines[i]))) return false;
  lines.splice(doc, 0, "\\usepackage{float}");
  return true;
}

const blank = (l: string | undefined) => l === undefined || l.trim() === "";
const barrier = (l: string) => /\\(begin|end)\{document\}|\\(section|subsection|subsubsection|chapter|part)\*?[\[{]|\\maketitle|\\tableofcontents|\\appendix|\\newpage|\\clearpage/.test(code(l));

/**
 * 図（figure 環境）を前後の段落をまたいで移動する。dir: -1 = 1 段落前へ、+1 = 1 段落後ろへ。
 * 移動後の envStart を返す。動かせなければ null。
 */
export function moveFigure(lines: string[], envStart: number, envEnd: number, dir: -1 | 1): number | null {
  const block = lines.slice(envStart, envEnd + 1);
  const rest = [...lines.slice(0, envStart), ...lines.slice(envEnd + 1)];
  let pos = envStart; // rest 内で図があった位置
  // 図の跡に残る余分な空行を 1 つにまとめる
  if (blank(rest[pos - 1]) && blank(rest[pos]) && pos < rest.length) rest.splice(pos, 1);

  let target: number;
  if (dir < 0) {
    let i = pos - 1;
    while (i >= 0 && blank(rest[i])) i--;
    if (i < 0 || barrier(rest[i])) return null;
    while (i >= 0 && !blank(rest[i]) && !barrier(rest[i])) i--;
    target = i + 1;
  } else {
    let i = pos;
    while (i < rest.length && blank(rest[i])) i++;
    if (i >= rest.length || barrier(rest[i])) return null;
    while (i < rest.length && !blank(rest[i]) && !barrier(rest[i])) i++;
    target = i;
  }
  const insert: string[] = [];
  if (!blank(rest[target - 1])) insert.push("");
  const at = target + insert.length;
  insert.push(...block);
  if (!blank(rest[target])) insert.push("");
  rest.splice(target, 0, ...insert);
  lines.splice(0, lines.length, ...rest);
  return at;
}

/** line を含む段落（空行で区切られた範囲）。[start, end] */
export function paragraphRange(lines: string[], line: number): [number, number] {
  let a = Math.max(0, Math.min(line, lines.length - 1));
  let b = a;
  if (blank(lines[a])) return [a, a];
  while (a > 0 && !blank(lines[a - 1]) && !barrier(lines[a - 1]) && !barrier(lines[a])) a--;
  while (b < lines.length - 1 && !blank(lines[b + 1]) && !barrier(lines[b + 1]) && !barrier(lines[b])) b++;
  return [a, b];
}

/** 表紙の読み込みを \begin{document} の直後に入れる。変更したら true。 */
export function ensureCoverInput(lines: string[]): boolean {
  if (lines.some((l) => /\\input\s*\{\s*cover(\.tex)?\s*\}/.test(code(l)))) return false;
  const doc = lines.findIndex((l) => /\\begin\{document\}/.test(code(l)));
  if (doc < 0) return false;
  lines.splice(doc + 1, 0, "\\input{cover}");
  return true;
}
