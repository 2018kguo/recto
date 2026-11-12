// Each engine behind the same small shape, written the way its own docs use it, so the
// benchmark measures engines and not adapters. Runs in Node and in a browser.

const yieldToLoop = () => new Promise((resolve) => setTimeout(resolve));

/** Calls are synchronous; `using` is what closes a document. */
export function rectoEngine(engine) {
  return {
    name: "recto",
    async open(bytes) {
      const doc = await engine.open(bytes);
      return {
        pageCount: doc.pageCount,
        text: async (i) => doc.text(i).text,
        render: async (i, width) => doc.render(i, { width }),
        close: () => doc.close(),
      };
    },
    yieldToLoop,
  };
}

/** `canvasOf` turns pdf.js's canvas into the bytes the others end with; the page's choice. */
export function pdfjsEngine(pdfjs, options) {
  return {
    name: "pdf.js",
    async open(bytes) {
      const task = pdfjs.getDocument({ ...options, data: new Uint8Array(bytes) });
      const doc = await task.promise;
      return {
        pageCount: doc.numPages,
        async text(i) {
          const page = await doc.getPage(i + 1);
          const { items } = await page.getTextContent();
          let text = "";
          for (const item of items) text += item.hasEOL ? `${item.str}\n` : item.str;
          page.cleanup();
          return text;
        },
        async render(i, width) {
          const page = await doc.getPage(i + 1);
          const unscaled = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: width / unscaled.width });
          const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          page.cleanup();
          return { width: canvas.width, height: canvas.height, canvas, context };
        },
        close: () => task.destroy(),
      };
    },
    yieldToLoop,
  };
}

/**
 * Stock pdfium from `@embedpdf/pdfium`, by its raw C API. `pdfium` is its initialised module.
 * `forms` adds the form-fill environment, without which pdfium leaves widgets out of a render.
 */
export function pdfiumEngine(pdfium, { forms = false } = {}) {
  const m = pdfium.pdfium;
  const FPDFBitmap_BGRA = 4;
  const FPDF_REVERSE_BYTE_ORDER = 0x10;
  const FPDF_ANNOT = 0x01;
  pdfium.PDFiumExt_Init();
  return {
    name: "pdfium",
    async open(bytes) {
      const at = m.wasmExports.malloc(bytes.length);
      m.HEAPU8.set(bytes, at);
      const handle = pdfium.FPDF_LoadMemDocument(at, bytes.length, "");
      if (!handle) {
        m.wasmExports.free(at);
        throw new Error(`pdfium could not open it: error ${pdfium.FPDF_GetLastError()}`);
      }
      let formInfo = 0;
      let formEnvironment = 0;
      if (forms) {
        // FPDF_FORMFILLINFO, version 2, with no callbacks.
        formInfo = m.wasmExports.malloc(512);
        m.HEAPU8.fill(0, formInfo, formInfo + 512);
        m.HEAP32[formInfo >> 2] = 2;
        formEnvironment = pdfium.FPDFDOC_InitFormFillEnvironment(handle, formInfo);
      }
      return {
        pageCount: pdfium.FPDF_GetPageCount(handle),
        async text(i) {
          const page = pdfium.FPDF_LoadPage(handle, i);
          if (!page) throw new Error(`pdfium could not load page ${i}: error ${pdfium.FPDF_GetLastError()}`);
          const textPage = pdfium.FPDFText_LoadPage(page);
          const count = pdfium.FPDFText_CountChars(textPage);
          const buffer = m.wasmExports.malloc((count + 1) * 2);
          pdfium.FPDFText_GetText(textPage, 0, count, buffer);
          const text = new TextDecoder("utf-16le").decode(m.HEAPU8.subarray(buffer, buffer + count * 2));
          m.wasmExports.free(buffer);
          pdfium.FPDFText_ClosePage(textPage);
          pdfium.FPDF_ClosePage(page);
          return text;
        },
        async render(i, width) {
          const page = pdfium.FPDF_LoadPage(handle, i);
          if (!page) throw new Error(`pdfium could not load page ${i}: error ${pdfium.FPDF_GetLastError()}`);
          const height = Math.ceil((width * pdfium.FPDF_GetPageHeightF(page)) / pdfium.FPDF_GetPageWidthF(page));
          const bitmap = pdfium.FPDFBitmap_CreateEx(width, height, FPDFBitmap_BGRA, 0, 0);
          pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
          pdfium.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER);
          if (formEnvironment) pdfium.FPDF_FFLDraw(formEnvironment, bitmap, page, 0, 0, width, height, 0, FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER);
          const buffer = pdfium.FPDFBitmap_GetBuffer(bitmap);
          const rgba = m.HEAPU8.slice(buffer, buffer + width * height * 4);
          pdfium.FPDFBitmap_Destroy(bitmap);
          pdfium.FPDF_ClosePage(page);
          return { width, height, rgba };
        },
        close() {
          if (formEnvironment) pdfium.FPDFDOC_ExitFormFillEnvironment(formEnvironment);
          if (formInfo) m.wasmExports.free(formInfo);
          pdfium.FPDF_CloseDocument(handle);
          m.wasmExports.free(at);
        },
      };
    },
    yieldToLoop,
  };
}

/**
 * MuPDF from Artifex's own WebAssembly package, `mupdf` (AGPL-3.0), by its documented calls.
 * `mupdf` is the imported module. A render is RGBA with the paper left transparent, which is what
 * `toPixmap` gives with alpha; everything that reads one here composites it over white.
 */
export function mupdfEngine(mupdf) {
  return {
    name: "mupdf",
    async open(bytes) {
      const doc = mupdf.Document.openDocument(bytes, "application/pdf");
      if (doc.needsPassword()) {
        doc.destroy();
        throw new Error("mupdf could not open it: needs a password");
      }
      return {
        pageCount: doc.countPages(),
        async text(i) {
          const page = doc.loadPage(i);
          const stext = page.toStructuredText("preserve-whitespace");
          const text = stext.asText();
          stext.destroy();
          page.destroy();
          return text;
        },
        async render(i, width) {
          const page = doc.loadPage(i);
          const [x0, , x1] = page.getBounds();
          const scale = width / (x1 - x0);
          const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, true, true);
          const out = { width: pixmap.getWidth(), height: pixmap.getHeight(), rgba: pixmap.getPixels().slice() };
          pixmap.destroy();
          page.destroy();
          return out;
        },
        close: () => doc.destroy(),
      };
    },
    yieldToLoop,
  };
}
