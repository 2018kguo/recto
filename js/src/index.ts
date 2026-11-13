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
  type PdfDestination,
  type PdfDocument,
  type PdfFont,
  type PdfLink,
  type PdfLinkTarget,
  type PdfOutlineItem,
  type PdfPageInfo,
  type PdfPageObjects,
  type PdfPageText,
  type PdfPathSegments,
  type PdfRegionBitmap,
  type PdfRenderAsyncOptions,
  type PdfRenderOptions,
  type PdfTextOptions,
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
export type { PdfPool, PdfPoolDocument, PdfPoolOpenOptions, PdfPoolOptions } from "./pool.ts";
export {
  type PageBox,
  rasterMeasures,
  showsGlyphs,
  vectorMeasures,
} from "./page-measures.ts";
export {
  type PdfRangedDocument,
  type PdfRangedOpenOptions,
  type PdfRangedRead,
  type PdfRangedStats,
  type PdfRangeSource,
  startRangedRead,
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

/**
 * Runs a document's pages across worker threads:
 *
 *   using pool = await createPdfPool();
 *   await using doc = await pool.open(bytes);
 *   const pages = await Promise.all(Array.from({ length: doc.pageCount }, (_, i) => doc.text(i)));
 *
 * Loaded only when called, so a program that doesn't use it doesn't download it.
 */
export async function createPdfPool(options: import("./pool.ts").PdfPoolOptions = {}): Promise<import("./pool.ts").PdfPool> {
  const { startPool } = await import("./pool.ts");
  return startPool(options);
}
