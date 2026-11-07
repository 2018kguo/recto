// One engine, one file, in a process of its own, so that a hang or a trap costs that page and not the
// run. Writes a line of JSON per event on stdout; bench/scorecard.mjs reads them, restarts it past a
// page that timed out, and kills it when it goes quiet.
//
//   node bench/scorecard-worker.mjs <engine> <file> <directory> <width> <first page> <page limit>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { pdfiumEngine, pdfjsEngine, rectoEngine } from "./engines.mjs";

const here = import.meta.dirname;
const [engineName, file, directory, widthArgument, firstArgument, limitArgument] = process.argv.slice(2);
const WIDTH = Number(widthArgument);
const FIRST = Number(firstArgument);
const LIMIT = Number(limitArgument);
const say = (event) => fs.writeSync(1, `${JSON.stringify(event)}\n`);

/** RGB, deflated at the lowest level: a thousand pages of this have to fit on a laptop. */
function save(page, width, height, rgb) {
  fs.mkdirSync(directory, { recursive: true });
  const body = zlib.deflateSync(rgb, { level: 1 });
  const head = Buffer.alloc(8);
  head.writeUInt32LE(width, 0);
  head.writeUInt32LE(height, 4);
  fs.writeFileSync(path.join(directory, `${page}.rgb`), Buffer.concat([head, body]));
}
function rgbOf(rgba) {
  const rgb = Buffer.allocUnsafe((rgba.length / 4) * 3);
  // Whatever an engine leaves unpainted counts as the white paper it would sit on.
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    const a = rgba[i + 3];
    if (a === 255) {
      rgb[o] = rgba[i];
      rgb[o + 1] = rgba[i + 1];
      rgb[o + 2] = rgba[i + 2];
    } else {
      rgb[o] = (rgba[i] * a + 255 * (255 - a)) / 255;
      rgb[o + 1] = (rgba[i + 1] * a + 255 * (255 - a)) / 255;
      rgb[o + 2] = (rgba[i + 2] * a + 255 * (255 - a)) / 255;
    }
  }
  return rgb;
}
const errorOf = (error) => ({ code: error?.code ?? error?.name ?? "error", message: String(error?.message ?? error).slice(0, 200) });

async function canvasEngine(open) {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const doc = await open(bytes);
  say({ open: true, pageCount: doc.pageCount });
  const stop = Math.min(doc.pageCount, FIRST + LIMIT);
  for (let page = FIRST; page < stop; page++) {
    say({ start: page });
    try {
      const drawn = await doc.render(page, WIDTH);
      const rgba = drawn.rgba ?? drawn.context.getImageData(0, 0, drawn.width, drawn.height).data;
      save(page, drawn.width, drawn.height, rgbOf(rgba));
      say({ done: page });
    } catch (error) {
      say({ failed: page, ...errorOf(error) });
    }
  }
  await doc.close();
}

function poppler() {
  const info = execFileSync("pdfinfo", [file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const pageCount = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0);
  if (pageCount === 0) throw Object.assign(new Error("pdfinfo reports no pages"), { code: "open" });
  say({ open: true, pageCount });
  const stop = Math.min(pageCount, FIRST + LIMIT);
  for (let page = FIRST; page < stop; page++) {
    say({ start: page });
    try {
      // pdftoppm's -scale-to-x and -y are the page's sides before /Rotate.
      const box = execFileSync("pdfinfo", ["-f", String(page + 1), "-l", String(page + 1), file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const size = /size:\s+([\d.]+) x ([\d.]+) pts/.exec(box);
      const turned = Math.abs(Number(/rot:\s+(-?\d+)/.exec(box)?.[1] ?? 0)) % 180 === 90;
      const [across, down] = turned ? [size?.[2], size?.[1]] : [size?.[1], size?.[2]];
      const height = Math.ceil((WIDTH * Number(down)) / Number(across)) || -1;
      const ppm = execFileSync("pdftoppm", ["-q", "-f", String(page + 1), "-l", String(page + 1), "-singlefile", "-cropbox", "-scale-to-x", String(turned ? height : WIDTH), "-scale-to-y", String(turned ? WIDTH : height), file], {
        maxBuffer: 2 ** 30,
        stdio: ["ignore", "pipe", "ignore"],
      });
      // P6\nW H\n255\n, then RGB.
      let at = 0;
      const fields = [];
      while (fields.length < 4) {
        const start = at;
        while (ppm[at] > 32) at++;
        fields.push(ppm.subarray(start, at).toString());
        at++;
      }
      save(page, Number(fields[1]), Number(fields[2]), ppm.subarray(at));
      say({ done: page });
    } catch (error) {
      say({ failed: page, code: "render", message: String(error?.message ?? error).slice(0, 200) });
    }
  }
}

try {
  if (engineName === "poppler") {
    poppler();
  } else if (engineName === "recto") {
    const { createPdfEngine } = await import(path.join(here, "../js/dist/index.js"));
    const engine = rectoEngine(await createPdfEngine());
    await canvasEngine((bytes) => engine.open(bytes));
  } else if (engineName === "pdf.js") {
    const pdfjs = await import(path.join(here, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
    const root = path.join(here, "node_modules/pdfjs-dist");
    const engine = pdfjsEngine(pdfjs, { isEvalSupported: false, verbosity: 0, standardFontDataUrl: `${root}/standard_fonts/`, cMapUrl: `${root}/cmaps/`, cMapPacked: true, wasmUrl: `${root}/wasm/` });
    await canvasEngine((bytes) => engine.open(bytes));
  } else if (engineName === "pdfium") {
    const { init } = await import(path.join(here, "node_modules/@embedpdf/pdfium/dist/index.js"));
    const engine = pdfiumEngine(await init({ wasmBinary: fs.readFileSync(path.join(here, "node_modules/@embedpdf/pdfium/dist/pdfium.wasm")) }), { forms: true });
    await canvasEngine((bytes) => engine.open(bytes));
  } else {
    throw new Error(`no engine called ${engineName}`);
  }
  say({ finished: true, maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) });
} catch (error) {
  say({ openFailed: true, ...errorOf(error) });
}
process.exit(0);
