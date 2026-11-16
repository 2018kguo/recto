#!/usr/bin/env node
// Rewrites the tables of docs/benchmarks.md from bench/results/*.json, so a refresh needs no numbers typed
// by hand. Each table sits between `<!-- bench:NAME -->` and `<!-- /bench:NAME -->`; only what is between
// them is replaced. The prose around them still says what the numbers mean, and is the refresher's to check.
//
//   node scripts/bench-docs.mjs [--results bench/results] [--doc docs/benchmarks.md] [--check] [--print NAME]
//
// `--check` exits 1 when a table would change, writing nothing; `--print` writes one table to stdout.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const root = path.join(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    results: { type: "string", default: path.join(root, "bench/results") },
    doc: { type: "string", default: path.join(root, "docs/benchmarks.md") },
    check: { type: "boolean", default: false },
    print: { type: "string" },
  },
});

const load = (name) => {
  const file = path.join(values.results, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
};
const node = load("node.json");
const browser = load("browser.json");
const fast = load("browser-full-speed.json");
const text = load("text.json");
const textPublic = load("text-public.json");
const boxes = load("boxes.json");
const scorecard = load("scorecard.json");
const wild = load("wild.json");

const OTHERS = ["pdf.js", "pdfium", "mupdf"];
const ENGINES = ["recto", ...OTHERS];
const NAMES = { recto: "recto", "pdf.js": "pdf.js", pdfium: "pdfium", mupdf: "MuPDF", poppler: "poppler" };

// ---- Numbers, one way everywhere.

const thousands = (value) => Math.round(value).toLocaleString("en-US");
/** A time: whole milliseconds from 100 up, one decimal under. */
const ms = (value) => (value >= 100 ? `${thousands(value)} ms` : `${value.toFixed(1)} ms`);
/** A ratio: two decimals under 2, one under 10, none past. */
const times = (value) => (value >= 9.95 ? thousands(value) : value >= 1.995 ? value.toFixed(1) : value.toFixed(2));
const mb = (bytes, digits = 0) => `${(bytes / 1e6).toFixed(digits)} MB`;
const pct = (value, digits = 1) => `${value.toFixed(digits)}%`;
const bold = (text) => `**${text}**`;
const line = (cells) => `| ${cells.join(" | ")} |`.replace(/^\|  \|/, "| |");
const table = (head, rows, align) => [line(head), `|${head.map((_, i) => (i === 0 ? "---" : (align?.[i] ?? "---:"))).join("|")}|`, ...rows.map(line)].join("\n");

/** One engine's cell of a timed row: the median, and for the others the ratio to recto and its interval. */
function cell(row, engine, format = ms) {
  const entry = row[engine];
  if (engine === "recto" || entry.ratio == null) return format(entry.median);
  const interval = entry.interval ? ` [${times(entry.interval[0])}–${times(entry.interval[1])}]` : "";
  return `${format(entry.median)} (${times(entry.ratio)}×${interval})`;
}

/** A CPU row is marked, so a reader can tell it from a wall-time one. */
const marked = (label, row) => (row.measure === "thread" ? `${label} †` : label);
const CPU_NOTE = "† The calling thread's CPU time; the other rows are wall time. [How it was measured](#how-it-was-measured) says why.";

/** What a ratio says in a sentence: "4.4×", "level (0.98×)", or in bold where recto is behind. */
function verdictText(entry, { less = false } = {}) {
  const r = times(entry.ratio);
  const verdict = entry.verdict ?? (!entry.interval ? null : entry.interval[0] > 1 ? "ahead" : entry.interval[1] < 1 ? "behind" : "level");
  if (verdict === "level") return `level (${r}×${entry.interval ? `, interval ${times(entry.interval[0])}–${times(entry.interval[1])}` : ""})`;
  if (verdict === "behind") return bold(less ? `${times(1 / entry.ratio)}× more` : `${r}×`);
  return less ? `${r}× less` : `${r}×`;
}

// ---- The tables.

const tables = {};

tables["node-speed"] = () => {
  const s = node.summary;
  const large = thousands(node.documents.largePages);
  const rows = [
    [`Text, first ${node.widths.textPages} pages of each (${node.pagesRead} pages)`, s.text],
    [`Render at ${node.widths.render} px, first ${node.widths.renderPages} pages of each (${node.pagesRendered} pages)`, s.render],
    ["A fresh process to the first page's text", s.coldText],
    ["A fresh process to the first page's pixels", s.coldRender],
    ["Warm: open, first page's text, close", s.firstText],
    ["Warm: open, first page's pixels, close", s.firstRender],
    [`${large}-page report: open`, s.largeOpen],
    [`${large}-page report: every page's text`, s.largeText],
    [`${large}-page report: render ${node.documents.largeRendered} pages`, s.largeRender],
    [`A generated poster: open, render at ${node.widths.render} px`, s.posterRender],
  ];
  const body = table(["", ...ENGINES.map((e) => NAMES[e])], rows.map(([label, row]) => [marked(label, row), ...ENGINES.map((e) => cell(row, e))]));
  return rows.some(([, row]) => row.measure === "thread") ? `${body}\n\n${CPU_NOTE}` : body;
};

tables["node-memory"] = () => {
  const s = node.summary;
  const rows = [
    [`The ${node.documents.used} documents, text and render`, s.rss],
    [`The ${thousands(node.documents.largePages)}-page report`, s.largeRss],
  ];
  return table(["", ...ENGINES.map((e) => NAMES[e])], rows.map(([label, row]) => [label, ...ENGINES.map((e) => cell(row, e, (v) => mb(v)))]));
};

tables["node-blocking"] = () => {
  const s = node.summary;
  return table(
    ["", ...ENGINES.map((e) => NAMES[e])],
    [
      ["A typical document: its longest stall (median)", ...ENGINES.map((e) => ms(s.maxMedian[e].median))],
      ["The worst document: its longest stall", ...ENGINES.map((e) => ms(s.maxWorst[e].median))],
    ],
  );
};

tables["node-abort"] = () => {
  const s = node.summary;
  return table(
    ["", ...ENGINES.map((e) => NAMES[e])],
    [
      ["Rendering it to the end", ...ENGINES.map((e) => ms(s.abortWhole[e].median))],
      ["Asked to stop 100 ms in: the time until the thread is free", ...ENGINES.map((e) => ms(s.abortStopped[e].median))],
    ],
  );
};

tables["browser-speed"] = () => {
  const slowed = `at ${browser.slowdown.factor}×`;
  const s = (key) => [fast.summary[key], browser.summary[key]];
  const rows = [
    [`Text, first 20 pages of each (${browser.pages.read} pages)`, "text"],
    [`Render at ${browser.width} px, first 2 of each (${browser.pages.rendered} pages)`, "render"],
    ["A fresh page to the first page's text", "coldText"],
    ["A fresh page to the first page's pixels", "coldRender"],
    ["Warm: open, first page's text, close", "warmText"],
    ["Warm: open, first page's pixels, close", "warmRender"],
    [`A ${browser.pages.report}-page report, every page read and drawn in a grid`, "loadDone"],
    ["A 500-page report: open", "largeOpen"],
    ["A 500-page report: every page's text", "largeText"],
    ["A 500-page report: render 5 pages", "largeRender"],
  ];
  return table(
    ["", ...ENGINES.map((e) => NAMES[e])],
    rows.flatMap(([label, key]) => {
      const [full, slow] = s(key);
      return [
        [label, ...ENGINES.map((e) => cell(full, e))],
        [slowed, ...ENGINES.map((e) => cell(slow, e))],
      ];
    }),
  );
};

tables["browser-download"] = () => {
  const both = (part) => `${mb(part.raw, 2)} (${mb(part.brotli, 2)})`;
  const rows = [
    ["A report, first page's text, never drawn", "textOnly"],
    ["A report, first page's text and pixels", "text"],
    ["A CJK document without embedded fonts, first page", "cjk"],
  ];
  return table(
    ["", ...ENGINES.map((e) => NAMES[e])],
    rows.map(([label, key]) => {
      const least = Math.min(...ENGINES.map((e) => browser.bundle[e][key].brotli));
      return [label, ...ENGINES.map((e) => {
        const part = browser.bundle[e][key];
        return part.brotli === least ? `${mb(part.raw, 2)} (${bold(mb(part.brotli, 2))})` : both(part);
      })];
    }),
  );
};

tables["browser-memory"] = () =>
  table(
    ["", ...ENGINES.map((e) => NAMES[e])],
    [
      ["JS heap, page and workers", ...ENGINES.map((e) => mb(browser.summary.heap[e].median, 1))],
      ["WebAssembly memory", ...ENGINES.map((e) => mb(browser.summary.wasm[e].median, 1))],
    ],
  );

tables["browser-threads"] = () => {
  const both = (key, e, format = ms) => `${format(fast.summary[key][e].median)} / ${format(browser.summary[key][e].median)}`;
  const whole = (v) => `${thousands(v)} ms`;
  const rows = [
    ["40-page report: main-thread stutter", "stutter", whole],
    ["40-page report: longest stretch in a worker", "longestGapInWorker"],
    ["Heavy page: all of it", "heavyDone"],
    ["Heavy page: main-thread stutter", "heavyStutter", whole],
    ["Heavy page: longest main-thread task", "heavyLongestTask", whole],
    ["Heavy page: longest stretch in a worker", "heavyGapInWorker"],
  ];
  return table(
    ["", ...ENGINES.map((e) => NAMES[e])],
    [
      ...rows.map(([label, key, format]) => [label, ...ENGINES.map((e) => both(key, e, format))]),
      ["Heavy page with `renderAsync`: all of it", both("slicedDone", "recto"), "", "", ""],
      ["Heavy page with `renderAsync`: longest stretch in a worker", both("slicedGapInWorker", "recto"), "", "", ""],
    ],
  );
};

const f1 = (results, engine) => results.summary[`${engine} against poppler`].microF1;
tables["text-quality"] = () => {
  const row = (label, results) => {
    const best = Math.max(...ENGINES.map((e) => f1(results, e)));
    return [label, ...ENGINES.map((e) => (f1(results, e) === best ? bold(pct(f1(results, e), 2)) : pct(f1(results, e), 2)))];
  };
  const rows = [row(`${text.documents} documents: the public set, and the pdf.js, pdfium and hayro test suites`, text)];
  if (textPublic) rows.push(row(`The ${textPublic.documents} of the public set alone`, textPublic));
  return table(["F1 against poppler", ...ENGINES.map((e) => NAMES[e])], rows);
};

const iouRow = (label, s) => [label, s.median.toFixed(3), s.p10.toFixed(3), pct(s.atLeast08 * 100)];
tables["boxes-pdfium"] = () => {
  const s = boxes.summary;
  return table(
    ["IoU against pdfium's tight box", "Median", "10th percentile", "At least 0.8"],
    [
      iouRow('Chars: recto, `text(i, { boxes: "tight" })`', s["chars: recto tight"]),
      iouRow("Chars: recto's font boxes (the default, and every box before this)", s["chars: recto (font box)"]),
      iouRow("Chars: pdfium's own loose boxes (`FPDFText_GetLooseCharBox`)", s["chars: pdfium loose"]),
      iouRow("Words: recto, tight", s["words: recto tight"]),
      iouRow("Words: recto, font boxes", s["words: recto (font box)"]),
      iouRow("Words: pdfium's loose boxes, united", s["words: pdfium loose"]),
      iouRow("Chars: MuPDF's quads, `accurate-bboxes`", s["chars: mupdf accurate-bboxes"]),
      iouRow("Chars: MuPDF's quads (its default)", s["chars: mupdf"]),
      iouRow("Text items: pdf.js", s["items: pdf.js"]),
      iouRow("Text items: recto's `textItems`", s["items: recto textItems"]),
    ],
  );
};

tables["boxes-ink"] = () => {
  const s = boxes.summary;
  return table(
    ["IoU against the ink", "Median", "10th percentile", "At least 0.8"],
    [
      iouRow("pdfium's tight boxes", s["ink: pdfium tight"]),
      iouRow("recto's tight boxes", s["ink: recto tight"]),
      iouRow("recto's font boxes", s["ink: recto (font box)"]),
      iouRow("MuPDF, `accurate-bboxes`", s["ink: mupdf accurate-bboxes"]),
      iouRow("MuPDF, its default", s["ink: mupdf"]),
    ],
  );
};

tables.scorecard = () => {
  const engines = scorecard.engines;
  const a = scorecard.agreement;
  const best = Math.max(...engines.map((e) => a[e].percent));
  const agrees = (e) => `${a[e].percent === best ? bold(pct(a[e].percent)) : pct(a[e].percent)} of ${a[e].judged}`;
  const SUITES = { public: "public PDFs", pdfjs: "from pdf.js's test suite", pdfium: "from pdfium's", hayro: "from hayro's" };
  return `${table(
    ["Of the pages two others agree on", ...engines.map((e) => NAMES[e])],
    [
      ["Agrees with them", ...engines.map(agrees)],
      ["Blank where they draw", ...engines.map((e) => String(a[e].blankWhereOthersDraw))],
      ["Fails where they draw", ...engines.map((e) => String(a[e].failedWhereOthersDraw))],
      ["A different page shape", ...engines.map((e) => String(a[e].wrongShape))],
    ],
  )}\n\n${table(
    ["By set (recto)", "Pages judged", "Agrees"],
    Object.entries(scorecard.agreementBySuite).map(([suite, by]) => [`${scorecard.suites[suite]} ${SUITES[suite] ?? suite}`, String(by.recto.judged), pct(by.recto.percent)]),
  )}`;
};

tables.wild = () => {
  const e = (name) => wild.engines[name];
  const n = (value) => thousands(value);
  // Each engine names a password its own way.
  const PASSWORD = { recto: "password-required", "pdf.js": "PasswordException", pdfium: "pdfium-4", mupdf: "mupdf could not open it: needs a password" };
  const code = (name) => e(name).codes[`open-error ${PASSWORD[name]}`] ?? 0;
  const limit = wild.timeoutSeconds ?? 20;
  const rows = [
    ["Opened, and every page asked for read and drawn", (x) => n(e(x).outcomes.ok)],
    ["Refused as not a PDF, or too damaged", (x) => n(e(x).outcomes["open-error"] - code(x))],
    ["Refused for a password", (x) => n(code(x))],
    ["Opened, then a page failed", (x) => n(e(x).outcomes["page-error"])],
    [`Past ${limit} s`, (x) => n(e(x).outcomes.timeout)],
    ["Past 2 GB", (x) => n(e(x).outcomes.memory)],
    ["Crashed", (x) => n(e(x).outcomes.crash)],
    [bold("Worse than another engine on the same file"), (x) => (x === "recto" ? bold(n(e(x).worseThanAnother)) : n(e(x).worseThanAnother))],
    ["Fewer than half the words all three others agree on (to look at)", (x) => n(e(x).softDisagreements)],
    ["Time per file, median (99th percentile)", (x) => `${n(e(x).ms.p50)} ms (${n(e(x).ms.p99)})`],
    ["Peak memory per process, median (largest)", (x) => `${n(e(x).peakRssMb.p50)} MB (${n(e(x).peakRssMb.max)})`],
  ];
  return table([`${n(wild.files)} files`, ...ENGINES.map((x) => NAMES[x])], rows.map(([label, f]) => [label, ...ENGINES.map(f)]));
};

tables.glance = () => {
  const ns = node.summary;
  const bs = browser.summary;
  const kb = (bytes) => `${Math.round(bytes / 1000)} KB`;
  const size = (key) => (engine) => {
    const mine = browser.bundle[engine][key].brotli;
    const recto = browser.bundle.recto[key].brotli;
    const pair = (a, b) => (Math.max(a, b) < 1e6 ? `${Math.round(a / 1000)} against ${kb(b)}` : `${(a / 1e6).toFixed(2)} against ${(b / 1e6).toFixed(2)}`);
    if (mine < recto) return `${bold(`${NAMES[engine]} ${recto - mine < 1e5 ? kb(recto - mine) : mb(recto - mine, 2)} smaller`)} (${pair(mine, recto)})`;
    if (mine / recto < 1.1) return `${Math.round((1 - recto / mine) * 100)}% smaller (${pair(recto, mine)})`;
    return `${times(mine / recto)}× smaller`;
  };
  const ratio = (row, options) => (engine) => verdictText(row[engine], options);
  const stop = (engine) => `${ms(ns.abortStopped.recto.median).replace(" ms", "")} against ${ms(ns.abortStopped[engine].median)}${engine === "pdf.js" ? "" : " (by `terminate()`)"}`;
  const wasm = (engine) => {
    const mine = bs.wasm[engine].median;
    const recto = bs.wasm.recto.median;
    if (mine < recto) return `${bold(`${NAMES[engine]} holds ${mb(recto - mine, 1)} less WebAssembly`)}${mine === 0 ? " (none)" : ""}`;
    return `${times(mine / recto)}× less`;
  };
  const worse = (engine) => `${wild.engines.recto.worseThanAnother} against ${wild.engines[engine].worseThanAnother}`;
  const agree = (engine) => `${pct(scorecard.agreement.recto.percent)} against ${pct(scorecard.agreement[engine].percent)}`;
  const f1Text = (results) => (engine) => `${pct(f1(results, "recto"), 2)} against ${pct(f1(results, engine), 2)}`;
  const box = (engine) => {
    if (engine === "pdf.js") return "not measured (items, not chars)";
    const recto = boxes.summary["ink: recto tight"].median.toFixed(3);
    const theirs = engine === "pdfium" ? boxes.summary["ink: pdfium tight"] : boxes.summary["ink: mupdf accurate-bboxes"];
    return `${recto} against ${theirs.median.toFixed(3)}${engine === "mupdf" ? " (`accurate-bboxes`)" : ""}`;
  };
  const slowed = `slowed ${browser.slowdown.factor}×`;
  const large = thousands(node.documents.largePages);
  const rows = [
    ["**Size**: download with brotli, text only", browser && size("textOnly")],
    ["**Size**: download with brotli, text and pixels", browser && size("text")],
    ["**Cold start**: a fresh Node process to the first text", node && ratio(ns.coldText)],
    ["**Cold start**: a fresh Node process to the first pixels", node && ratio(ns.coldRender)],
    [`**Cold start**: a fresh Chromium page to the first text, ${slowed}`, browser && ratio(bs.coldText)],
    [`**Cold start**: a fresh Chromium page to the first pixels, ${slowed}`, browser && ratio(bs.coldRender)],
    [`**Open**: a ${large}-page report in Node`, node && ratio(ns.largeOpen)],
    ["**Open**: a 500-page report in Chromium", fast && ratio(fast.summary.largeOpen)],
    [`**Render**: ${node.pagesRendered} pages at ${node.widths.render} px in Node`, node && ratio(ns.render)],
    [`**Render**: ${fast.pages.rendered} pages at ${fast.width} px in Chromium`, fast && ratio(fast.summary.render)],
    [`**Render**: ${node.documents.largeRendered} pages of the ${large}-page report in Node`, node && ratio(ns.largeRender)],
    ["**Render**: a generated poster of large images drawn small, in Node", node && ratio(ns.posterRender)],
    [`**Text**: ${node.pagesRead} pages in Node`, node && ratio(ns.text)],
    [`**Text**: ${fast.pages.read} pages in Chromium`, fast && ratio(fast.summary.text)],
    [`**Memory**: peak of a Node process, ${node.documents.used} documents`, node && ratio(ns.rss, { less: true })],
    [`**Memory**: peak, the ${large}-page report`, node && ratio(ns.largeRss, { less: true })],
    ["**Memory**: left with a 40-page report open in Chromium", browser && wasm],
    ["**Stopping a slow render** on the same thread, Node", node && stop],
    [`**Robustness**: ${thousands(wild?.files ?? 0)} web PDFs, files worse than another engine`, wild && worse],
    [`**Fidelity**: agrees with two other engines, of ${scorecard?.files} small, mostly adversarial files`, scorecard && agree],
    [`**Text**: F1 against poppler, ${text?.documents} documents`, text && f1Text(text)],
    [`**Text**: F1 against poppler, the ${textPublic?.documents} public documents alone`, textPublic && f1Text(textPublic)],
    ["**Char boxes**: IoU against the ink, median", boxes && box],
  ].filter(([, f]) => f);
  return table(["", ...OTHERS.map((e) => NAMES[e])], rows.map(([label, f]) => [label, ...OTHERS.map(f)]), ["", "---", "---", "---"]);
};

// ---- Writing them in.

const need = {
  glance: [node, browser, fast],
  "node-speed": [node],
  "node-memory": [node],
  "node-blocking": [node],
  "node-abort": [node],
  "browser-speed": [browser, fast],
  "browser-download": [browser],
  "browser-memory": [browser],
  "browser-threads": [browser, fast],
  "text-quality": [text],
  "boxes-pdfium": [boxes],
  "boxes-ink": [boxes],
  scorecard: [scorecard],
  wild: [wild],
};

if (values.print) {
  console.log(tables[values.print]());
  process.exit(0);
}
let doc = fs.readFileSync(values.doc, "utf8");
const changed = [];
const missing = [];
for (const [name, make] of Object.entries(tables)) {
  const open = `<!-- bench:${name} -->`;
  const close = `<!-- /bench:${name} -->`;
  const start = doc.indexOf(open);
  const end = doc.indexOf(close);
  if (start < 0 || end < start) {
    missing.push(name);
    continue;
  }
  if (need[name].some((results) => !results)) continue;
  const fresh = `${open}\n${make()}\n${close}`;
  const old = doc.slice(start, end + close.length);
  if (old !== fresh) {
    changed.push(name);
    doc = doc.slice(0, start) + fresh + doc.slice(end + close.length);
  }
}
if (missing.length) console.error(`no markers for: ${missing.join(", ")}`);
if (values.check) {
  if (changed.length) console.error(`would change: ${changed.join(", ")}`);
  process.exit(changed.length ? 1 : 0);
}
fs.writeFileSync(values.doc, doc);
console.error(changed.length ? `rewrote: ${changed.join(", ")}` : "no table changed");
