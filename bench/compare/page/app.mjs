// The comparison page: two frames of the same size, filled one after the other, and the numbers
// each side earns. `?doc=…&network=…&run` runs the script on load (the headless runner does);
// `&order=pdfjs,recto` swaps who goes first; the results end up on `window.compare`.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const info = await (await fetch("/api/info")).json();

const SIDES = {
  recto: { name: "recto", version: info.recto },
  pdfjs: { name: "pdf.js", version: info.pdfjs },
};
const WORD = params.get("word") ?? info.word;
const SCRIPT = { page: Number(params.get("page") ?? 50), zoom: 3, scrollMs: 2500 };
const ROWS = [
  ["firstPaint", "First page"],
  ["sharp", "Screen sharp"],
  ["downloaded", "Downloaded"],
  ["code", "JS + wasm, brotli"],
  ["scrollTasks", `Long tasks, scroll to p. ${SCRIPT.page}`],
  ["scrollSharp", `Page ${SCRIPT.page} sharp`],
  ["zoomSharp", "300% sharp"],
  ["find", `Find “${WORD}”`],
  ["memory", "Memory, incl. workers"],
  ["canvas", "Canvas pixels held"],
];

// --- The panes -----------------------------------------------------------------------------------
const panes = {};
for (const [key, side] of Object.entries(SIDES)) {
  const pane = document.createElement("section");
  pane.className = "pane";
  pane.innerHTML = `<div class="pane-head"><span class="name">${side.name}</span><span class="version">${side.version}</span><span class="state"></span></div>
    <div class="stage"><div class="waiting"></div></div><dl class="stats"></dl>`;
  const stats = pane.querySelector(".stats");
  const cells = {};
  for (const [row, label] of ROWS) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    stats.append(dt, dd);
    cells[row] = dd;
  }
  $("panes").append(pane);
  panes[key] = { pane, stage: pane.querySelector(".stage"), state: pane.querySelector(".state"), waiting: pane.querySelector(".waiting"), cells, frame: null, side: null };
}

/** Numbers as shown, and as compared: lower is better for all of them. */
const results = {};
function show(key, row, value, text, note = "") {
  results[key] ??= {};
  results[key][row] = value;
  const cell = panes[key].cells[row];
  cell.className = value === null || value === undefined ? "empty" : "";
  cell.innerHTML = text + (note ? `<span class="note">${note}</span>` : "");
  const other = key === "recto" ? "pdfjs" : "recto";
  const a = results[key]?.[row];
  const b = results[other]?.[row];
  for (const k of [key, other]) panes[k].cells[row].classList.remove("better");
  if (typeof a === "number" && typeof b === "number" && Math.abs(a - b) > 0.05 * Math.max(a, b) && Math.abs(a - b) >= 1) {
    panes[a < b ? key : other].cells[row].classList.add("better");
  }
}
const ms = (value) => (value >= 10_000 ? `${(value / 1000).toFixed(1)}<span class="unit">s</span>` : `${Math.round(value).toLocaleString()}<span class="unit">ms</span>`);
const mb = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)}<span class="unit">MB</span>` : `${Math.round(bytes / 1e3).toLocaleString()}<span class="unit">KB</span>`);
function clear() {
  for (const key of Object.keys(panes)) {
    results[key] = {};
    for (const [row] of ROWS) show(key, row, null, "—");
  }
}
clear();

// --- Controls ------------------------------------------------------------------------------------
const docSelect = $("doc");
for (const doc of info.docs) docSelect.add(new Option(`${doc.label} · ${mb(doc.bytes).replace(/<[^>]+>/gu, " ")}`, doc.name));
let network = params.get("network") ?? "none";
for (const [key, preset] of Object.entries(info.networks)) {
  const button = document.createElement("button");
  button.textContent = key === "none" ? "No throttling" : preset.label;
  button.dataset.network = key;
  button.setAttribute("aria-pressed", String(key === network));
  button.addEventListener("click", () => {
    network = key;
    for (const other of $("network").children) other.setAttribute("aria-pressed", String(other === button));
  });
  $("network").append(button);
}
if (params.get("doc")) docSelect.value = params.get("doc");

const status = (html) => ($("status").innerHTML = html);
let busy = false;
function setBusy(value) {
  busy = value;
  $("run").disabled = value;
  docSelect.disabled = value;
}

// --- One side ------------------------------------------------------------------------------------
const now = () => performance.timeOrigin + performance.now();
const wait = (msToWait) => new Promise((resolve) => setTimeout(resolve, msToWait));
async function stats(run) {
  return (await fetch(`/api/stats?run=${run}`)).json();
}

/** Opens `doc` on one side in a new frame; with `script`, plays it. Fills the side's numbers. */
async function playSide(key, doc, run, script) {
  const p = panes[key];
  p.frame?.remove();
  p.waiting.textContent = "";
  p.state.textContent = "Loading";
  p.state.classList.add("active");
  const frame = document.createElement("iframe");
  frame.title = `${SIDES[key].name} viewer`;
  const ready = new Promise((resolve) => {
    const listen = (event) => {
      if (event.source === frame.contentWindow && event.data?.type === "side-ready") {
        removeEventListener("message", listen);
        resolve();
      }
    };
    addEventListener("message", listen);
  });
  const started = now();
  frame.src = `/x/${network}/${run}/${key}/side.html?doc=${encodeURIComponent(doc)}`;
  p.stage.append(frame);
  p.frame = frame;
  await ready;
  const side = frame.contentWindow.side;
  p.side = side;
  const out = { side: key };
  await side.opened;
  out.pageCount = side.pageCount();
  out.scale = Math.round(side.scale() * 1000) / 1000;
  const sharp = await side.untilSharp();
  out.firstPaintMs = Math.round(side.events.firstPaintAt - started);
  out.sharpMs = Math.round(sharp.at - started);
  show(key, "firstPaint", out.firstPaintMs, ms(out.firstPaintMs));
  show(key, "sharp", out.sharpMs, ms(out.sharpMs));
  if (script) {
    const name = SIDES[key].name;
    p.state.textContent = `Scrolling to page ${script.page}`;
    status(`<b>${name}</b> · scrolling to page ${script.page}`);
    const scroll = await side.scrollToPage(Math.min(script.page, out.pageCount), script.scrollMs);
    const afterScroll = await side.untilSharp();
    out.scrollSharpMs = Math.round(afterScroll.at - scroll.ended);
    show(key, "scrollSharp", out.scrollSharpMs, ms(out.scrollSharpMs), "after scrolling");
    await wait(100);
    const tasks = side.longTasksBetween(scroll.started, scroll.ended);
    Object.assign(out, { scrollLongTasks: tasks.longTasks, scrollLongTaskMs: tasks.longTaskMs, scrollP95FrameMs: scroll.p95FrameMs, scrollDroppedFrames: scroll.droppedFrames });
    show(key, "scrollTasks", tasks.longTaskMs, `${tasks.longTasks}<span class="unit"> · </span>${ms(tasks.longTaskMs)}`);

    p.state.textContent = "Zooming to 300%";
    status(`<b>${name}</b> · zooming to 300%`);
    const zoomStarted = now();
    side.setScale(side.fit() * script.zoom);
    const afterZoom = await side.untilSharp();
    out.zoomSharpMs = Math.round(afterZoom.at - zoomStarted);
    out.zoomDensity = afterZoom.density;
    out.zoomScale = Math.round(side.scale() * 1000) / 1000;
    show(key, "zoomSharp", out.zoomSharpMs, ms(out.zoomSharpMs), afterZoom.capped ? `${Math.round(afterZoom.density * 100)}% sharp` : "");

    p.state.textContent = `Finding “${script.word}”`;
    status(`<b>${name}</b> · finding “${script.word}”`);
    const found = await side.find(script.word);
    out.findMs = Math.round(found.ms);
    out.findHits = found.hits;
    show(key, "find", out.findMs, ms(out.findMs), `${found.hits} hits`);
  }
  // What it still reads in the background (pdf.js fetches the rest of the file) shares the link
  // with the next side: let it finish first, for up to ten minutes.
  const idleBy = now() + 600_000;
  for (;;) {
    const sides = await stats(run);
    const mine = sides[key];
    if (!mine || mine.inflight === 0 || now() > idleBy) break;
    p.state.textContent = "Downloading in the background";
    status(`<b>${SIDES[key].name}</b> · still downloading in the background; the next side waits`);
    await wait(250);
  }
  const counted = (await stats(run))[key] ?? { wire: 0, codeBrotli: 0, requests: 0, doc: 0 };
  Object.assign(out, { downloadedBytes: counted.wire, docBytes: counted.doc, codeBrotliBytes: counted.codeBrotli, requests: counted.requests, codeFiles: counted.codeFiles });
  show(key, "downloaded", counted.wire, mb(counted.wire), `${counted.requests} requests`);
  show(key, "code", counted.codeBrotli, mb(counted.codeBrotli));
  p.state.textContent = "Done";
  p.state.classList.remove("active");
  return out;
}

/** The browser's measure of memory, attributed to each side's frame and its workers. */
async function measureMemory(run, out) {
  for (const [key, p] of Object.entries(panes)) {
    if (p.side) {
      out[key].canvasMB = p.side.canvasMB();
      show(key, "canvas", out[key].canvasMB, mb(out[key].canvasMB * 1e6));
    }
  }
  if (!self.crossOriginIsolated || !performance.measureUserAgentSpecificMemory) {
    for (const key of Object.keys(panes)) show(key, "memory", null, "—", "not in this browser");
    return;
  }
  for (const key of Object.keys(panes)) show(key, "memory", null, "…", "measuring");
  const measured = await performance.measureUserAgentSpecificMemory();
  for (const key of Object.keys(panes)) {
    const mark = `/${run}/${key}/`;
    let bytes = 0;
    for (const entry of measured.breakdown) {
      if (entry.attribution.some((a) => a.url?.includes(mark))) bytes += entry.bytes;
    }
    if (out[key]) out[key].memoryMB = Math.round(bytes / 1e5) / 10;
    show(key, "memory", bytes, mb(bytes));
  }
}

// --- Keeping the two in step ---------------------------------------------------------------------
let syncing = false;
function syncFrom(key) {
  const other = panes[key === "recto" ? "pdfjs" : "recto"].side;
  const self = panes[key].side;
  if (!other || !self || syncing) return;
  const position = self.position();
  if (!position) return;
  syncing = true;
  if (Math.abs(other.scale() - self.scale()) > 0.01 * self.scale()) other.setScale(self.scale());
  requestAnimationFrame(() => {
    other.setPosition(position);
    requestAnimationFrame(() => (syncing = false));
  });
}
function linkSides() {
  for (const key of Object.keys(panes)) {
    const side = panes[key].side;
    if (!side || side.linked) continue;
    side.linked = true;
    let queued = false;
    side.adapter.scroller.addEventListener("scroll", () => {
      if (busy || syncing || queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        syncFrom(key);
      });
    });
    side.onScale(() => !busy && !syncing && syncFrom(key));
  }
}
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
function zoomBoth(step) {
  const lead = panes.recto.side ?? panes.pdfjs.side;
  if (!lead || busy) return;
  const current = lead.scale() / lead.fit();
  const next = step === 0 ? 1 : step > 0 ? (ZOOMS.find((z) => z > current + 0.01) ?? 4) : ([...ZOOMS].reverse().find((z) => z < current - 0.01) ?? 0.5);
  syncing = true;
  for (const p of Object.values(panes)) p.side?.setScale(p.side.fit() * next);
  requestAnimationFrame(() => requestAnimationFrame(() => (syncing = false)));
}
$("zoom-in").addEventListener("click", () => zoomBoth(1));
$("zoom-out").addEventListener("click", () => zoomBoth(-1));
$("zoom-fit").addEventListener("click", () => zoomBoth(0));

// --- Running -------------------------------------------------------------------------------------
async function compare({ script }) {
  if (busy) return null;
  setBusy(true);
  clear();
  const doc = docSelect.value;
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const order = (params.get("order") ?? "recto,pdfjs").split(",");
  const out = { doc, network, run, order, word: script ? WORD : null, userAgent: navigator.userAgent, devicePixelRatio, stage: { width: panes.recto.stage.clientWidth, height: panes.recto.stage.clientHeight } };
  for (const key of order) {
    panes[key].frame?.remove();
    panes[key].frame = null;
    panes[key].side = null;
    panes[key].state.textContent = "";
    panes[key].waiting.textContent = "Waits its turn";
  }
  try {
    for (const key of order) {
      status(`<b>${SIDES[key].name}</b> · opening`);
      out[key] = await playSide(key, doc, run, script && { ...SCRIPT, word: WORD });
    }
    status("Measuring memory");
    await measureMemory(run, out);
    status(`Done · ${info.networks[network].label} · ${docSelect.selectedOptions[0]?.text ?? doc}`);
  } catch (error) {
    out.error = String(error?.message ?? error);
    status(`Stopped: ${out.error}`);
  } finally {
    setBusy(false);
    linkSides();
  }
  return out;
}

$("run").addEventListener("click", () => compare({ script: true }));
docSelect.addEventListener("change", () => compare({ script: false }));

async function openFile(file) {
  if (!file || busy) return;
  status(`Reading ${file.name}`);
  const response = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
  const { name, bytes } = await response.json();
  docSelect.add(new Option(`${file.name} · ${mb(bytes).replace(/<[^>]+>/gu, " ")}`, name));
  docSelect.value = name;
  compare({ script: false });
}
$("file").addEventListener("change", (event) => openFile(event.target.files[0]));
addEventListener("dragover", (event) => {
  event.preventDefault();
  document.body.classList.add("dragging");
});
addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) document.body.classList.remove("dragging");
});
addEventListener("drop", (event) => {
  event.preventDefault();
  document.body.classList.remove("dragging");
  openFile([...event.dataTransfer.files].find((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")));
});

window.compare = { run: compare, done: false, result: null };
if (params.has("run")) {
  window.compare.result = await compare({ script: true });
  window.compare.done = true;
} else {
  compare({ script: false });
}
