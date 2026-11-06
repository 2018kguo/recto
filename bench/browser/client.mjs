// The same calls whichever engine it is. pdf.js as its docs arrange it: parser in its worker,
// drawing on the page's main thread. recto and pdfium do both in a worker and post the bitmap.
import { pdfjsEngine } from "/app/engines.mjs";

export async function connect(name) {
  if (name === "pdf.js") {
    const pdfjs = await import("/pdfjs/build/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerPort = new Worker("/app/pdfjs-worker.mjs", { type: "module" });
    const engine = pdfjsEngine(pdfjs, {
      isEvalSupported: false,
      verbosity: 0,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      wasmUrl: "/pdfjs/wasm/",
    });
    let doc;
    return {
      async open(bytes) {
        doc = await engine.open(bytes);
        return doc.pageCount;
      },
      text: (i) => doc.text(i),
      async render(i, width) {
        const { canvas } = await doc.render(i, width);
        return canvas;
      },
      close: () => doc.close(),
    };
  }
  const worker = new Worker(`/app/worker.mjs?engine=${encodeURIComponent(name)}`, { type: "module" });
  const waiting = new Map();
  let next = 1;
  let ready;
  const started = new Promise((resolve) => (ready = resolve));
  worker.onmessage = ({ data }) => {
    if (data.ready) return ready();
    const { resolve, reject } = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.error) reject(new Error(data.error));
    else resolve(data.result);
  };
  worker.onerror = (event) => console.error(`worker: ${event.message}`);
  const call = (op, args = [], transfer = []) =>
    new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, op, args }, transfer);
    });
  await started;
  return {
    open: (bytes) => call("open", [bytes], [bytes.buffer]),
    text: (i) => call("text", [i]),
    async render(i, width) {
      const { width: w, height, rgba } = await call("render", [i, width]);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = height;
      canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), w, height), 0, 0);
      return canvas;
    },
    close: () => call("close"),
  };
}
