// "What you get back": a generated page rendered by recto, with the word boxes, images and paths its
// API returned drawn on top. Through the package's real calls; nothing here knows the page.
import fs from "node:fs";
import path from "node:path";

import { createCanvas, ImageData } from "../../bench/node_modules/@napi-rs/canvas/index.js";
import { reportPdf } from "../../bench/generate.mjs";
import { openPdf } from "../../js/dist/index.js";
import { FONT, LIGHT } from "./theme.mjs";

const out = path.join(import.meta.dirname, "../../docs/anatomy.png");
const SCALE = 2;
const WIDTH = 612 * SCALE;
await using doc = await openPdf(reportPdf({ pages: 2, imageSize: 480 }));
const { rgba, width, height } = doc.render(1, { width: WIDTH });
const { words } = doc.text(1);
const { images, paths } = doc.objects(1);

const LEGEND = 92;
const canvas = createCanvas(width, height + LEGEND);
const context = canvas.getContext("2d");
context.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), width, height), 0, 0);

const box = (boxes, i, stroke, fill, line = 1.4) => {
  const [x, y, w, h] = [boxes[4 * i], boxes[4 * i + 1], boxes[4 * i + 2], boxes[4 * i + 3]].map((v) => v * SCALE);
  context.fillStyle = fill;
  context.fillRect(x, y, w, h);
  context.strokeStyle = stroke;
  context.lineWidth = line;
  context.strokeRect(x, y, w, h);
};
for (let i = 0; i < paths.count; i++) box(paths.boxes, i, `${LIGHT.pdfium}cc`, `${LIGHT.pdfium}18`, 1);
for (let i = 0; i < images.count; i++) box(images.boxes, i, LIGHT.pdfjs, `${LIGHT.pdfjs}12`, 3);
for (let i = 0; i < words.count; i++) box(words.boxes, i, LIGHT.recto, `${LIGHT.recto}26`, 1);

context.fillStyle = LIGHT.surface;
context.fillRect(0, height, width, LEGEND);
context.fillStyle = LIGHT.grid;
context.fillRect(0, height, width, 2);
const items = [
  [LIGHT.recto, `${words.count} words`],
  [LIGHT.pdfjs, `${images.count} image, ${images.pixels[0]} x ${images.pixels[1]} px`],
  [LIGHT.pdfium, `${paths.count} paths`],
];
context.font = `600 34px ${FONT}`;
context.textBaseline = "middle";
let x = 48;
for (const [hue, label] of items) {
  context.fillStyle = hue;
  context.beginPath();
  context.roundRect(x, height + LEGEND / 2 - 14, 28, 28, 7);
  context.fill();
  context.fillStyle = LIGHT.text;
  context.fillText(label, x + 42, height + LEGEND / 2 + 1);
  x += 42 + context.measureText(label).width + 56;
}
fs.writeFileSync(out, canvas.toBuffer("image/png"));
console.log(`docs/anatomy.png: ${width} x ${height + LEGEND}, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
