// LaTeX 風の文字列（$V_0$, \alpha, x^{2} など）を SVG の tspan に変換する簡易レンダラ。
// グラフの即時プレビュー用。最終的な組版は LuaLaTeX が行う。

import { s } from "./ui";

export interface Seg {
  t: string;
  italic: boolean;
  level: number;
}

const SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ",
  upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  times: "×", cdot: "·", pm: "±", mp: "∓", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠",
  approx: "≈", sim: "∼", simeq: "≃", propto: "∝", infty: "∞", partial: "∂", degree: "°", circ: "∘",
  to: "→", rightarrow: "→", leftarrow: "←", quad: "  ", qquad: "    ", ell: "ℓ", hbar: "ℏ", angle: "∠",
  ohm: "Ω", micro: "µ", celsius: "℃", percent: "%", textmu: "µ", prime: "′",
};
const UPRIGHT_FUNCS = new Set(["sin", "cos", "tan", "ln", "log", "exp", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "max", "min", "lim", "det"]);
const UPRIGHT_CMDS = new Set(["mathrm", "text", "textrm", "textbf", "mathbf", "mathsf", "operatorname", "si", "SI", "unit", "textup", "mbox"]);
const IGNORED = new Set(["left", "right", "displaystyle", "textstyle", "bigl", "bigr", "Bigl", "Bigr", "big", "Big", "mathstrut", "selectfont", "limits", "nolimits"]);

export function parseTex(src: string): Seg[] {
  let i = 0;
  let math = false;

  function run(end: string | null, level: number, upright: boolean, out: Seg[]): void {
    while (i < src.length) {
      const c = src[i];
      if (end !== null && c === end) {
        i++;
        return;
      }
      if (c === "$") {
        math = !math;
        i++;
      } else if (c === "\\") {
        i++;
        let name = "";
        while (i < src.length && /[A-Za-z]/.test(src[i])) name += src[i++];
        if (!name) {
          const sym = src[i++] ?? "";
          if (sym === "," || sym === ";" || sym === " " || sym === ":") out.push({ t: " ", italic: false, level });
          else if (sym === "\\") out.push({ t: " ", italic: false, level });
          else if (sym !== "!") out.push({ t: sym, italic: false, level });
          continue;
        }
        if (src[i] === " ") i++; // 命令直後の空白は区切り
        if (name in SYMBOLS) {
          const ch = SYMBOLS[name];
          out.push({ t: ch, italic: math && !upright && /[α-ω]/.test(ch), level });
        } else if (UPRIGHT_FUNCS.has(name)) {
          out.push({ t: name, italic: false, level });
        } else if (UPRIGHT_CMDS.has(name) || name === "mathit" || name === "textit") {
          group(level, name !== "mathit" && name !== "textit", out);
        } else if (name === "frac" || name === "dfrac" || name === "tfrac") {
          const a: Seg[] = [];
          const b: Seg[] = [];
          group(level, upright, a);
          group(level, upright, b);
          const wrap = (g: Seg[]) => {
            const long = g.map((x) => x.t).join("").length > 1;
            if (long) out.push({ t: "(", italic: false, level });
            out.push(...g);
            if (long) out.push({ t: ")", italic: false, level });
          };
          wrap(a);
          out.push({ t: "/", italic: false, level });
          wrap(b);
        } else if (name === "sqrt") {
          out.push({ t: "√(", italic: false, level });
          group(level, upright, out);
          out.push({ t: ")", italic: false, level });
        } else if (!IGNORED.has(name)) {
          out.push({ t: name, italic: false, level });
        }
      } else if ((c === "^" || c === "_") && math) {
        i++;
        const lv = c === "^" ? 1 : -1;
        if (src[i] === "{") group(lv, upright, out);
        else if (src[i] === "\\") {
          // 1 命令だけ
          const save = out.length;
          const start = i;
          i++;
          while (i < src.length && /[A-Za-z]/.test(src[i])) i++;
          const sub = src.slice(start, i);
          const inner = parseInner(sub, true);
          out.splice(save, 0);
          out.push(...inner.map((x) => ({ ...x, level: lv })));
        } else if (i < src.length) {
          const ch = src[i++];
          out.push({ t: ch === "-" ? "−" : ch, italic: /[A-Za-z]/.test(ch) && !upright, level: lv });
        }
      } else if (c === "{") {
        i++;
        run("}", level, upright, out);
      } else if (c === "}") {
        i++;
      } else if (c === "~") {
        i++;
        out.push({ t: " ", italic: false, level });
      } else {
        i++;
        if (math) {
          if (c === " ") continue;
          if (c === "-") out.push({ t: "−", italic: false, level });
          else if (c === "*") out.push({ t: "·", italic: false, level });
          else if ("=+<>".includes(c) && level === 0) out.push({ t: ` ${c} `, italic: false, level });
          else out.push({ t: c, italic: /[A-Za-z]/.test(c) && !upright, level });
        } else {
          out.push({ t: c, italic: false, level });
        }
      }
    }
  }

  function group(level: number, upright: boolean, out: Seg[]): void {
    if (src[i] === "{") {
      i++;
      run("}", level, upright, out);
    } else if (i < src.length) {
      const ch = src[i++];
      out.push({ t: ch, italic: math && /[A-Za-z]/.test(ch) && !upright, level });
    }
  }

  const out: Seg[] = [];
  run(null, 0, false, out);
  // 同じ書式の連続をまとめる
  const merged: Seg[] = [];
  for (const g of out) {
    const last = merged[merged.length - 1];
    if (last && last.italic === g.italic && last.level === g.level) last.t += g.t;
    else merged.push({ ...g });
  }
  return merged;
}

function parseInner(src: string, math: boolean): Seg[] {
  return parseTex(math ? `$${src}$` : src);
}

export function plainText(src: string): string {
  return parseTex(src).map((x) => x.t).join("");
}

/** text 要素の中身を tspan で組み立てる。fontSize は text 要素の基準サイズ（ユーザー単位）。 */
export function fillText(el: SVGTextElement, src: string, fontSize: number): void {
  while (el.firstChild) el.removeChild(el.firstChild);
  let shift = 0; // 現在のベースラインのずれ（下向き正）
  for (const g of parseTex(src)) {
    const target = g.level > 0 ? -0.38 * fontSize : g.level < 0 ? 0.18 * fontSize : 0;
    const t = s("tspan", {
      dy: target - shift !== 0 ? (target - shift).toFixed(2) : null,
      "font-size": g.level !== 0 ? (fontSize * 0.72).toFixed(2) : null,
      "font-style": g.italic ? "italic" : null,
    }, g.t);
    shift = target;
    el.append(t);
  }
  if (shift !== 0) el.append(s("tspan", { dy: (-shift).toFixed(2) }, "​"));
}
