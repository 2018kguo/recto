// The benchmark chart, from bench/results: one panel per measure, each on its own scale. A light
// and a dark file, picked by the README's <picture>, so the chart follows GitHub's theme setting
// and not just the system's.
import fs from "node:fs";
import path from "node:path";

import { DARK, FONT, LIGHT } from "./theme.mjs";

const root = path.join(import.meta.dirname, "../..");
const node = JSON.parse(fs.readFileSync(path.join(root, "bench/results/node.json"), "utf8"));
const browser = JSON.parse(fs.readFileSync(path.join(root, "bench/results/browser.json"), "utf8"));
const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const mb = (v) => `${Math.round(v / 1e6)} MB`;
const pick = (group, key) => ["recto", "pdf.js", "pdfium"].map((e) => group.summary[key][e].median);
const PANELS = [
  { title: "Read text", note: `Node, ${node.documents.used} PDFs`, values: pick(node, "text"), format: ms },
  { title: "Render", note: `Node, ${node.documents.used} PDFs`, values: pick(node, "render"), format: ms },
  { title: "Open a report in a page", note: `Chromium slowed ${browser.slowdown.factor}×, 40 pages, all drawn`, values: pick(browser, "loadDone"), format: ms },
  { title: "Peak memory", note: `Node, the process, same ${node.documents.used} PDFs`, values: pick(node, "rss"), format: mb },
];
const NAMES = ["recto", "pdf.js", "pdfium"];
const WIDTH = 880;
const PANEL_W = 420;
const PANEL_H = 164;
const GAP_X = 40;
const TOP = 54;

function svg(theme) {
  const hues = [theme.recto, theme.pdfjs, theme.pdfium];
  let body = "";
  // Legend, with every bar also labelled by name.
  let lx = 0;
  NAMES.forEach((name, i) => {
    body += `<rect x="${lx}" y="10" width="14" height="14" rx="4" fill="${hues[i]}"/><text x="${lx + 20}" y="22" class="t" font-size="15" font-weight="600">${name}</text>`;
    lx += 20 + name.length * 9 + 26;
  });
  PANELS.forEach((panel, p) => {
    const x = p % 2 === 0 ? 0 : PANEL_W + GAP_X;
    const y = TOP + Math.floor(p / 2) * (PANEL_H + 14);
    body += `<text x="${x}" y="${y + 14}" class="t" font-size="17" font-weight="650">${panel.title}</text>`;
    body += `<text x="${x}" y="${y + 33}" class="s" font-size="13">${panel.note}</text>`;
    const max = Math.max(...panel.values);
    const LABEL = 56;
    const VALUE = 64;
    const room = PANEL_W - LABEL - VALUE;
    panel.values.forEach((value, i) => {
      const barY = y + 46 + i * 36;
      const w = Math.max(3, (value / max) * room);
      body += `<text x="${x}" y="${barY + 19}" class="s" font-size="14">${NAMES[i]}</text>`;
      // Rounded at the data end, square at the baseline.
      body += `<path d="M${x + LABEL} ${barY} h${w - 4} a4 4 0 0 1 4 4 v20 a4 4 0 0 1 -4 4 h-${w - 4} z" fill="${hues[i]}"/>`;
      body += `<text x="${x + LABEL + w + 8}" y="${barY + 19}" class="t" font-size="14" font-weight="${i === 0 ? 650 : 400}">${panel.format(value)}</text>`;
    });
  });
  const height = TOP + 2 * (PANEL_H + 14) - 14;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img" aria-label="Benchmark medians: ${PANELS.map((p) => `${p.title}: ${NAMES.map((n, i) => `${n} ${p.format(p.values[i])}`).join(", ")}`).join("; ")}">
<style>text{font-family:${FONT}}.t{fill:${theme.text}}.s{fill:${theme.secondary}}</style>
${body}
</svg>
`;
}
fs.writeFileSync(path.join(root, "docs/benchmarks-light.svg"), svg(LIGHT));
fs.writeFileSync(path.join(root, "docs/benchmarks-dark.svg"), svg(DARK));
console.log("docs/benchmarks-light.svg, docs/benchmarks-dark.svg");
