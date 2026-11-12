// recto, pdfium or MuPDF in a dedicated worker, answering calls from the page.
import "./instrument.mjs";
import { mupdfEngine, pdfiumEngine, rectoEngine } from "/app/engines.mjs";

const name = new URL(import.meta.url).searchParams.get("engine");
let engine;
let recto;
if (name === "recto") {
  const { createPdfEngine } = await import("/recto/dist/index.js");
  recto = await createPdfEngine();
  engine = rectoEngine(recto);
} else if (name === "mupdf") {
  engine = mupdfEngine(await import("/mupdf/mupdf.js"));
} else {
  const { init } = await import("/pdfium/index.browser.js");
  const wasmBinary = await (await fetch("/pdfium/pdfium.wasm")).arrayBuffer();
  engine = pdfiumEngine(await init({ wasmBinary }));
}
let doc;
const ops = {
  async open(bytes) {
    doc = await engine.open(bytes);
    return doc.pageCount;
  },
  text: (i) => doc.text(i),
  render: (i, width) => doc.render(i, width),
  close: () => doc.close(),
  // recto's own: the render that gives the thread back, on a document of its own.
  async sliced(bytes, width) {
    const own = await recto.open(bytes);
    await own.renderAsync(0, { width });
    own.close();
  },
};
self.onmessage = async ({ data: { id, op, args } }) => {
  try {
    const result = await ops[op](...args);
    self.postMessage({ id, result }, result?.rgba ? [result.rgba.buffer] : []);
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
self.postMessage({ ready: true });
