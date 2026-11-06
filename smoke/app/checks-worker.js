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

    self.postMessage({ startMs, latin, closed, cjk, ranged, ignored, short, noExpose, missingAsset });
  } catch (error) {
    self.postMessage({ failure: `${error}\n${error?.stack}` });
  }
};
