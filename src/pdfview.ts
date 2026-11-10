// pdf.js による PDF プレビュー。再コンパイル時は表示中のページを先に描いてから差し替え、ちらつきを抑える。

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api } from "./api";
import { mainFile } from "./latex";
import { emit, S } from "./state";
import { clear, h } from "./ui";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface PageView {
  n: number;
  w: number;
  h: number;
  div: HTMLElement;
  rendered: boolean;
  rendering: Promise<void> | null;
}

export interface PdfPointer {
  page: number;
  /** ページ左上原点、単位 bp（SyncTeX と同じ） */
  x: number;
  y: number;
  div: HTMLElement;
  event: MouseEvent;
}

export const P = {
  scale: 1,
  zoom: 1,
  pages: [] as PageView[],
};

let host: HTMLElement;
let doc: pdfjs.PDFDocumentProxy | null = null;
let observer: IntersectionObserver | null = null;
let handlers: { click?: (p: PdfPointer) => void; dblclick?: (p: PdfPointer) => void } = {};
let generation = 0;

export function initPdf(el: HTMLElement): void {
  host = el;
  let lastW = 0;
  new ResizeObserver(() => {
    if (!doc || host.clientWidth === 0 || Math.abs(host.clientWidth - lastW) < 4) return;
    lastW = host.clientWidth;
    void layout(false);
  }).observe(host);
}

export function setPdfHandlers(hs: typeof handlers): void {
  handlers = hs;
}

export function pageDiv(n: number): HTMLElement | null {
  return P.pages.find((p) => p.n === n)?.div ?? null;
}

export function clearPdf(): void {
  generation++;
  clear(host);
  host.append(h("div", { class: "empty" }, "PDF はまだありません"));
  P.pages = [];
  void doc?.loadingTask.destroy();
  doc = null;
}

export function setZoom(z: number): void {
  P.zoom = Math.max(0.3, Math.min(5, z));
  void layout(false);
}

async function renderPage(d: pdfjs.PDFDocumentProxy, pv: PageView, scale: number): Promise<void> {
  if (pv.rendered) return;
  if (pv.rendering) return pv.rendering;
  pv.rendering = (async () => {
    const page = await d.getPage(pv.n);
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const vp = page.getViewport({ scale: scale * dpr });
    const canvas = h("canvas", { width: Math.floor(vp.width), height: Math.floor(vp.height) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport: vp } as any).promise;
    pv.div.querySelector("canvas")?.remove();
    pv.div.prepend(canvas);
    pv.rendered = true;
  })().finally(() => (pv.rendering = null));
  return pv.rendering;
}

async function layout(fresh: boolean): Promise<void> {
  if (!doc) return;
  const d = doc;
  const gen = ++generation;
  const sizes: { w: number; h: number }[] = [];
  if (fresh || P.pages.length !== d.numPages) {
    for (let i = 1; i <= d.numPages; i++) {
      const vp = (await d.getPage(i)).getViewport({ scale: 1 });
      sizes.push({ w: vp.width, h: vp.height });
    }
  } else {
    for (const p of P.pages) sizes.push({ w: p.w, h: p.h });
  }
  if (gen !== generation) return;
  const maxW = Math.max(...sizes.map((x) => x.w), 1);
  const scale = (Math.max(200, host.clientWidth - 30) / maxW) * P.zoom;
  const oldScale = P.scale || scale;
  const scrollTop = (host.scrollTop * scale) / oldScale;

  const pages: PageView[] = sizes.map((sz, i) => {
    const div = h("div", { class: "pdf-page", style: { width: `${sz.w * scale}px`, height: `${sz.h * scale}px` } });
    const n = i + 1;
    const pointer = (event: MouseEvent): PdfPointer => {
      const r = div.getBoundingClientRect();
      return { page: n, x: (event.clientX - r.left) / scale, y: (event.clientY - r.top) / scale, div, event };
    };
    div.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".pdf-overlay")) return;
      handlers.click?.(pointer(e));
    });
    div.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".pdf-overlay")) return;
      handlers.dblclick?.(pointer(e));
    });
    return { n, w: sz.w, h: sz.h, div, rendered: false, rendering: null };
  });

  // いま見えている範囲のページを先に描いてから差し替える
  let y = 10;
  const visible: PageView[] = [];
  for (const p of pages) {
    const hgt = p.h * scale;
    if (y + hgt >= scrollTop - 50 && y <= scrollTop + host.clientHeight + 50) visible.push(p);
    y += hgt + 10;
  }
  await Promise.all(visible.slice(0, 3).map((p) => renderPage(d, p, scale).catch(() => undefined)));
  if (gen !== generation) return;

  observer?.disconnect();
  clear(host);
  host.append(...pages.map((p) => p.div));
  P.pages = pages;
  P.scale = scale;
  host.scrollTop = scrollTop;
  observer = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const pv = pages.find((p) => p.div === en.target);
        if (pv) void renderPage(d, pv, scale).catch(() => undefined);
      }
    },
    { root: host, rootMargin: "400px 0px" },
  );
  pages.forEach((p) => observer!.observe(p.div));
  emit("pdf-rendered");
}

export async function reloadPdf(): Promise<void> {
  if (!S.dir) return;
  let buf: ArrayBuffer;
  try {
    buf = await api.readPdf(S.dir, mainFile());
  } catch {
    clearPdf();
    return;
  }
  const old = doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  } catch (e) {
    console.error(e);
    return;
  }
  await layout(true);
  void old?.loadingTask.destroy();
}

/** ページに貼り込まれた図 1 つ分の配置。単位 bp、ページ左上原点。 */
export interface PdfPlaced {
  /** 左端 */
  x: number;
  /** 下端 */
  bottom: number;
  /** 元の寸法に対する拡大率（Form XObject = \includegraphics した PDF） */
  sx: number;
  sy: number;
  /** 寸法が確定している場合（ビットマップ画像）の幅・高さ */
  w?: number;
  h?: number;
}

type Mat = [number, number, number, number, number, number];
const mul = (m: Mat, n: Mat): Mat => [
  n[0] * m[0] + n[1] * m[2],
  n[0] * m[1] + n[1] * m[3],
  n[2] * m[0] + n[3] * m[2],
  n[2] * m[1] + n[3] * m[3],
  n[4] * m[0] + n[5] * m[2] + m[4],
  n[4] * m[1] + n[5] * m[3] + m[5],
];

/**
 * ページに貼り込まれた図の実際の位置と拡大率を、PDF の描画命令から求める。
 * SyncTeX が返す箱は図の「元の寸法」なので、拡大縮小後の選択枠はこの結果と組み合わせて作る。
 */
export async function placedFigures(n: number): Promise<PdfPlaced[]> {
  if (!doc) return [];
  const page = await doc.getPage(n);
  const pageH = page.getViewport({ scale: 1 }).height;
  const ops = await page.getOperatorList();
  const O = pdfjs.OPS;
  let ctm: Mat = [1, 0, 0, 1, 0, 0];
  const stack: Mat[] = [];
  let depth = 0;
  const out: PdfPlaced[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const a = ops.argsArray[i] as unknown[] | null;
    if (fn === O.save) stack.push(ctm);
    else if (fn === O.restore) ctm = stack.pop() ?? ctm;
    else if (fn === O.transform && a) ctm = mul(ctm, Array.from(a as ArrayLike<number>).slice(0, 6) as Mat);
    else if (fn === O.paintFormXObjectBegin) {
      const m = a?.[0] ? mul(ctm, Array.from(a[0] as ArrayLike<number>) as Mat) : ctm;
      if (depth === 0) out.push({ x: m[4], bottom: pageH - m[5], sx: Math.abs(m[0]), sy: Math.abs(m[3]) });
      stack.push(ctm);
      ctm = m;
      depth++;
    } else if (fn === O.paintFormXObjectEnd) {
      ctm = stack.pop() ?? ctm;
      depth = Math.max(0, depth - 1);
    } else if (fn === O.paintImageXObject && depth === 0) {
      out.push({ x: ctm[4], bottom: pageH - ctm[5], sx: 1, sy: 1, w: Math.abs(ctm[0]), h: Math.abs(ctm[3]) });
    }
  }
  return out;
}
