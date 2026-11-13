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
  /**
   * x, y, width, height per char. By default the advance by the font's ascent and descent; with
   * `{ boxes: "tight" }`, the glyph's own outline bounds. See `PdfTextOptions`.
   */
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
  /**
   * Draws only this part of the page: x, y, width, height in points in the viewer frame, as text and
   * annotation boxes are (top-left origin, `/Rotate` and the crop box applied). The bitmap holds the
   * pixels of the whole page's bitmap at the scale `width` and `maxHeight` give that this covers,
   * grown out to whole pixels and cut to the page, and says where they are. With a region the limits
   * are on the region's bitmap, not the page's, and `width` may be up to 262,144.
   */
  region?: PdfBox;
};

/** A render of a region: where its pixels are in the whole page's bitmap at that scale. */
export type PdfRegionBitmap = PdfBitmap & {
  /** The bitmap's top-left pixel, in the whole page's bitmap. */
  x: number;
  y: number;
  /** The whole page's bitmap's size at this scale: what `render` without a region and its limits would give. */
  pageWidth: number;
  pageHeight: number;
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

/**
 * Where a destination goes: a page, and the place on it, both as the file writes it (in the page's
 * user space) and in that page's viewer frame.
 */
export type PdfDestination = {
  /**
   * The page's index, or -1 if it goes nowhere in this file. In another file's destination (`remote`,
   * `embedded`), the index that file's page has there, or -1 for a destination by name.
   */
  page: number;
  /**
   * How to show the page, as the file names it: "XYZ", "Fit", "FitH", "FitV", "FitR", "FitB", "FitBH",
   * "FitBV"; null if it names none.
   */
  view: string | null;
  /**
   * The point to bring to the window's top-left, in points in the target page's viewer frame
   * (top-left origin, its `/Rotate` and crop box applied). null for a coordinate the destination leaves
   * as it was; under a quarter turn, the page's `left` is the viewer's `y`.
   */
  x: number | null;
  y: number | null;
  /** "XYZ"'s zoom, 1 for 100%; null to leave it as it was. */
  zoom: number | null;
  /** "FitR"'s rectangle, in the target page's viewer frame; null for any other view. */
  box: PdfBox | null;
  /**
   * The view's numbers as the file writes them, in the target page's user space (y up, before
   * `/Rotate` and the crop box): "XYZ"'s left and top, "FitH"'s and "FitBH"'s top, "FitV"'s and
   * "FitBV"'s left, "FitR"'s four. null where it gives none.
   */
  left: number | null;
  bottom: number | null;
  right: number | null;
  top: number | null;
  /** The named destination it was reached by; with `page` -1, a name the file doesn't define. */
  name: string | null;
};

/** One step of an embedded file's path from the file a link is in: to its parent, or to a child by name. */
export type PdfEmbeddedStep = { relation: "parent" | "child"; name: string | null };

/** What a link does. Another file or a program is reported, never followed. */
export type PdfLinkTarget =
  | { kind: "uri"; uri: string }
  /** A `GoTo` action or the link's `/Dest`, named destinations resolved. */
  | { kind: "page"; destination: PdfDestination }
  /**
   * `GoToR`: a destination in another file. `file` as written (a relative path stays relative), and
   * `fileSystem` its specification's `/FS` ("URL") if it names one. `destination.page` is the page's
   * index there and `destination.name` a name there; `name` and `page` repeat them (page null for
   * none). Open that file and pass `destination` to its `destination()` to place it.
   */
  | {
      kind: "remote";
      file: string;
      fileSystem: string | null;
      destination: PdfDestination;
      newWindow: boolean | null;
      name: string | null;
      page: number | null;
    }
  /**
   * `GoToE`: a destination in an embedded file, reached by `path` from this file (or from `file`, if
   * set). `destination` as `remote`'s.
   */
  | { kind: "embedded"; file: string | null; path: PdfEmbeddedStep[]; destination: PdfDestination; newWindow: boolean | null }
  /** `Launch`: a file or program. */
  | { kind: "launch"; file: string }
  /** Any other action by its `/S` ("JavaScript", "SubmitForm", ...); a `Named` action's `/N` ("NextPage", ...) is `name`. */
  | { kind: "action"; action: string; name: string | null }
  /** No action and no destination. */
  | { kind: "none" };

/** A `/Link` annotation and where it goes. */
export type PdfLink = {
  /** Its index in what `annotations` returns for the page. */
  annotation: number;
  /** Its `/Rect` in the viewer frame, as its annotation's `box`. */
  box: PdfBox;
  target: PdfLinkTarget;
};

export const ANNOT_SUBTYPE = {
  text: 1,
  link: 2,
  freeText: 3,
  stamp: 13,
  widget: 20,
} as const;

/**
 * A bookmark. `page` is -1 if it goes nowhere in this file; `url` is set if it links out. `target` is
 * where it goes in full, as a link's: its `/Dest`, or else its action.
 */
export type PdfOutlineItem = {
  title: string;
  page: number;
  url: string | null;
  target: PdfLinkTarget;
  children: PdfOutlineItem[];
};

/**
 * An open PDF. Every call is synchronous CPU work on this thread. Closing is idempotent, and
 * every other method throws a PdfError with code "closed" afterwards.
 */
export interface PdfDocument {
  readonly pageCount: number;
  /** The document's bookmarks; empty if it has none. */
  outline(): PdfOutlineItem[];
  /** Where the document opens, its catalog's `/OpenAction`; `{ kind: "none" }` if it names none. */
  openAction(): PdfLinkTarget;
  /**
   * A named destination of this document (the catalog's `/Dests` or its `/Names` tree), for a link
   * from another file that names one here; `page` -1 with the name if none is called that. Or another
   * file's destination for a page of this one (a `remote` target's), placed on it: `x`, `y` and `box`
   * in this page's viewer frame, from its user space numbers.
   */
  destination(target: string | PdfDestination): PdfDestination;
  /** What each page is called, one string per page ("iv", "A-5"), or null if the file doesn't say. */
  pageLabels(): string[] | null;
  /**
   * Which of the document's trees were cut short: `pages` means `pageCount` may be short, by a limit or
   * because a damaged tree left no pages (an honestly empty document says false). `pageLabels` and `outline`
   * mean those passed a limit, and may be wrong or incomplete. A page's own limits are `truncated` on its results.
   */
  structureTruncated(): { pages: boolean; pageLabels: boolean; outline: boolean };
  pageInfo(index: number): PdfPageInfo;
  text(index: number, options?: PdfTextOptions): PdfPageText;
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
  /**
   * The page's links, in the order `annotations` lists them, and where each goes. Loads drawing's
   * part of the wasm, as `objects` does.
   */
  links(index: number): PdfLink[];
  render(index: number, options: PdfRenderOptions & { region: PdfBox }): PdfRegionBitmap;
  render(index: number, options: PdfRenderOptions): PdfBitmap;
  /**
   * The same pixels as `render`, giving the thread back between slices, and stoppable with a
   * signal. The last step, rasterizing, is one piece: about a third of a heavy page's time.
   */
  renderAsync(index: number, options: PdfRenderAsyncOptions & { region: PdfBox }): Promise<PdfRegionBitmap>;
  renderAsync(index: number, options: PdfRenderAsyncOptions): Promise<PdfBitmap>;
  close(): void;
  [Symbol.dispose](): void;
}

const DEFAULT_MAX_HEIGHT = 4096;
const MAX_DIMENSION = 16_384;
/** With a region, the whole page's bitmap may be up to this wide. */
const MAX_REGION_DIMENSION = 262_144;

/** What `text` takes. */
export type PdfTextOptions = {
  /**
   * What each char's box spans. `"font"`, the default: the advance across, by the font's ascent and
   * descent, the same height for every char of a font, read from the font's dictionary alone. `"tight"`:
   * the glyph's outline bounds from its font program (what a Type 3 glyph draws), as pdfium's
   * `FPDFText_GetCharBox` gives; a glyph with no outline, such as a space, keeps its font box. Word boxes
   * are the union of their chars' either way, and the text is the same. Tight boxes load the font programs
   * that reading text otherwise leaves alone, and the standard fonts a document names, as drawing does.
   */
  boxes?: "font" | "tight";
};

function tightBoxes(options: PdfTextOptions | undefined): boolean {
  const boxes = options?.boxes ?? "font";
  if (boxes !== "font" && boxes !== "tight") {
    throw new RangeError(`text boxes must be "font" or "tight", not ${JSON.stringify(boxes)}`);
  }
  return boxes === "tight";
}

/** `width`, `maxHeight` and the region as the engine takes them (NaNs for none), or a RangeError. */
function renderArgs(options: PdfRenderOptions): [number, number, number, number, number, number] {
  const maxHeight = options.maxHeight ?? DEFAULT_MAX_HEIGHT;
  const { region } = options;
  const most = region ? MAX_REGION_DIMENSION : MAX_DIMENSION;
  if (!(options.width > 0 && options.width <= most) || !(maxHeight > 0)) {
    throw new RangeError(
      region
        ? `with a region, render width must be in 1..${MAX_REGION_DIMENSION} and maxHeight above 0`
        : `render width must be in 1..${MAX_DIMENSION} and maxHeight above 0`
    );
  }
  if (!region) {
    return [options.width, maxHeight, Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  }
  const { x, y, width, height } = region;
  if (![x, y, width, height].every((v) => typeof v === "number" && Number.isFinite(v)) || !(width > 0 && height > 0)) {
    throw new RangeError("a render's region needs finite x and y, and width and height above 0");
  }
  return [options.width, maxHeight, x, y, width, height];
}

/** A rendered page as `render` returns it: with a region, where it is on the page. */
function bitmapOf(page: Glue.RenderedPage, region: boolean): PdfBitmap | PdfRegionBitmap {
  const bitmap: PdfBitmap = {
    width: page.width,
    height: page.height,
    truncated: page.truncated,
    rgba: page.takeRgba(),
  };
  return region ? { ...bitmap, x: page.x, y: page.y, pageWidth: page.pageWidth, pageHeight: page.pageHeight } : bitmap;
}

export type Instance = {
  glue: ReturnType<typeof createGlue>;
  /** Loads a part of the wasm, hashed first, or throws `missing-asset` having changed nothing. */
  loadPart(name: "recto-render.wasm" | "recto-more.wasm" | "recto-rare.wasm"): void;
  memory: WebAssembly.Memory;
  /** Its memory when it was made: past this, something used it, and dropping it gives memory back. */
  startBytes: number;
  generation: number;
  openDocuments: number;
  /** The engine's count of documents open, on any of its instances. */
  documents: { open: number };
  /** Set once the instance trapped; nothing may call it again. */
  dead: boolean;
  /**
   * Set once a part or asset failed to load inside a call. Nothing more runs on it, but a document's
   * file is still whole there, so it reopens on another instance at its next call.
   */
  abandoned: boolean;
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

/** A destination as the engine gives one: see `destination` in wasm.rs. */
type DestinationEntry = [
  number, string | null, number, number, number, number, number, number, number,
  number, number, number, number, string | null,
];

/** A target as the engine gives one: see `target` in wasm.rs. */
type TargetEntry = [
  "none" | "uri" | "page" | "remote" | "embedded" | "launch" | "action",
  string | null,
  DestinationEntry | null,
  string | null,
  string | null,
  boolean | null,
  [boolean, string | null][] | null,
];

const orNull = (v: number) => (Number.isNaN(v) ? null : v);

function toDestination([page, view, x, y, zoom, rx, ry, rw, rh, left, bottom, right, top, name]: DestinationEntry): PdfDestination {
  return {
    page,
    view,
    x: orNull(x),
    y: orNull(y),
    zoom: orNull(zoom),
    box: Number.isNaN(rx) ? null : { x: rx, y: ry, width: rw, height: rh },
    left: orNull(left),
    bottom: orNull(bottom),
    right: orNull(right),
    top: orNull(top),
    name,
  };
}

function toTarget([kind, text, dest, name, fileSystem, newWindow, path]: TargetEntry): PdfLinkTarget {
  const destination = dest ? toDestination(dest) : null;
  switch (kind) {
    case "uri":
      return { kind, uri: text ?? "" };
    case "page":
      return { kind, destination: destination! };
    case "remote":
      return {
        kind,
        file: text ?? "",
        fileSystem,
        destination: destination!,
        newWindow,
        name: destination!.name,
        page: destination!.page < 0 ? null : destination!.page,
      };
    case "embedded":
      return {
        kind,
        file: text,
        path: (path ?? []).map(([parent, step]) => ({ relation: parent ? "parent" : "child", name: step })),
        destination: destination!,
        newWindow,
      };
    case "launch":
      return { kind, file: text ?? "" };
    case "action":
      return { kind, action: text ?? "", name };
    default:
      return { kind: "none" };
  }
}

/** One link as the engine lists it: see `links` in wasm.rs. */
type LinkEntry = [number, number, number, number, number, TargetEntry];

function toLink([annotation, x, y, width, height, target]: LinkEntry): PdfLink {
  return { annotation, box: { x, y, width, height }, target: toTarget(target) };
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
  /** The same file on another instance. */
  readonly #reopen: (doc: Glue.Document, instance: Instance) => { instance: Instance; doc: Glue.Document };
  /** A ranged read's failure, thrown by the call whose fetch it failed. */
  readonly #fetchFailure: () => PdfError | null;

  constructor(
    instance: Instance,
    doc: Glue.Document,
    reopen: (doc: Glue.Document, instance: Instance) => { instance: Instance; doc: Glue.Document },
    fetchFailure: () => PdfError | null = () => null
  ) {
    this.#instance = instance;
    this.#doc = doc;
    this.#reopen = reopen;
    this.#fetchFailure = fetchFailure;
    this.pageCount = doc.pageCount;
    instance.openDocuments += 1;
    instance.documents.open += 1;
  }

  /** Before every call: open, the page there (null for a call about the whole document), and the instance able to run it. */
  #check(index: number | null): void {
    if (this.#closed) {
      throw new PdfError("closed", "this document is closed");
    }
    if (index !== null && !(Number.isInteger(index) && index >= 0 && index < this.pageCount)) {
      throw new RangeError(
        `page ${index} is out of range (0..${this.pageCount - 1})`
      );
    }
    if (this.#instance.abandoned) {
      this.#moveOffAbandoned();
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

  /** The call that failed told the caller; this one is a fresh start. */
  #moveOffAbandoned(): void {
    const old = this.#instance;
    let moved: { instance: Instance; doc: Glue.Document };
    try {
      moved = this.#reopen(this.#doc, old);
    } catch (error) {
      throw engineFailure(old, error);
    }
    old.openDocuments -= 1;
    old.onClose?.();
    this.#instance = moved.instance;
    this.#doc = moved.doc;
    moved.instance.openDocuments += 1;
  }

  /** Loaded ahead of the call, so that failing to get it leaves nothing half-done. */
  #needsRender(): void {
    this.#call(() => this.#instance.loadPart("recto-render.wasm"));
  }

  pageInfo(index: number): PdfPageInfo {
    this.#check(index);
    return this.#call(() => {
      const [width = 0, height = 0, rotation = 0] = this.#doc.pageInfo(index);
      return { width, height, rotation: rotation as PdfPageInfo["rotation"] };
    });
  }

  text(index: number, options?: PdfTextOptions): PdfPageText {
    this.#check(index);
    const tight = tightBoxes(options);
    // Glyph outlines are read by drawing's part of the wasm, and so are the fonts drawing resolves.
    if (tight) {
      this.#needsRender();
    }
    return this.#call(() => toText(this.#doc.pageText(index, tight)));
  }

  objects(index: number): PdfPageObjects {
    this.#check(index);
    this.#needsRender();
    return this.#call(() => toObjects(this.#doc.objects(index)));
  }

  pageLabels(): string[] | null {
    this.#check(null);
    return this.#call(() => this.#doc.pageLabels() as string[] | null);
  }

  structureTruncated(): { pages: boolean; pageLabels: boolean; outline: boolean } {
    this.#check(null);
    const [pages, pageLabels, outline] = this.#call(() => this.#doc.structureTruncated() as Uint8Array);
    return { pages: pages === 1, pageLabels: pageLabels === 1, outline: outline === 1 };
  }

  outline(): PdfOutlineItem[] {
    this.#check(null);
    return this.#call(() => {
      const top: PdfOutlineItem[] = [];
      // The open item at each level; an item's parent is the last one a level up.
      const open: PdfOutlineItem[] = [];
      for (const [title, url, level, page, target] of this.#doc.outline() as [string, string, number, number, TargetEntry][]) {
        const item: PdfOutlineItem = { title, page, url: url || null, target: toTarget(target), children: [] };
        (level === 0 ? top : (open[level - 1]?.children ?? top)).push(item);
        open[level] = item;
      }
      return top;
    });
  }

  openAction(): PdfLinkTarget {
    this.#check(null);
    return this.#call(() => toTarget(this.#doc.openAction() as TargetEntry));
  }

  destination(target: string | PdfDestination): PdfDestination {
    this.#check(null);
    if (typeof target === "string") {
      return this.#call(() => toDestination(this.#doc.destination(target) as DestinationEntry));
    }
    if (typeof target !== "object" || target === null || !Number.isInteger(target.page)) {
      throw new TypeError("destination takes a name or a PdfDestination");
    }
    const n = (v: number | null | undefined) => (typeof v === "number" ? v : Number.NaN);
    const { page, view, left, bottom, right, top, zoom, name } = target;
    return this.#call(() =>
      toDestination(
        this.#doc.placeDestination(page, view ?? undefined, n(left), n(bottom), n(right), n(top), n(zoom), name ?? undefined) as DestinationEntry
      )
    );
  }

  annotations(index: number): PdfAnnotation[] {
    this.#check(index);
    return this.#call(() => toAnnotations(this.#doc.annotations(index)));
  }

  links(index: number): PdfLink[] {
    this.#check(index);
    // A viewer's call: its code is in drawing's part, so text alone downloads none of it.
    this.#needsRender();
    return this.#call(() => (this.#doc.links(index) as LinkEntry[]).map(toLink));
  }

  scan(index: number) {
    this.#check(index);
    this.#needsRender();
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

  render(index: number, options: PdfRenderOptions & { region: PdfBox }): PdfRegionBitmap;
  render(index: number, options: PdfRenderOptions): PdfBitmap;
  render(index: number, options: PdfRenderOptions): PdfBitmap {
    this.#check(index);
    const args = renderArgs(options);
    this.#needsRender();
    return this.#call(() => consume(this.#doc.render(index, ...args), (page) => bitmapOf(page, options.region !== undefined)));
  }

  renderAsync(index: number, options: PdfRenderAsyncOptions & { region: PdfBox }): Promise<PdfRegionBitmap>;
  renderAsync(index: number, options: PdfRenderAsyncOptions): Promise<PdfBitmap>;
  async renderAsync(index: number, options: PdfRenderAsyncOptions): Promise<PdfBitmap> {
    this.#check(index);
    const args = renderArgs(options);
    this.#needsRender();
    const instance = this.#instance;
    const sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
    const task = this.#call(() => this.#doc.renderTask(index, ...args));
    const stopIfAsked = () => {
      if (options.signal?.aborted) {
        throw new PdfError("aborted", "the signal was aborted", options.signal.reason);
      }
      if (this.#closed) {
        throw new PdfError("closed", "this document is closed");
      }
      if (instance.dead) {
        throw new PdfError("crash", "the engine crashed while this render was paused; open the document again");
      }
      if (instance.abandoned) {
        throw instance.failure ?? new PdfError("missing-asset", "a file the engine needed failed to load while this render was paused; render again");
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
      return this.#call(() => consume(task.finish(), (page) => bitmapOf(page, options.region !== undefined)));
    } finally {
      if (!instance.dead && !instance.abandoned) {
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
    if (!this.#instance.dead && !this.#instance.abandoned) {
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
