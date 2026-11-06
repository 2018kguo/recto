// A PDF engine: Rust compiled to WebAssembly behind a small, synchronous API.
//
//   await using doc = await openPdf(bytes);
//   doc.pageCount; doc.text(0); doc.render(0, { width: 1024 });

export {
  ANNOT_SUBTYPE,
  boxAt,
  CHAR_GENERATED,
  CHAR_UNMAPPED,
  charsText,
  PATH_FILL,
  PATH_STROKE,
  type PdfAnnotation,
  type PdfBitmap,
  type PdfBox,
  type PdfDocument,
  type PdfFont,
  type PdfOutlineItem,
  type PdfPageInfo,
  type PdfPageObjects,
  type PdfPageText,
  type PdfPathSegments,
  type PdfRenderAsyncOptions,
  type PdfRenderOptions,
  type PdfTextRuns,
  type PdfWords,
  SEGMENT_BEZIER,
  SEGMENT_CLOSE,
  SEGMENT_LINE,
  SEGMENT_MOVE,
  SEGMENT_RECT,
} from "./document.ts";
export {
  createPdfEngine,
  openPdf,
  type PdfEngine,
  type PdfEngineOptions,
  type PdfEngineStats,
  type PdfOpenOptions,
} from "./engine.ts";
export { PdfError, type PdfErrorCode } from "./errors.ts";
export {
  type PageBox,
  rasterMeasures,
  showsGlyphs,
  vectorMeasures,
} from "./page-measures.ts";
export type {
  PdfRangedDocument,
  PdfRangedOpenOptions,
  PdfRangedStats,
  PdfRangeSource,
} from "./ranged.ts";
export {
  BREAK_LINE,
  BREAK_NONE,
  BREAK_SPACE,
  readingOrder,
  type ReadingOrder,
} from "./reading-order.ts";
export {
  annotationPaintedText,
  annotationShownText,
  annotationTextItems,
  NOT_TEXT,
  type PdfTextItem,
  textItems,
  visibleCodepoint,
} from "./text-items.ts";
