// The film: each engine alone in a throttled browser, recorded with the DevTools screencast, then
// stacked side by side with ffmpeg and held on the result. Needs ffmpeg.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { launch, newPage } from "../../bench/cdp.mjs";
import { reportPdf } from "../../bench/generate.mjs";
import { serve } from "../../bench/serve.mjs";
import { DARK, FONT } from "./theme.mjs";

const here = import.meta.dirname;
const out = path.join(here, "../../docs");
const PANE = { width: 640, height: 720 };
const PAGES = 240;
const FPS = 15;
// bench/browser.mjs's default, so the slowdown it measures is this one.
const SLOWDOWN = 4;

const server = await serve({ extraRoots: { film: here } });
server.docs.set("report.pdf", reportPdf({ pages: PAGES, imageSize: 240 }));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "recto-film-"));
const run = (args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { timeout: 5 * 60_000 });

async function record(browser, engine, hue, take) {
  const page = await newPage(browser, PANE);
  await page.send("Emulation.setDeviceMetricsOverride", { width: PANE.width, height: PANE.height, deviceScaleFactor: 1, mobile: false });
  const dir = path.join(temp, `${engine.replace(/\W/g, "")}${take}`);
  fs.mkdirSync(dir);
  const frames = [];
  const onFrame = (message) => {
    if (message.method === "Page.screencastFrame" && message.sessionId === page.sessionId) {
      const file = path.join(dir, `${frames.length}.jpg`);
      fs.writeFileSync(file, Buffer.from(message.params.data, "base64"));
      frames.push({ file, at: message.params.metadata.timestamp });
      void page.send("Page.screencastFrameAck", { sessionId: message.params.sessionId });
    }
  };
  browser.on(onFrame);
  await page.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1, maxWidth: PANE.width, maxHeight: PANE.height });
  const q = new URLSearchParams({ engine, hue, doc: "/doc/report.pdf", width: "800" });
  await page.goto(`${server.origin}/film/film.html?${q}`);
  const deadline = Date.now() + 120_000;
  while (!(await page.evaluate("Boolean(window.begin)").catch(() => false))) {
    if (Date.now() > deadline) throw new Error("the pane never loaded");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  // The pane as it first appears is where the film starts, not the blank page before it.
  const began = Date.now() / 1000;
  await page.evaluate("window.begin(); 1");
  let result;
  while (!result) {
    if (Date.now() > deadline) throw new Error(`${engine} didn't finish: ${page.logs.join("; ")}`);
    result = await page.evaluate("window.result");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (result.failure) throw new Error(result.failure);
  // Long enough for the last frame to come through a slowed browser.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await page.send("Page.stopScreencast");
  browser.off(onFrame);
  await page.close();
  while (frames.length > 1 && frames[1].at <= began) frames.shift();
  const list = frames
    .map((frame, i) => `file '${frame.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.at ?? frame.at + 0.05) - frame.at).toFixed(3)}`)
    .join("\n");
  const concat = path.join(dir, "list.txt");
  fs.writeFileSync(concat, `${list}\nfile '${frames.at(-1).file}'\n`);
  const video = path.join(temp, `${path.basename(dir)}.mp4`);
  run(["-f", "concat", "-safe", "0", "-i", concat, "-vf", `fps=${FPS},scale=${PANE.width}:${PANE.height},format=yuv420p`, "-c:v", "libx264", "-crf", "12", video]);
  const seconds = (frames.at(-1).at - frames[0].at);
  return { engine, video, result, seconds, frames: frames.length };
}

const browser = await launch({ width: PANE.width, height: PANE.height, slowdown: SLOWDOWN });
// Each engine three times, in turn, after one of each to warm the browser itself. The take shown
// is the median one, so the film is neither engine's best or worst.
const median = (takes) => takes.toSorted((a, b) => a.result.total - b.result.total)[1];
const rectoTakes = [];
const pdfjsTakes = [];
await record(browser, "recto", DARK.recto, "warm");
await record(browser, "pdf.js", DARK.pdfjs, "warm");
for (let take = 0; take < 3; take++) {
  pdfjsTakes.push(await record(browser, "pdf.js", DARK.pdfjs, take));
  rectoTakes.push(await record(browser, "recto", DARK.recto, take));
}
const recto = median(rectoTakes);
const pdfjs = median(pdfjsTakes);
await browser.close();
console.error(`takes, ms: recto ${rectoTakes.map((t) => t.result.total.toFixed(0))}; pdf.js ${pdfjsTakes.map((t) => t.result.total.toFixed(0))}`);
console.error(`recto ${recto.result.total.toFixed(0)} ms, ${recto.frames} frames; pdf.js ${pdfjs.result.total.toFixed(0)} ms, ${pdfjs.frames} frames`);

// The closing strip, drawn by a browser so its type matches.
const ratio = pdfjs.result.total / recto.result.total;
const strip = path.join(temp, "strip.png");
{
  const fast = await launch();
  const page = await newPage(fast, { width: 2 * PANE.width + 4, height: 96 });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 2 * PANE.width + 4, height: 96, deviceScaleFactor: 1, mobile: false });
  const measured = JSON.parse(fs.readFileSync(path.join(here, "../../bench/results/browser.json"), "utf8")).slowdown.factor;
  const html = `<!doctype html><meta charset=utf-8><style>body{margin:0;background:${DARK.recto};color:#fff;font-family:${FONT};height:96px;display:flex;flex-direction:column;align-items:center;justify-content:center}b{font-size:38px;font-weight:650;letter-spacing:-.01em}span{font-size:19px;opacity:.92}</style><b>recto finished ${ratio.toFixed(1)}× sooner: ${(recto.result.total / 1000).toFixed(1)} s against ${(pdfjs.result.total / 1000).toFixed(1)} s</b><span>A recording in Chromium with the CPU slowed ${measured}×, ${PAGES} pages at 800 px, each engine in its own run</span>`;
  await page.send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(strip, Buffer.from(data, "base64"));
  await page.close();
  await fast.close();
}

const HOLD = 3.5;
const total = Math.max(recto.seconds, pdfjs.seconds);
const filter = [
  `[0:v]tpad=stop_mode=clone:stop_duration=${(total - recto.seconds + HOLD).toFixed(2)}[left]`,
  `[1:v]tpad=stop_mode=clone:stop_duration=${(total - pdfjs.seconds + HOLD).toFixed(2)}[right]`,
  `color=c=#3a3a37:s=4x${PANE.height}:r=${FPS}[gap]`,
  `[left][gap][right]hstack=inputs=3:shortest=1[side]`,
  `[side][2:v]overlay=0:H-h:enable='gte(t,${total.toFixed(2)})':shortest=1[all]`,
].join(";");
const stacked = path.join(temp, "stacked.mp4");
run(["-i", recto.video, "-i", pdfjs.video, "-loop", "1", "-i", strip, "-filter_complex", filter, "-map", "[all]", "-t", (total + HOLD).toFixed(2), "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", stacked]);
fs.copyFileSync(stacked, path.join(temp, "keep.mp4"));

// GIF: a palette per film, little dither, so type and white pages stay clean.
const WIDTH = 800;
const palette = path.join(temp, "palette.png");
run(["-i", stacked, "-vf", `fps=${FPS},scale=${WIDTH}:-2:flags=lanczos,palettegen=max_colors=200:stats_mode=diff`, palette]);
const gif = path.join(out, "recto-film.gif");
run(["-i", stacked, "-i", palette, "-lavfi", `fps=${FPS},scale=${WIDTH}:-2:flags=lanczos[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, "-loop", "0", gif]);
await server.close();
fs.writeFileSync(path.join(out, "recto-film.json"), `${JSON.stringify({ date: new Date().toISOString(), pages: PAGES, recto: recto.result.total, pdfjs: pdfjs.result.total, ratio }, null, 1)}\n`);
console.log(`docs/recto-film.gif: ${(fs.statSync(gif).size / 2 ** 20).toFixed(1)} MB, ${(total + HOLD).toFixed(1)} s, recto ${recto.result.total.toFixed(0)} ms, pdf.js ${pdfjs.result.total.toFixed(0)} ms`);
if (process.env.RECTO_FILM_KEEP) fs.cpSync(temp, process.env.RECTO_FILM_KEEP, { recursive: true });
fs.rmSync(temp, { recursive: true, force: true });
process.exit(0);
