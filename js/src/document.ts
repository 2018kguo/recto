// One open PDF. Every coordinate this returns is in the viewer's frame: PDF points, top-left
// origin, with /Rotate and the crop box applied.

import type { createGlue } from "../wasm/recto.gen.mjs";
import type * as Glue from "../wasm/recto.types.mjs";
import { PdfError, type PdfErrorCode } from "./errors.ts";

export type PdfBox = { x: number; y: number; width: number; height: number };

export type PdfPageInfo = {
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
};

export type PdfFont = {
  name: string;
  /** PDF font descriptor flags (fixed pitch, serif, symbolic, italic, ...). */
  flags: number;
  /** 100 to 900 as the file states it, or as its name says; 0 where it says nothing. */
  weight: number;
  embedded: boolean;
  /** Top of this font's char boxes, in ems above the baseline: the descriptor's, or 0.8. */
  ascent: number;
  /** Bottom of this font's char boxes, in ems (negative): the descriptor's, or -0.2. */
  descent: number;
};

/** `PdfPageText.flags` bit: a space or line break the engine inferred; not in the content stream. */
export const CHAR_GENERATED = 1;
/** `PdfPageText.flags` bit: the glyph has no Unicode mapping, so its text is unreadable. */
export const CHAR_UNMAPPED = 2;

/**
 * A page's characters as columns (structure of arrays): char `i` is entry
 * `i` of every column, and entries `4i..4i+3` of `boxes`. Typed arrays, so
 * a page crosses a thread boundary by transfer, not by copying objects.
 */
export type PdfPageText = {
  /** The whole page's text, generated spaces included. */
  text: string;
  count: number;
  /** Unicode code points (U+FFFD where a glyph's code is no scalar value). */
  codepoints: Uint32Array<ArrayBuffer>;
  /** x, y, width, height per char: the advance by the font's ascent and descent, not glyph ink. */
  boxes: Float32Array<ArrayBuffer>;
  /** The size each char is drawn at, in points: `Tf` scaled by the text and page matrices. */
  fontSizes: Float32Array<ArrayBuffer>;
  /** The `Tf` operand each char was shown with, unscaled. */
  tfSizes: Float32Array<ArrayBuffer>;
  /** Radians, counter-clockwise. */
  angles: Float32Array<ArrayBuffer>;
  /** Fill colour as 0xRRGGBBAA. */
  fills: Uint32Array<ArrayBuffer>;
  /** Index into `fonts`; -1 for characters the engine generated. */
  fontIds: Int32Array<ArrayBuffer>;
  /** CHAR_GENERATED | CHAR_UNMAPPED. */
  flags: Uint8Array<ArrayBuffer>;
  /** One per font dictionary used on the page. */
  fonts: PdfFont[];
  /** The page showed more glyphs than one page may collect (2^19); the rest aren't here. */
  truncated: boolean;
  /** Runs of non-space chars in content order, as char ranges and boxes. */
  words: PdfWords;
  /**
   * Index into `runs` per char: the text object (one show-text operator)
   * the char was drawn by; -1 for chars the engine generated.
   */
  runIds: Int32Array<ArrayBuffer>;
  runs: PdfTextRuns;
};

/**
 * One entry per text object, in the order its chars first appear: where
 * its text starts and how large it is drawn. Every char of a run sits on
 * the run's baseline (a rise or a new line starts a new text object).
 */
export type PdfTextRuns = {
  count: number;
  /** x, y per run: the text origin on the baseline, in the viewer frame. */
  origins: Float32Array<ArrayBuffer>;
  /** The font size as drawn, in points (Tf scaled by the text and current matrices). */
  ems: Float32Array<ArrayBuffer>;
};

export type PdfWords = {
  count: number;
  /** First and last char index of each word, inclusive. */
  firstChar: Uint32Array<ArrayBuffer>;
  lastChar: Uint32Array<ArrayBuffer>;
  /** x, y, width, height per word: the union of its char boxes. */
  boxes: Float32Array<ArrayBuffer>;
};

/** Entry `i` of a `boxes` column. */
export function boxAt(boxes: Float32Array, i: number): PdfBox {
  return {
    x: boxes[4 * i] ?? 0,
    y: boxes[4 * i + 1] ?? 0,
    width: boxes[4 * i + 2] ?? 0,
    height: boxes[4 * i + 3] ?? 0,
  };
}

/** The text of chars `first..last` (inclusive). */
export function charsText(
  page: Pick<PdfPageText, "codepoints">,
  first: number,
  last: number
): string {
  let out = "";
  for (let i = first; i <= last; i++) {
    out += String.fromCodePoint(page.codepoints[i] ?? 0xff_fd);
  }
  return out;
}

/** Segment kinds, in the low bits of `PdfPathSegments.kinds`. */
export const SEGMENT_LINE = 0;
export const SEGMENT_BEZIER = 1;
export const SEGMENT_MOVE = 2;
/** `PdfPathSegments.kinds` bit: the segment closes its subpath. */
export const SEGMENT_CLOSE = 4;
/**
 * `PdfPathSegments.kinds` bit on a move: its subpath is a rectangle drawn by
 * `re` (pdf.js counts only those as rectangles).
 */
export const SEGMENT_RECT = 8;
/** `paths.flags` bits. */
export const PATH_FILL = 1;
export const PATH_STROKE = 2;

/** All paths' segments end to end; path `i` owns `start[i]..start[i+1]`. */
export type PdfPathSegments = {
  count: number;
  /** x, y per segment end point, in the viewer frame. */
  points: Float32Array<ArrayBuffer>;
  /** SEGMENT_LINE | SEGMENT_BEZIER | SEGMENT_MOVE, plus SEGMENT_CLOSE and SEGMENT_RECT. */
  kinds: Uint8Array<ArrayBuffer>;
};

/**
 * A page's images and paths as columns. Form XObjects are flattened, their
 * transforms applied; every box and point is in the viewer frame.
 */
export type PdfPageObjects = {
  textObjects: number;
  /** The page held more than one page may collect (2^21 path segments, 2^19 images); the rest aren't here. */
  truncated: boolean;
  images: {
    count: number;
    /** x, y, width, height per image. */
    boxes: Float32Array<ArrayBuffer>;
    /** Pixel width, height per image (0, 0 when the engine cannot say). */
    pixels: Uint32Array<ArrayBuffer>;
  };
  paths: {
    count: number;
    /** x, y, width, height per path. */
    boxes: Float32Array<ArrayBuffer>;
    /** PATH_FILL | PATH_STROKE. */
    flags: Uint8Array<ArrayBuffer>;
    /** count + 1 offsets into `segments`. */
    start: Uint32Array<ArrayBuffer>;
  };
  segments: PdfPathSegments;
};

type TypedColumn =
  | Float32Array<ArrayBuffer>
  | Uint32Array<ArrayBuffer>
  | Uint8Array<ArrayBuffer>;

export type PdfAnnotation = {
  subtype: number;
  box: PdfBox;
  /** /Contents (a FreeText's text; a note for most other kinds); "" when absent. */
  contents: string;
  /**
   * A widget's form field: its type (/FT: "Tx", "Ch", "Btn", "Sig") and
   * value (/V, both inherited through /Parent); null for other annotations.
   * A multi-select choice field's /V array reads as "".
   */
  field: { type: string; value: string } | null;
  /**
   * Objects in the annotation's normal appearance, and how many of them are
   * text: a stamp that paints words has text objects. 0 without an
   * appearance.
   */
  appearanceObjects: number;
  appearanceTextObjects: number;
  /**
   * The text the appearance's text objects paint, one object a line (a
   * stamp's words, a list box's options), each line trimmed.
   */
  appearanceText: string;
};

export type PdfRenderOptions = {
  /** Target width in pixels; the scale also keeps height within `maxHeight`. */
  width: number;
  /** Default 4096. May be Infinity, to fit the width alone. A render is capped at 16,384 px a side and 64 Mpx. */
  maxHeight?: number;
};

export type PdfRenderAsyncOptions = PdfRenderOptions & {
  /** Stops the render at the next pause: `aborted`, with the document still usable. */
  signal?: AbortSignal;
  /** About how long it runs before giving the thread back. Default 8. */
  sliceMs?: number;
};

export type PdfBitmap = {
  width: number;
  height: number;
  /** Opaque RGBA on a white background, four bytes a pixel. */
  rgba: Uint8Array<ArrayBuffer>;
  /**
   * The page passed a limit on what one render may do (more than 32 groups that need the page
   * redrawn under them), so past that those groups are drawn as if isolated.
   */
  truncated: boolean;
};

export const ANNOT_SUBTYPE = {
  text: 1,
  link: 2,
  freeText: 3,
  stamp: 13,
  widget: 20,
} as const;

/**
 * An open PDF. Every call is synchronous CPU work on this thread. Closing is idempotent, and
 * every other method throws a PdfError with code "closed" afterwards.
 */
/** A bookmark. `page` is -1 if it goes nowhere in this file; `url` is set if it links out. */
export type PdfOutlineItem = {
  title: string;
  page: number;
  url: string | null;
  children: PdfOutlineItem[];
};

export interface PdfDocument {
  readonly pageCount: number;
  /** The document's bookmarks; empty if it has none. */
  outline(): PdfOutlineItem[];
  /** What each page is called, one string per page ("iv", "A-5"), or null if the file doesn't say. */
  pageLabels(): string[] | null;
  /**
   * Which of the document's trees were cut short: `pages` means `pageCount` may be short, by a limit or
   * because a damaged tree left no pages (an honestly empty document says false). `pageLabels` and `outline`
   * mean those passed a limit, and may be wrong or incomplete. A page's own limits are `truncated` on its results.
   */
  structureTruncated(): { pages: boolean; pageLabels: boolean; outline: boolean };
  pageInfo(index: number): PdfPageInfo;
  text(index: number): PdfPageText;
  /** `text`, `objects` and `annotations` from one interpretation of the page. */
  scan(index: number): {
    text: PdfPageText;
    objects: PdfPageObjects;
    annotations: PdfAnnotation[];
  };
  /** `text` and `annotations` from one interpretation of the page. */
  textAndAnnotations(index: number): {
    text: PdfPageText;
    annotations: PdfAnnotation[];
  };
  objects(index: number): PdfPageObjects;
  annotations(index: number): PdfAnnotation[];
  render(index: number, options: PdfRenderOptions): PdfBitmap;
  /**
   * The same pixels as `render`, giving the thread back between slices, and stoppable with a
   * signal. The last step, rasterizing, is one piece: about a third of a heavy page's time.
   */
  renderAsync(index: number, options: PdfRenderAsyncOptions): Promise<PdfBitmap>;
  close(): void;
  [Symbol.dispose](): void;
}

const DEFAULT_MAX_HEIGHT = 4096;
const MAX_DIMENSION = 16_384;

export type Instance = {
  glue: ReturnType<typeof createGlue>;
  /** False for the text-only wasm, which has no `render`, `objects` or `scan`. */
  full: boolean;
  memory: WebAssembly.Memory;
  generation: number;
  openDocuments: number;
  /** The engine's count of documents open, on any of its instances. */
  documents: { open: number };
  /** Set once the instance trapped or an asset failed; nothing may call it again. */
  dead: boolean;
  /** An asset's load failure, rethrown by the call that needed the asset. */
  failure: PdfError | undefined;
  /** Called when a document on this instance closes. */
  onClose?: () => void;
};

/** What a call into the instance threw, as what the caller should see. */
export function engineFailure(instance: Instance, error: unknown): unknown {
  if (error instanceof PdfError) {
    return error;
  }
  // An exhausted call stack in WebAssembly is a RangeError, and leaves the instance in the
  // same unknown state as a trap. The argument checks that throw RangeError run before any call.
  if (error instanceof WebAssembly.RuntimeError || error instanceof RangeError) {
    instance.dead = true;
    return new PdfError("crash", `the engine crashed: ${error.message}`, error);
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    return new PdfError(code as PdfErrorCode, (error as Error).message);
  }
  return error;
}

/** Runs `read` over an object wasm-bindgen allocated, freeing it even if `read` throws. */
function consume<T extends { free(): void }, R>(owned: T, read: (owned: T) => R): R {
  try {
    return read(owned);
  } finally {
    owned.free();
  }
}

function toText(t: Glue.PageText): PdfPageText {
  return consume(t, () => {
    const fontFlags = t.fontFlags;
    const fontWeights = t.fontWeights;
    const fontEmbedded = t.fontEmbedded;
    const fontAscents = t.fontAscents;
    const fontDescents = t.fontDescents;
    const fonts: PdfFont[] = t.fontNames.map((name, i) => ({
      name,
      flags: fontFlags[i] ?? 0,
      weight: fontWeights[i] ?? 0,
      embedded: fontEmbedded[i] === 1,
      ascent: fontAscents[i] ?? 0,
      descent: fontDescents[i] ?? 0,
    }));
    const wordFirstChar = t.wordFirstChar;
    const runEms = t.runEms;
    return {
      text: t.text,
      count: t.count,
      codepoints: t.codepoints,
      boxes: t.boxes,
      fontSizes: t.fontSizes,
      tfSizes: t.tfSizes,
      truncated: t.truncated,
      angles: t.angles,
      fills: t.fills,
      fontIds: t.fontIds,
      flags: t.flags,
      fonts,
      words: {
        count: wordFirstChar.length,
        firstChar: wordFirstChar,
        lastChar: t.wordLastChar,
        boxes: t.wordBoxes,
      },
      runIds: t.runIds,
      runs: { count: runEms.length, origins: t.runOrigins, ems: runEms },
    };
  });
}

function toObjects(o: Glue.PageObjects): PdfPageObjects {
  return consume(o, () => {
    const imageBoxes = o.imageBoxes;
    const pathFlags = o.pathFlags;
    const segmentKinds = o.segmentKinds;
    return {
      textObjects: o.textObjects,
      truncated: o.truncated,
      images: {
        count: imageBoxes.length / 4,
        boxes: imageBoxes,
        pixels: o.imagePixels,
      },
      paths: {
        count: pathFlags.length,
        boxes: o.pathBoxes,
        flags: pathFlags,
        start: o.pathStart,
      },
      segments: {
        count: segmentKinds.length,
        points: o.segmentPoints,
        kinds: segmentKinds,
      },
    };
  });
}

function toAnnotations(a: Glue.Annotations): PdfAnnotation[] {
  return consume(a, () => {
    const subtypes = a.subtypes;
    const boxes = a.boxes;
    const contents = a.contents;
    const hasField = a.hasField;
    const fieldTypes = a.fieldTypes;
    const fieldValues = a.fieldValues;
    const objects = a.appearanceObjects;
    const textObjects = a.appearanceTextObjects;
    const text = a.appearanceText;
    const out: PdfAnnotation[] = [];
    for (let i = 0; i < a.count; i++) {
      out.push({
        subtype: subtypes[i] ?? 0,
        box: boxAt(boxes, i),
        contents: contents[i] ?? "",
        field:
          hasField[i] === 1
            ? { type: fieldTypes[i] ?? "", value: fieldValues[i] ?? "" }
            : null,
        appearanceObjects: objects[i] ?? 0,
        appearanceTextObjects: textObjects[i] ?? 0,
        appearanceText: text[i] ?? "",
      });
    }
    return out;
  });
}

const DEFAULT_SLICE_MS = 8;

/** Back to the event loop, without the 4 ms a nested timer waits in a browser. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(0);
  });
}

export class RectoDocument implements PdfDocument {
  readonly pageCount: number;
  #closed = false;
  #doc: Glue.Document;
  #instance: Instance;
  /** The same file on the full engine. Dropped once used: it holds the instance it came from. */
  #moveToFull: ((doc: Glue.Document) => { instance: Instance; doc: Glue.Document }) | null;
  /** A ranged read's failure, thrown by the call whose fetch it failed. */
  readonly #fetchFailure: () => PdfError | null;

  constructor(
    instance: Instance,
    doc: Glue.Document,
    moveToFull: (doc: Glue.Document) => { instance: Instance; doc: Glue.Document },
    fetchFailure: () => PdfError | null = () => null
  ) {
    this.#instance = instance;
    this.#doc = doc;
    this.#moveToFull = moveToFull;
    this.#fetchFailure = fetchFailure;
    this.pageCount = doc.pageCount;
    instance.openDocuments += 1;
    instance.documents.open += 1;
  }

  #check(index: number): void {
    if (this.#closed) {
      throw new PdfError("closed", "this document is closed");
    }
    if (!(Number.isInteger(index) && index >= 0 && index < this.pageCount)) {
      throw new RangeError(
        `page ${index} is out of range (0..${this.pageCount - 1})`
      );
    }
    if (this.#instance.failure) {
      throw this.#instance.failure;
    }
    if (this.#instance.dead) {
      throw new PdfError(
        "crash",
        "the engine crashed earlier on this thread; open the document again"
      );
    }
  }

  #call<T>(fn: () => T): T {
    let result: T;
    try {
      result = fn();
    } catch (error) {
      // A failed fetch or asset surfaces inside the engine as some other error.
      const failure = this.#instance.failure ?? this.#fetchFailure();
      if (failure && !(error instanceof WebAssembly.RuntimeError)) {
        throw failure;
      }
      throw engineFailure(this.#instance, error);
    }
    // Or as a page that reads short: blank text must not pass for the page's text.
    const failure = this.#instance.failure ?? this.#fetchFailure();
    if (failure) {
      throw failure;
    }
    return result;
  }

  /**
   * The document starts on the text-only wasm. The first call that needs the rest loads it and
   * opens the file again there, in this call: a synchronous API can't wait for it any other way.
   */
  #needsFull(): void {
    if (this.#instance.full) {
      return;
    }
    const old = this.#instance;
    const moved = this.#call(() => this.#moveToFull!(this.#doc));
    this.#moveToFull = null;
    old.openDocuments -= 1;
    this.#doc.free();
    old.onClose?.();
    this.#instance = moved.instance;
    this.#doc = moved.doc;
    moved.instance.openDocuments += 1;
  }

  pageInfo(index: number): PdfPageInfo {
    this.#check(index);
    return this.#call(() => {
      const [width = 0, height = 0, rotation = 0] = this.#doc.pageInfo(index);
      return { width, height, rotation: rotation as PdfPageInfo["rotation"] };
    });
  }

  text(index: number): PdfPageText {
    this.#check(index);
    return this.#call(() => toText(this.#doc.pageText(index)));
  }

  objects(index: number): PdfPageObjects {
    this.#check(index);
    this.#needsFull();
    return this.#call(() => toObjects(this.#doc.objects(index)));
  }

  pageLabels(): string[] | null {
    if (this.#closed) {
      throw new PdfError("closed", "this document is closed");
    }
    return this.#call(() => this.#doc.pageLabels() as string[] | null);
  }

  structureTruncated(): { pages: boolean; pageLabels: boolean; outline: boolean } {
    if (this.#closed) {
      throw new PdfError("closed", "this document is closed");
    }
    const [pages, pageLabels, outline] = this.#call(() => this.#doc.structureTruncated() as Uint8Array);
    return { pages: pages === 1, pageLabels: pageLabels === 1, outline: outline === 1 };
  }

  outline(): PdfOutlineItem[] {
    if (this.#closed) {
      throw new PdfError("closed", "this document is closed");
    }
    return this.#call(() => {
      const top: PdfOutlineItem[] = [];
      // The open item at each level; an item's parent is the last one a level up.
      const open: PdfOutlineItem[] = [];
      for (const [title, url, level, page] of this.#doc.outline() as [string, string, number, number][]) {
        const item: PdfOutlineItem = { title, page, url: url || null, children: [] };
        (level === 0 ? top : (open[level - 1]?.children ?? top)).push(item);
        open[level] = item;
      }
      return top;
    });
  }

  annotations(index: number): PdfAnnotation[] {
    this.#check(index);
    return this.#call(() => toAnnotations(this.#doc.annotations(index)));
  }

  scan(index: number) {
    this.#check(index);
    this.#needsFull();
    return this.#call(() =>
      consume(this.#doc.scan(index), (scan) => ({
        text: toText(scan.takeText()!),
        objects: toObjects(scan.takeObjects()!),
        annotations: toAnnotations(scan.takeAnnotations()!),
      }))
    );
  }

  textAndAnnotations(index: number) {
    this.#check(index);
    return this.#call(() =>
      consume(this.#doc.textAndAnnotations(index), (scan) => ({
        text: toText(scan.takeText()!),
        annotations: toAnnotations(scan.takeAnnotations()!),
      }))
    );
  }

  render(index: number, options: PdfRenderOptions): PdfBitmap {
    this.#check(index);
    const maxHeight = options.maxHeight ?? DEFAULT_MAX_HEIGHT;
    if (
      !(options.width > 0 && options.width <= MAX_DIMENSION) ||
      !(maxHeight > 0)
    ) {
      throw new RangeError(
        `render width must be in 1..${MAX_DIMENSION} and maxHeight above 0`
      );
    }
    this.#needsFull();
    return this.#call(() =>
      consume(this.#doc.render(index, options.width, maxHeight), (page) => ({
        width: page.width,
        height: page.height,
        truncated: page.truncated,
        rgba: page.takeRgba(),
      }))
    );
  }

  async renderAsync(index: number, options: PdfRenderAsyncOptions): Promise<PdfBitmap> {
    this.#check(index);
    const maxHeight = options.maxHeight ?? DEFAULT_MAX_HEIGHT;
    if (
      !(options.width > 0 && options.width <= MAX_DIMENSION) ||
      !(maxHeight > 0)
    ) {
      throw new RangeError(
        `render width must be in 1..${MAX_DIMENSION} and maxHeight above 0`
      );
    }
    this.#needsFull();
    const instance = this.#instance;
    const sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
    const task = this.#call(() => this.#doc.renderTask(index, options.width, maxHeight));
    const stopIfAsked = () => {
      if (options.signal?.aborted) {
        throw new PdfError("aborted", "the signal was aborted", options.signal.reason);
      }
      if (this.#closed) {
        throw new PdfError("closed", "this document is closed");
      }
      if (instance.dead) {
        throw instance.failure ?? new PdfError("crash", "the engine crashed while this render was paused; open the document again");
      }
    };
    try {
      stopIfAsked();
      while (!this.#call(() => task.step(sliceMs))) {
        await nextTask();
        stopIfAsked();
      }
      await nextTask();
      stopIfAsked();
      return this.#call(() =>
        consume(task.finish(), (page) => ({
          width: page.width,
          height: page.height,
          truncated: page.truncated,
          rgba: page.takeRgba(),
        }))
      );
    } finally {
      if (!instance.dead) {
        task.free();
      }
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#instance.openDocuments -= 1;
    this.#instance.documents.open -= 1;
    if (!this.#instance.dead) {
      this.#doc.free();
    }
    this.#instance.onClose?.();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

// A browser without Symbol.dispose yet: tools that lower `using` look for this one instead.
Object.defineProperty(RectoDocument.prototype, Symbol.for("Symbol.dispose"), {
  value: RectoDocument.prototype.close,
});
