// What a Web Worker gets with no setup: the wasm and its assets found by the bundler, fonts
// and CMaps read synchronously on first use, and ranged reads over a synchronous request.
import { createPdfEngine, openPdf, PdfError } from "@2018kguo/recto";

const ink = ({ rgba }) => {
  let dark = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    dark += rgba[i] < 128 ? 1 : 0;
  }
  return dark;
};
const codeOf = async (promise) => {
  try {
    (await promise)?.close();
    return "opened";
  } catch (error) {
    return error instanceof PdfError ? error.code : String(error);
  }
};

// A part lost and then changed by the server, found out before a call and in the middle of one.
async function checkParts(pdfs, report) {
  try {
    const bytesOf = async (name) => await (await fetch(`/${name}`)).arrayBuffer();
    const set = (name, state) => fetch(`${pdfs}/flaky-set/${name}/${state}`);
    const attempt = (doc, then) => {
      try {
        return then(doc.render(0, { width: 64 }));
      } catch (error) {
        return error.code ?? String(error);
      }
    };
    const stages = async (name, doc, then) => {
      const seen = [];
      for (const state of ["gone", "changed", "back"]) {
        await set(name, state);
        seen.push(state, attempt(doc, then));
      }
      return seen;
    };
    const assetBase = new URL("/flaky/", pdfs).href;
    const beforeCall = await createPdfEngine({ assetBase });
    const reportDoc = await beforeCall.open(report);
    const render = await stages("recto-render.wasm", reportDoc, (bitmap) => (bitmap.rgba.some((v) => v !== 255) ? "drawn" : "blank"));
    reportDoc.close();

    const midCall = await createPdfEngine({ assetBase });
    await set("recto-render.wasm", "back");
    const jbig2Doc = await midCall.open(await bytesOf("jbig2.pdf"));
    const other = await midCall.open(report);
    const otherText = other.text(0).text;
    const expected = (await (await createPdfEngine()).open(await bytesOf("raw.pdf"))).render(0, { width: 64 }).rgba.join();
    const jbig2 = await stages("recto-rare.wasm", jbig2Doc, (bitmap) => (bitmap.rgba.join() === expected ? "same" : "different"));
    const otherDocument = other.text(0).text === otherText;
    jbig2Doc.close();
    other.close();

    const inked = async (name) => {
      const doc = await (await createPdfEngine()).open(await bytesOf(name));
      const { rgba } = doc.render(0, { width: 64 });
      doc.close();
      return rgba.some((v) => v < 200);
    };
    return { jbig2, render, otherDocument, jpxInk: await inked("jpx.pdf"), meshInk: await inked("mesh.pdf") };
  } catch (error) {
    return { failure: String(error) };
  }
}

self.onmessage = async ({ data: pdfs }) => {
  try {
    const started = performance.now();
    const engine = await createPdfEngine();
    const startMs = Math.round(performance.now() - started);

    const report = await (await fetch("/report.pdf")).arrayBuffer();
    const doc = await openPdf(report);
    const bitmap = doc.render(0, { width: 1024 });
    const latin = {
      text: doc.text(0).text,
      width: bitmap.width,
      height: bitmap.height,
      ink: ink(bitmap),
    };
    doc.close();
    let closed;
    try {
      doc.text(0);
    } catch (error) {
      closed = error.code;
    }

    const cjkBytes = await (await fetch(`${pdfs}/range/cjk.pdf`)).arrayBuffer();
    const cjkDoc = await engine.open(cjkBytes);
    const cjk = {
      texts: [0, 1, 2, 3].map((page) => cjkDoc.text(page).text.trim()),
      ink: ink(cjkDoc.render(0, { width: 612 })),
    };
    cjkDoc.close();

    const rangedDoc = await engine.openRanged(`${pdfs}/range/report.pdf`, { chunkBytes: 256 });
    const ranged = { pageCount: rangedDoc.pageCount, text: rangedDoc.text(1).text, ...rangedDoc.stats() };
    rangedDoc.close();
    // Chunks small enough that the head and tail leave the middle to fetch: the first round's two
    // requests go out together, by fetch, and the rest as the parse asks.
    const smallDoc = await engine.openRanged(`${pdfs}/range/report.pdf`, { chunkBytes: 64 });
    const smallChunks = { text: smallDoc.text(1).text, ...smallDoc.stats() };
    smallDoc.close();

    const refusedDoc = await engine.openRanged(`${pdfs}/suffix416/report.pdf`);
    const refused = { pageCount: refusedDoc.pageCount, ...refusedDoc.stats() };
    refusedDoc.close();

    const ignoredDoc = await engine.openRanged(`${pdfs}/ignore/report.pdf`, { chunkBytes: 256 });
    const ignored = { pageCount: ignoredDoc.pageCount, ...ignoredDoc.stats() };
    ignoredDoc.close();

    const short = await codeOf(engine.openRanged(`${pdfs}/short/report.pdf`, { chunkBytes: 256 }));
    const noExpose = await engine.openRanged(`${pdfs}/noexpose/report.pdf`, { chunkBytes: 256 }).then(
      (opened) => {
        opened.close();
        return { code: "opened" };
      },
      (error) => ({ code: error.code, message: error.message })
    );
    const missingAsset = { code: await codeOf(createPdfEngine({ assetBase: "/nowhere/" })) };

    const parts = await checkParts(pdfs, report);

    self.postMessage({ startMs, latin, closed, cjk, ranged, smallChunks, refused, ignored, short, noExpose, missingAsset, parts });
  } catch (error) {
    self.postMessage({ failure: `${error}\n${error?.stack}` });
  }
};
