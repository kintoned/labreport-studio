// 小さな DOM ヘルパー群（フレームワーク無しで軽く保つ）

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown>;

function append(el: Element, c: Child): void {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) c.forEach((x) => append(el, x));
  else el.append(c instanceof Node ? c : String(c));
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k in el && k !== "list") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

const SVGNS = "http://www.w3.org/2000/svg";
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, string | number | null | undefined>, ...children: (Node | string)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let toastBox: HTMLElement | null = null;
export function toast(msg: string, kind: "info" | "error" | "ok" = "info", action?: { label: string; run: () => void }, ms = 5000): HTMLElement {
  if (!toastBox) {
    toastBox = h("div", { class: "toasts" });
    document.body.append(toastBox);
  }
  const el = h("div", { class: `toast ${kind}` }, h("span", { class: "toast-msg" }, msg));
  if (action) {
    el.append(
      h("button", {
        class: "btn small primary",
        onclick: () => {
          action.run();
          el.remove();
        },
      }, action.label),
    );
  }
  el.append(h("button", { class: "toast-x", title: "閉じる", onclick: () => el.remove() }, "×"));
  toastBox.append(el);
  if (ms > 0) setTimeout(() => el.remove(), kind === "error" ? ms * 2 : ms);
  return el;
}

export function showError(e: unknown): void {
  console.error(e);
  toast(errText(e), "error");
}

export interface ModalHandle {
  close: () => void;
  body: HTMLElement;
  footer: HTMLElement;
}

export function modal(title: string, opts: { wide?: boolean; onClose?: () => void } = {}): ModalHandle {
  const body = h("div", { class: "modal-body" });
  const footer = h("div", { class: "modal-footer" });
  const close = () => {
    back.remove();
    document.removeEventListener("keydown", onKey, true);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && document.body.lastElementChild === back) {
      e.stopPropagation();
      close();
    }
  };
  const box = h("div", { class: `modal ${opts.wide ? "wide" : ""}` },
    h("div", { class: "modal-head" }, h("span", null, title), h("button", { class: "icon-btn", onclick: close, title: "閉じる" }, "×")),
    body,
    footer,
  );
  const back = h("div", { class: "modal-back", onmousedown: (e: MouseEvent) => e.target === back && close() }, box);
  document.body.append(back);
  document.addEventListener("keydown", onKey, true);
  return { close, body, footer };
}

export function promptText(title: string, label: string, initial = "", okLabel = "OK"): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
      m.close();
    };
    const m = modal(title, { onClose: () => finish(null) });
    const input = h("input", { class: "input", type: "text", value: initial, style: { width: "100%" } });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(input.value.trim() || null);
    });
    m.body.append(h("label", { class: "field col" }, h("span", null, label), input));
    m.footer.append(
      h("button", { class: "btn", onclick: () => finish(null) }, "キャンセル"),
      h("button", { class: "btn primary", onclick: () => finish(input.value.trim() || null) }, okLabel),
    );
    setTimeout(() => {
      input.focus();
      input.select();
    });
  });
}

export function confirmBox(title: string, message: string, okLabel = "OK"): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      resolve(v);
      m.close();
    };
    const m = modal(title, { onClose: () => finish(false) });
    m.body.append(h("p", { style: { whiteSpace: "pre-wrap", margin: "0" } }, message));
    m.footer.append(
      h("button", { class: "btn", onclick: () => finish(false) }, "キャンセル"),
      h("button", { class: "btn primary", onclick: () => finish(true) }, okLabel),
    );
  });
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { cancel: () => void } {
  let t: ReturnType<typeof setTimeout> | undefined;
  const f = (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  f.cancel = () => clearTimeout(t);
  return f;
}

/** 表示用の数値整形（有効数字 sig 桁） */
export function fmt(v: number | null | undefined, sig = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const e = Math.floor(Math.log10(Math.abs(v)));
  if (e >= -3 && e < 5) return v.toFixed(Math.max(0, Math.min(12, sig - 1 - e)));
  return v.toExponential(Math.max(0, sig - 1)).replace("e+", "e");
}

export async function copyText(text: string, what = "コピーしました"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(what, "ok", undefined, 1800);
  } catch (e) {
    showError(e);
  }
}

// ---- フォーム部品 ----

export function row(label: string, control: Child, hint?: string): HTMLElement {
  return h("label", { class: "field", title: hint }, h("span", { class: "field-label" }, label), control);
}

export function textInput(value: string, onInput: (v: string) => void, attrs: Attrs = {}): HTMLInputElement {
  const el = h("input", { class: "input", type: "text", value, spellcheck: false, ...attrs });
  el.addEventListener("input", () => onInput(el.value));
  return el;
}

/** 数値入力。nullable のとき空欄は null（＝自動） */
export function numInput(value: number | null, onInput: (v: number | null) => void, opts: { nullable?: boolean; step?: number; min?: number; max?: number; placeholder?: string } = {}): HTMLInputElement {
  const el = h("input", {
    class: "input num",
    type: "number",
    step: opts.step ?? "any",
    min: opts.min,
    max: opts.max,
    placeholder: opts.placeholder ?? (opts.nullable ? "自動" : ""),
    value: value === null || value === undefined ? "" : String(value),
  });
  el.addEventListener("input", () => {
    if (el.value.trim() === "") {
      if (opts.nullable) onInput(null);
      return;
    }
    const v = Number(el.value);
    if (!Number.isFinite(v)) return;
    if (opts.min !== undefined && v < opts.min) return;
    if (opts.max !== undefined && v > opts.max) return;
    onInput(v);
  });
  return el;
}

export function selectInput(value: string, options: [string, string][], onChange: (v: string) => void): HTMLSelectElement {
  const el = h("select", { class: "input" }, options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
  el.value = value;
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

export function checkInput(value: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const el = h("input", { type: "checkbox", checked: value });
  el.addEventListener("change", () => onChange(el.checked));
  return el;
}

export function colorInput(value: string, onInput: (v: string) => void): HTMLInputElement {
  const el = h("input", { type: "color", class: "color", value });
  el.addEventListener("input", () => onInput(el.value));
  return el;
}
