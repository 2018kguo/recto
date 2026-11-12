#!/usr/bin/env node
// How tight each engine's character, word and text-item boxes are, against pdfium's tight char boxes
// (`FPDFText_GetCharBox`: the glyph's outline bounds from its font program) as the reference, and
// against the ink a rendering of the page shows for the char where that can be read off cleanly.
//
// Chars are matched by code point, in content order, page by page; whitespace and generated chars
// are left out on every side. A word is recto's word; its reference is the union of the pdfium
// boxes of the chars it matched. pdf.js's text items and recto's `textItems` are compared the
// same way, for context: both are baseline-and-em boxes by design.
//
// IoU is the area two boxes share over the area of their union. Reported per box kind: the median,
// the 10th percentile and the share at 0.8 or more.
//
//   npm run build
//   node bench/box-compare.mjs <directory of PDFs> [more directories] [--docs 400] [--pages 5] [--out bench/results/boxes.json] [--tight]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const here = import.meta.dirname;
const { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    docs: { type: "string", default: "400" },
    pages: { type: "string", default: "5" },
    out: { type: "string", default: path.join(here, "results/boxes.json") },
    ink: { type: "boolean", default: true },
    tight: { type: "boolean", default: false },
    worst: { type: "string" },
  },
});
if (positionals.length === 0) {
  console.error("usage: box-compare.mjs <directory of PDFs> [more directories] [--docs 400] [--pages 5] [--out file.json] [--no-ink] [--tight]");
  process.exit(2);
}
const all = positionals.flatMap((directory) => fs.readdirSync(directory).filter((n) => n.toLowerCase().endsWith(".pdf")).sort().map((n) => path.join(directory, n)));
const wanted = Math.min(Number(values.docs), all.length);
const files = Array.from({ length: wanted }, (_, i) => all[Math.floor((i * all.length) / wanted)]);
const PAGES = Number(values.pages);

const { createPdfEngine, textItems } = await import(path.join(here, "../js/dist/index.js"));
const recto = await createPdfEngine();
const pdfjs = await import(path.join(here, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
const root = path.join(here, "node_modules/pdfjs-dist");
const pdfjsOptions = { isEvalSupported: false, verbosity: 0, standardFontDataUrl: `${root}/standard_fonts/`, cMapUrl: `${root}/cmaps/`, cMapPacked: true, wasmUrl: `${root}/wasm/` };
const { init } = await import(path.join(here, "node_modules/@embedpdf/pdfium/dist/index.js"));
const wasmBinary = fs.readFileSync(path.join(here, "node_modules/@embedpdf/pdfium/dist/pdfium.wasm"));
let pdfium;
let m;
// A file can trap pdfium's instance; a new one takes over for the next file.
async function startPdfium() {
  pdfium = await init({ wasmBinary });
  pdfium.PDFiumExt_Init();
  m = pdfium.pdfium;
}
await startPdfium();

// `--tight`: also read recto's `{ boxes: "tight" }`, the "after" column.
const tightSupported = values.tight;

// ---- boxes: [x, y, w, h], viewer frame (top-left origin, y down) ----
function iou(a, b) {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}
function unite(boxes) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    x0 = Math.min(x0, b[0]);
    y0 = Math.min(y0, b[1]);
    x1 = Math.max(x1, b[0] + b[2]);
    y1 = Math.max(y1, b[1] + b[3]);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}
const isSpace = (c) => c <= 0x20 || c === 0xa0 || c === 0x2 || c === 0xfffe || c === 0xad || (c >= 0x2000 && c <= 0x200b) || c === 0x3000 || c === 0xfeff;

/** Pairs of indices into `a` and `b` (code points) that match, in order, resyncing after a gap. */
function align(a, b) {
  const same = (x, y) => x < a.length && y < b.length && a[x] === b[y];
  const anchor = (x, y) => same(x, y) && (x + 1 >= a.length || y + 1 >= b.length || same(x + 1, y + 1)) && (x + 2 >= a.length || y + 2 >= b.length || same(x + 2, y + 2));
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
      continue;
    }
    let moved = false;
    for (let d = 1; d <= 96 && !moved; d++) {
      for (let di = 0; di <= d; di++) {
        if (anchor(i + di, j + d - di)) {
          i += di;
          j += d - di;
          moved = true;
          break;
        }
      }
    }
    if (!moved) {
      i++;
      j++;
    }
  }
  return pairs;
}

// ---- pdfium ----
function pdfiumOpen(bytes) {
  const at = m.wasmExports.malloc(bytes.length);
  m.HEAPU8.set(bytes, at);
  const handle = pdfium.FPDF_LoadMemDocument(at, bytes.length, "");
  if (!handle) {
    m.wasmExports.free(at);
    return null;
  }
  return { handle, close: () => (pdfium.FPDF_CloseDocument(handle), m.wasmExports.free(at)) };
}

/** pdfium's chars on a page: code point, tight and loose box, both in the viewer frame. */
function pdfiumPage(doc, index, scale) {
  const page = pdfium.FPDF_LoadPage(doc.handle, index);
  if (!page) return null;
  const width = pdfium.FPDF_GetPageWidthF(page);
  const height = pdfium.FPDF_GetPageHeightF(page);
  // Page space to the viewer frame, read off FPDF_PageToDevice (whole device units, so at 1000x).
  const scratch = m.wasmExports.malloc(64);
  const K = 1000;
  const toDevice = (x, y) => {
    pdfium.FPDF_PageToDevice(page, 0, 0, Math.round(width * K), Math.round(height * K), 0, x, y, scratch, scratch + 4);
    return [m.HEAP32[scratch >> 2] / K, m.HEAP32[(scratch + 4) >> 2] / K];
  };
  const o = toDevice(0, 0);
  const ex = toDevice(100, 0);
  const ey = toDevice(0, 100);
  const T = [(ex[0] - o[0]) / 100, (ex[1] - o[1]) / 100, (ey[0] - o[0]) / 100, (ey[1] - o[1]) / 100, o[0], o[1]];
  const map = (l, b, r, t) => {
    const xs = [];
    const ys = [];
    for (const [x, y] of [[l, b], [r, b], [r, t], [l, t]]) {
      xs.push(T[0] * x + T[2] * y + T[4]);
      ys.push(T[1] * x + T[3] * y + T[5]);
    }
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    return [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0];
  };
  const textPage = pdfium.FPDFText_LoadPage(page);
  const count = pdfium.FPDFText_CountChars(textPage);
  const chars = [];
  for (let i = 0; i < count; i++) {
    const code = pdfium.FPDFText_GetUnicode(textPage, i);
    if (isSpace(code) || pdfium.FPDFText_IsGenerated(textPage, i) === 1) continue;
    if (!pdfium.FPDFText_GetCharBox(textPage, i, scratch, scratch + 8, scratch + 16, scratch + 24)) continue;
    const [l, r, b, t] = [m.HEAPF64[scratch >> 3], m.HEAPF64[(scratch + 8) >> 3], m.HEAPF64[(scratch + 16) >> 3], m.HEAPF64[(scratch + 24) >> 3]];
    pdfium.FPDFText_GetLooseCharBox(textPage, i, scratch + 32);
    const [ll, lt, lr, lb] = [m.HEAPF32[(scratch + 32) >> 2], m.HEAPF32[(scratch + 36) >> 2], m.HEAPF32[(scratch + 40) >> 2], m.HEAPF32[(scratch + 44) >> 2]];
    chars.push({ code, tight: map(l, b, r, t), loose: map(ll, lb, lr, lt), angle: pdfium.FPDFText_GetCharAngle(textPage, i) });
  }
  let bitmap = null;
  if (scale) {
    const w = Math.ceil(width * scale);
    const h = Math.ceil(height * scale);
    if (w * h <= 6e7) {
      const bmp = pdfium.FPDFBitmap_CreateEx(w, h, 4, 0, 0);
      pdfium.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
      pdfium.FPDF_RenderPageBitmap(bmp, page, 0, 0, w, h, 0, 0x10);
      const buffer = pdfium.FPDFBitmap_GetBuffer(bmp);
      const rgba = m.HEAPU8.slice(buffer, buffer + w * h * 4);
      pdfium.FPDFBitmap_Destroy(bmp);
      bitmap = { w, h, rgba, scale };
    }
  }
  m.wasmExports.free(scratch);
  pdfium.FPDFText_ClosePage(textPage);
  pdfium.FPDF_ClosePage(page);
  return { chars, bitmap, width, height };
}

/**
 * The ink of a char, from pdfium's rendering: the bounds of the pixels with any ink in a search area around it
 * (its pdfium tight box grown by a fifth of the larger side, plus a point), leaving out the pixels inside any other
 * char's tight box (grown by half a pixel), so neighbours don't leak in. Upright chars only. Null where ink runs
 * to the search area's edge (a rule, an underline, a filled background) or there's none.
 */
function inkBoxes(chars, bitmap) {
  if (!bitmap) return chars.map(() => null);
  const { w, h, rgba, scale } = bitmap;
  const pad = 0.5 / scale;
  // A grid of buckets over the tight boxes, to find the neighbours of a search area.
  const cell = 24;
  const grid = new Map();
  chars.forEach((c, i) => {
    const b = c.tight;
    for (let gx = Math.floor(b[0] / cell); gx <= Math.floor((b[0] + b[2]) / cell); gx++)
      for (let gy = Math.floor(b[1] / cell); gy <= Math.floor((b[1] + b[3]) / cell); gy++) {
        const key = gx * 65536 + gy;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(i);
      }
  });
  return chars.map((c, i) => {
    if (Math.abs(c.angle) > 0.01 || c.tight[2] <= 0 || c.tight[3] <= 0) return null;
    const g = Math.max(c.tight[2], c.tight[3]) * 0.2 + 1;
    const b = [c.tight[0] - g, c.tight[1] - g, c.tight[2] + 2 * g, c.tight[3] + 2 * g];
    if (b[2] * b[3] > 4e4) return null;
    const others = new Set();
    for (let gx = Math.floor(b[0] / cell); gx <= Math.floor((b[0] + b[2]) / cell); gx++)
      for (let gy = Math.floor(b[1] / cell); gy <= Math.floor((b[1] + b[3]) / cell); gy++)
        for (const other of grid.get(gx * 65536 + gy) ?? []) if (other !== i && overlaps(chars[other].tight, b)) others.add(chars[other].tight);
    const masks = [...others];
    const px0 = Math.max(0, Math.floor(b[0] * scale));
    const py0 = Math.max(0, Math.floor(b[1] * scale));
    const px1 = Math.min(w, Math.ceil((b[0] + b[2]) * scale));
    const py1 = Math.min(h, Math.ceil((b[1] + b[3]) * scale));
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let y = py0; y < py1; y++)
      for (let x = px0; x < px1; x++) {
        const p = (y * w + x) * 4;
        if (rgba[p] + rgba[p + 1] + rgba[p + 2] >= 3 * 235) continue;
        const cx = (x + 0.5) / scale;
        const cy = (y + 0.5) / scale;
        if (masks.some((o) => cx > o[0] - pad && cx < o[0] + o[2] + pad && cy > o[1] - pad && cy < o[1] + o[3] + pad)) continue;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + 1);
        y1 = Math.max(y1, y + 1);
      }
    if (x0 === Infinity) return null;
    if (x0 <= px0 || y0 <= py0 || x1 >= px1 || y1 >= py1) return null;
    return [x0 / scale, y0 / scale, (x1 - x0) / scale, (y1 - y0) / scale];
  });
}
const overlaps = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const round = (v) => Math.round(v * 1000) / 1000;

// ---- recto ----
function rectoChars(text) {
  const out = [];
  const index = new Int32Array(text.count).fill(-1);
  for (let i = 0; i < text.count; i++) {
    const code = text.codepoints[i];
    if (isSpace(code) || text.flags[i] & 1) continue;
    index[i] = out.length;
    out.push({ code, box: Array.from(text.boxes.subarray(4 * i, 4 * i + 4)), char: i });
  }
  return { chars: out, index };
}

// ---- pdf.js ----
async function pdfjsItems(doc, index) {
  const page = await doc.getPage(index + 1);
  const viewport = page.getViewport({ scale: 1 });
  const { items } = await page.getTextContent();
  const out = [];
  for (const item of items) {
    if (!item.str || !item.transform) continue;
    const t = pdfjs.Util.transform(viewport.transform, item.transform);
    // Upright items only: the box is the advance by the em, above the baseline.
    if (Math.abs(t[1]) > 1e-3 || Math.abs(t[2]) > 1e-3 || t[0] <= 0) continue;
    const em = Math.hypot(t[2], t[3]);
    const width = item.width * viewport.scale;
    out.push({ str: item.str, box: [t[4], t[5] - em, width, em] });
  }
  page.cleanup();
  return out;
}

// ---- tallies ----
const series = {};
const add = (name, value) => (series[name] ??= []).push(value);
let pages = 0;
let used = 0;
let unmatched = 0;
let rectoTotal = 0;
// Pages whose text read differently with tight boxes: there should be none.
const textDiffers = [];
// With `--worst`: chars whose tight box is furthest from pdfium's, by page. Local: they quote the PDFs.
const worst = {};
const started = performance.now();
for (const file of files) {
  try {
    await scoreFile(file);
  } catch (error) {
    if (!(error instanceof WebAssembly.RuntimeError)) throw error;
    await startPdfium();
  }
}

async function scoreFile(file) {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const pd = pdfiumOpen(bytes);
  if (!pd) return;
  let rdoc;
  let jdoc;
  try {
    rdoc = await recto.open(bytes);
    const task = pdfjs.getDocument({ ...pdfjsOptions, data: new Uint8Array(bytes) });
    jdoc = await task.promise;
    jdoc.task = task;
  } catch {
    pd.close();
    rdoc?.close();
    return;
  }
  let fileUsed = false;
  for (let p = 0; p < Math.min(PAGES, rdoc.pageCount, pdfium.FPDF_GetPageCount(pd.handle)); p++) {
    let ref;
    let em;
    let tight = null;
    let items = [];
    let info;
    try {
      ref = pdfiumPage(pd, p, values.ink ? 4 : 0);
      em = rdoc.text(p);
      if (tightSupported) tight = rdoc.text(p, { boxes: "tight" });
      info = rdoc.pageInfo(p);
      items = await pdfjsItems(jdoc, p);
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) throw error;
      continue;
    }
    if (!ref || ref.chars.length === 0) continue;
    const mine = rectoChars(em);
    const tightBoxes = tight && rectoChars(tight).chars;
    if (tight && (tight.text !== em.text || tight.count !== em.count)) textDiffers.push(`${path.basename(file)}#${p}`);
    const pairs = align(
      mine.chars.map((c) => c.code),
      ref.chars.map((c) => c.code),
    );
    if (pairs.length === 0) continue;
    pages++;
    fileUsed = true;
    rectoTotal += mine.chars.length;
    unmatched += mine.chars.length - pairs.length;
    const ink = inkBoxes(ref.chars, ref.bitmap);
    const matchOf = new Int32Array(mine.chars.length).fill(-1);
    for (const [i, j] of pairs) {
      matchOf[i] = j;
      const r = ref.chars[j];
      if (r.tight[2] <= 0 || r.tight[3] <= 0) continue;
      add("chars: recto (font box)", iou(mine.chars[i].box, r.tight));
      if (tightBoxes) {
        const score = iou(tightBoxes[i].box, r.tight);
        add("chars: recto tight", score);
        if (score < 0.8) (worst[`${path.basename(file)}#${p}`] ??= []).push({ char: String.fromCodePoint(r.code), iou: round(score), recto: tightBoxes[i].box.map(round), pdfium: r.tight.map(round) });
      }
      add("chars: pdfium loose", iou(r.loose, r.tight));
      if (ink[j]) {
        add("ink: pdfium tight", iou(r.tight, ink[j]));
        add("ink: recto (font box)", iou(mine.chars[i].box, ink[j]));
        if (tightBoxes) add("ink: recto tight", iou(tightBoxes[i].box, ink[j]));
      }
    }
    // Words: recto's, against the union of the pdfium boxes of the chars they matched.
    const wordBoxes = (text) => {
      const out = [];
      for (let w = 0; w < text.words.count; w++) {
        const start = text.words.firstChar[w];
        const end = text.words.lastChar[w] + 1;
        const tightRef = [];
        const looseRef = [];
        let whole = true;
        for (let c = start; c < end; c++) {
          const k = mine.index[c];
          if (k < 0) continue;
          const j = matchOf[k];
          if (j < 0) {
            whole = false;
            break;
          }
          tightRef.push(ref.chars[j].tight);
          looseRef.push(ref.chars[j].loose);
        }
        if (!whole || tightRef.length === 0) continue;
        out.push({ box: Array.from(text.words.boxes.subarray(4 * w, 4 * w + 4)), tight: unite(tightRef), loose: unite(looseRef) });
      }
      return out;
    };
    for (const w of wordBoxes(em)) {
      add("words: recto (font box)", iou(w.box, w.tight));
      add("words: pdfium loose", iou(w.loose, w.tight));
    }
    if (tight) for (const w of wordBoxes(tight)) add("words: recto tight", iou(w.box, w.tight));
    // Text items: pdf.js's and recto's `textItems`, upright ones, each against the union of the pdfium
    // chars its string matched.
    const itemScores = (list, name) => {
      const codes = [];
      const owner = [];
      list.forEach((item, k) => {
        for (const ch of item.str) {
          const c = ch.codePointAt(0);
          if (isSpace(c)) continue;
          codes.push(c);
          owner.push(k);
        }
      });
      const byItem = list.map(() => []);
      for (const [a, j] of align(codes, ref.chars.map((c) => c.code))) byItem[owner[a]].push(ref.chars[j].tight);
      list.forEach((item, k) => {
        const n = [...item.str].filter((ch) => !isSpace(ch.codePointAt(0))).length;
        if (n > 0 && byItem[k].length === n) add(name, iou(item.box, unite(byItem[k])));
      });
    };
    itemScores(items, "items: pdf.js");
    const ritems = textItems(em, info)
      .filter((it) => !it.direction)
      .map((it) => ({ str: it.str, box: [it.x, info.height - it.y - it.height, it.width, it.height] }));
    itemScores(ritems, "items: recto textItems");
  }
  if (fileUsed) used++;
  rdoc.close();
  await jdoc.task.destroy();
  pd.close();
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const summary = Object.fromEntries(
  Object.entries(series)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, list]) => {
      const sorted = list.toSorted((a, b) => a - b);
      return [name, { median: round(quantile(sorted, 0.5)), p10: round(quantile(sorted, 0.1)), atLeast08: round(sorted.filter((v) => v >= 0.8).length / sorted.length), n: sorted.length }];
    }),
);
const results = {
  date: new Date().toISOString(),
  documents: used,
  of: files.length,
  pagesEach: PAGES,
  pages,
  rectoChars: rectoTotal,
  matched: round(1 - unmatched / Math.max(rectoTotal, 1)),
  tightTextDiffers: tightSupported ? textDiffers : undefined,
  reference: "pdfium FPDFText_GetCharBox (@embedpdf/pdfium 2.15.1); ink: pdfium's rendering at 4 px a point, chars whose surroundings are clear",
  seconds: Math.round((performance.now() - started) / 1000),
  summary,
};
fs.mkdirSync(path.dirname(values.out), { recursive: true });
fs.writeFileSync(values.out, `${JSON.stringify(results, null, 1)}\n`);
if (values.worst) fs.writeFileSync(values.worst, JSON.stringify(Object.entries(worst).sort((a, b) => b[1].length - a[1].length).map(([where, list]) => ({ where, n: list.length, sample: list.slice(0, 8) })), null, 1));
console.log(`${used} documents, ${pages} pages, ${rectoTotal} recto chars, ${Math.round(results.matched * 1000) / 10}% matched to pdfium's`);
console.log("IoU                         median   p10   ≥0.8      n");
for (const [name, s] of Object.entries(summary)) console.log(`${name.padEnd(28)}${String(s.median).padStart(6)}${String(s.p10).padStart(6)}${String(s.atLeast08).padStart(7)}${String(s.n).padStart(8)}`);
if (tightSupported) console.log(`text read differently with tight boxes on ${textDiffers.length} pages${textDiffers.length ? `: ${textDiffers.slice(0, 10).join(", ")}` : ""}`);
