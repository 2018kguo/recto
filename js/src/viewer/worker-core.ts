// What a viewer's worker does with each message: open documents, answer page sizes, text runs,
// links, search hits and bitmaps, stop renders. Free of the worker global, so a test can drive it
// with the real engine in Node.

// Only the package's public API: the viewer is a client of the engine like any other.
import {
  BREAK_LINE,
  BREAK_NONE,
  createPdfEngine,
  NOT_TEXT,
  type PdfBitmap,
  type PdfBox,
  type PdfDocument,
  type PdfEngine,
  PdfError,
  type PdfFont,
  type PdfOutlineItem,
  type PdfPageInfo,
  type PdfPageText,
  type PdfRangedDocument,
  readingOrder,
  startRangedRead,
  textItems,
  visibleCodepoint,
} from "../index.ts";
import type {
  ViewerFindHit,
  ViewerLink,
  ViewerOpenTiming,
  ViewerOutlineItem,
  ViewerPageInfo,
  ViewerRequest,
  ViewerResponse,
  ViewerResult,
  ViewerTextRun,
} from "./protocol.ts";

/**
 * Files up to this size are downloaded whole; larger ones are only ever read by range. Either way a
 * file is opened by range, its head and tail asked for while the engine itself downloads, so the first
 * page needs only its own objects: the rest of a file this size follows in the background once
 * the first page is drawn (bench/compare: on a 4.6 MB file, the first page at Slow 4G in a third of the
 * time a whole read took, and no later on an unthrottled link).
 */
export const WHOLE_FILE_MAX_BYTES = 8 * 1024 * 1024;
/** A viewed file has no cap of its own; the engine's ranged default is 64 MiB. */
const RANGED_MAX_BYTES = 1024 * 1024 * 1024;
const RANGED_TIMEOUT_MS = 30_000;
/** A page's link overlays past this many are dropped: an index still gets its links, a pathological file not a DOM blowup. */
export const MAX_LINKS_PER_PAGE = 500;

/** A failure only the viewer's own worker reports. */
class ViewerWorkerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// PDF font descriptor flags.
const FONT_FIXED_PITCH = 1;
const FONT_SERIF = 2;

/**
 * A page's text as the runs the text layer draws, in reading order, each with the generic family its
 * font flags ask for. Measured in the wrong family (Courier as sans-serif), a run stretched to its
 * width slides its words over its dots.
 */
export function textRuns(text: PdfPageText, info: PdfPageInfo): ViewerTextRun[] {
  const items = textItems(text, info);
  items.sort((a, b) => (a.flow?.index ?? 0) - (b.flow?.index ?? 0));
  const familyAt = (char: number): ViewerTextRun["family"] => {
    for (let at = char; at < text.count && at < char + 8; at++) {
      const font = text.fonts[text.fontIds[at] ?? -1];
      if (font) {
        if (font.flags & FONT_FIXED_PITCH) {
          return "monospace";
        }
        return font.flags & FONT_SERIF ? "serif" : "sans-serif";
      }
    }
    return "sans-serif";
  };
  return items.map((item) => ({
    breakBefore: item.flow?.breakBefore ?? "none",
    direction: item.direction ?? 0,
    family: familyAt(item.flow?.index ?? 0),
    height: item.height,
    str: item.str,
    width: item.width,
    x: item.x,
    y: item.y,
  }));
}

/**
 * The page's links a viewer can follow: URIs, and destinations on a page of this file. Other files,
 * launches and scripts are left out. Only this page is read: a target page is sized when the link is
 * followed, not here, where a ranged file would block on reading every target first.
 */
export function followableLinks(doc: Pick<PdfDocument, "links" | "pageCount">, index: number): ViewerLink[] {
  const links: ViewerLink[] = [];
  for (const { box, target } of doc.links(index)) {
    if (links.length >= MAX_LINKS_PER_PAGE) {
      break;
    }
    if (target.kind === "uri") {
      links.push({ box, target: { kind: "uri", uri: target.uri } });
      continue;
    }
    if (target.kind !== "page" || target.destination.page < 0 || target.destination.page >= doc.pageCount) {
      continue;
    }
    const { box: fit, page, x, y } = target.destination;
    links.push({ box, target: { kind: "page", page: page + 1, x: x ?? fit?.x ?? null, y: y ?? fit?.y ?? null } });
  }
  return links;
}

/** What the text layer draws for a page. Links are extra: a page whose links can't be read still gets its text. */
export function pageText(
  doc: Pick<PdfDocument, "links" | "pageCount" | "pageInfo" | "text">,
  index: number,
  text: PdfPageText = doc.text(index)
): ViewerResult["text"] {
  const runs = textRuns(text, doc.pageInfo(index));
  let links: ViewerLink[] = [];
  try {
    links = followableLinks(doc, index);
  } catch {
    // Text without overlays beats no text layer at all.
  }
  return { runs, links };
}

type StandardFontFile = Parameters<PdfEngine["preload"]>[0][number];

const FONT_ITALIC = 64;
const LITERAL_FONTS: Record<string, StandardFontFile> = {
  Courier: "FoxitFixed.pfb",
  "Courier-Bold": "FoxitFixedBold.pfb",
  "Courier-BoldOblique": "FoxitFixedBoldItalic.pfb",
  "Courier-Oblique": "FoxitFixedItalic.pfb",
  Helvetica: "FoxitSans.pfb",
  "Helvetica-Bold": "FoxitSansBold.pfb",
  "Helvetica-BoldOblique": "FoxitSansBoldItalic.pfb",
  "Helvetica-Oblique": "FoxitSansItalic.pfb",
  Symbol: "FoxitSymbol.pfb",
  "Times-Bold": "FoxitSerifBold.pfb",
  "Times-BoldItalic": "FoxitSerifBoldItalic.pfb",
  "Times-Italic": "FoxitSerifItalic.pfb",
  "Times-Roman": "FoxitSerif.pfb",
  ZapfDingbats: "FoxitDingbats.pfb",
};

/**
 * The standard font files the engine will ask for to draw `fonts`, the ones a page names but does
 * not embed: its own choice (the name, then keywords in it, then the descriptor's flags), mirrored
 * here so they can be fetched together before the page is drawn rather than one round trip each while
 * it is. A wrong guess costs one small fetch; a missed one, the round trip it always cost.
 */
export function standardFontFiles(fonts: readonly Pick<PdfFont, "name" | "flags" | "weight" | "embedded">[]): StandardFontFile[] {
  const files = new Set<StandardFontFile>();
  for (const font of fonts) {
    if (font.embedded) {
      continue;
    }
    const name = font.name.replace(/^[A-Z]{6}\+/u, "");
    const literal = LITERAL_FONTS[name];
    if (literal) {
      files.add(literal);
      continue;
    }
    const lower = name.toLowerCase();
    if (lower.includes("dingbats")) {
      files.add("FoxitDingbats.pfb");
      continue;
    }
    const bold = font.weight >= 700 || lower.includes("bold") || lower.includes("demi");
    const italic = (font.flags & FONT_ITALIC) !== 0 || lower.includes("italic") || lower.includes("oblique");
    const family = /helvetica|arial|sans/u.test(lower)
      ? "Sans"
      : /courier|mono/u.test(lower)
        ? "Fixed"
        : /times|serif/u.test(lower)
          ? "Serif"
          : font.flags & FONT_FIXED_PITCH
            ? "Fixed"
            : font.flags & FONT_SERIF
              ? "Serif"
              : "Sans";
    files.add(`Foxit${family}${bold ? "Bold" : ""}${italic ? "Italic" : ""}.pfb` as StandardFontFile);
  }
  return [...files];
}

/** A bookmark list too long to be read is cut here; a table of contents is a few hundred at most. */
export const MAX_OUTLINE_ITEMS = 10_000;

/** The document's bookmarks with pages from 1, cut at `MAX_OUTLINE_ITEMS`. */
export function viewerOutline(doc: Pick<PdfDocument, "outline" | "pageCount">): ViewerOutlineItem[] {
  let left = MAX_OUTLINE_ITEMS;
  const convert = (items: readonly PdfOutlineItem[]): ViewerOutlineItem[] => {
    const out: ViewerOutlineItem[] = [];
    for (const item of items) {
      if (left-- <= 0) {
        break;
      }
      const page = item.page >= 0 && item.page < doc.pageCount ? item.page + 1 : null;
      out.push({ children: convert(item.children), page, title: item.title.trim() || "Untitled", url: item.url });
    }
    return out;
  };
  return convert(doc.outline());
}

const HYPHEN_MARK = 0x02;

/**
 * A page's text as one searchable string in reading order, and the char each UTF-16 unit of it came
 * from. Word and line breaks are one space each; a line-end hyphenation joins its word ("anti-" and
 * "body" read "antibody"), as a reader would search for it.
 */
export type SearchText = { text: string; chars: Int32Array; exact?: NormalizedText; folded?: NormalizedText };

export function searchText(page: Pick<PdfPageText, "count" | "codepoints" | "flags" | "boxes" | "angles">, info: PdfPageInfo): SearchText {
  const plan = readingOrder(page, info);
  let text = "";
  const chars: number[] = [];
  let previous = 0;
  let joinNext = false;
  for (let k = 0; k < plan.length; k++) {
    const char = plan.order[k] ?? 0;
    const raw = page.codepoints[char] ?? 0;
    const breakBefore = plan.breaks[k] ?? BREAK_NONE;
    if (breakBefore !== BREAK_NONE && text.length > 0 && !(joinNext && breakBefore === BREAK_LINE) && !text.endsWith(" ")) {
      text += " ";
      chars.push(char);
    }
    joinNext = false;
    if (raw === HYPHEN_MARK) {
      // The page shows a hyphen that only breaks the word across lines.
      joinNext = true;
      previous = raw;
      continue;
    }
    const code = visibleCodepoint(raw, previous);
    previous = raw;
    if (code === NOT_TEXT) {
      continue;
    }
    const unit = code <= 0x20 || code === 0xa0 ? " " : String.fromCodePoint(code);
    if (unit === " " && text.endsWith(" ")) {
      continue;
    }
    text += unit;
    for (let i = 0; i < unit.length; i++) {
      chars.push(char);
    }
  }
  return { text, chars: Int32Array.from(chars) };
}

/**
 * Text as search compares it, and where each of its units came from. Each cluster (a code point and
 * the combining marks after it) is put in NFKC, so a ligature reads as its letters, a full-width
 * letter as its plain one, and an accent written as a separate mark as the accented letter; then its
 * case is folded ("ß" reads "ss", "Σ" and "ς" read "σ"). Characters that show nothing (a soft hyphen,
 * zero-width spaces and joiners) are dropped.
 *
 * `from[k]` and `to[k]` are the source units the k-th unit came from; `part[k]` and `parts[k]` say
 * which of the units a cluster became it is, so a hit on part of a ligature covers part of its box.
 */
export type NormalizedText = { text: string; from: Int32Array; to: Int32Array; part: Uint8Array; parts: Uint8Array };

const INVISIBLE = /^[­​-‍⁠﻿]+$/u;
const CLUSTER = /\P{M}\p{M}*|\p{M}+/gu;

function foldCluster(cluster: string, caseSensitive: boolean): string {
  const composed = cluster.normalize("NFKC");
  // Upper then lower is the full case fold JavaScript has: "ß" → "SS" → "ss", "ς" → "Σ" → "σ".
  return caseSensitive ? composed : composed.toUpperCase().toLowerCase().normalize("NFKC");
}

export function normalizeForSearch(source: string, caseSensitive: boolean): NormalizedText {
  let text = "";
  const from: number[] = [];
  const to: number[] = [];
  const part: number[] = [];
  const parts: number[] = [];
  for (const match of source.matchAll(CLUSTER)) {
    const cluster = match[0];
    const start = match.index;
    if (INVISIBLE.test(cluster)) {
      continue;
    }
    const folded = foldCluster(cluster, caseSensitive);
    // Plain ASCII, the usual case, folds to itself one to one.
    const count = Math.min(255, folded.length);
    for (let k = 0; k < folded.length; k++) {
      from.push(start);
      to.push(start + cluster.length);
      part.push(Math.min(k, count - 1));
      parts.push(count);
    }
    text += folded;
  }
  return { from: Int32Array.from(from), part: Uint8Array.from(part), parts: Uint8Array.from(parts), text, to: Int32Array.from(to) };
}

/** A query as `normalizeForSearch` compares it: trimmed, runs of whitespace one space. */
function normalizeQuery(query: string, caseSensitive: boolean): string {
  return normalizeForSearch(query.trim().replace(/\s+/gu, " "), caseSensitive).text.replace(/\s+/gu, " ").trim();
}

/** A char, and the share of its box a hit covers (0..1 from its left), for a hit on part of a ligature. */
export type CharSpan = { char: number; start: number; end: number };

/** The boxes chars cover, one per line: consecutive chars that sit on one baseline merge. */
export function charRangeBoxes(boxes: Float32Array, chars: readonly (number | CharSpan)[]): PdfBox[] {
  const out: PdfBox[] = [];
  let line: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (const entry of chars) {
    const span = typeof entry === "number" ? { char: entry, end: 1, start: 0 } : entry;
    const { char } = span;
    const fullWidth = boxes[4 * char + 2] ?? 0;
    const x = (boxes[4 * char] ?? 0) + fullWidth * span.start;
    const y = boxes[4 * char + 1] ?? 0;
    const width = fullWidth * (span.end - span.start);
    const height = boxes[4 * char + 3] ?? 0;
    if (!(width > 0 && height > 0)) {
      continue;
    }
    if (line) {
      const lineHeight = line.y1 - line.y0;
      const sameLine = Math.abs(y + height / 2 - (line.y0 + line.y1) / 2) < Math.max(lineHeight, height) / 2;
      if (sameLine) {
        line.x0 = Math.min(line.x0, x);
        line.y0 = Math.min(line.y0, y);
        line.x1 = Math.max(line.x1, x + width);
        line.y1 = Math.max(line.y1, y + height);
        continue;
      }
      out.push({ x: line.x0, y: line.y0, width: line.x1 - line.x0, height: line.y1 - line.y0 });
    }
    line = { x0: x, y0: y, x1: x + width, y1: y + height };
  }
  if (line) {
    out.push({ x: line.x0, y: line.y0, width: line.x1 - line.x0, height: line.y1 - line.y0 });
  }
  return out;
}

/**
 * Every hit of `query` on a page, whitespace in it matching any break, compared as
 * `normalizeForSearch` puts both. `index` is where the hit starts in `search.text`.
 */
export function findInText(
  search: SearchText,
  boxes: Float32Array,
  query: string,
  caseSensitive: boolean,
  normalized: NormalizedText = normalizeForSearch(search.text, caseSensitive)
): ViewerFindHit[] {
  const wanted = normalizeQuery(query, caseSensitive);
  if (!wanted) {
    return [];
  }
  const haystack = normalized.text;
  const hits: ViewerFindHit[] = [];
  for (let at = haystack.indexOf(wanted); at >= 0; at = haystack.indexOf(wanted, at + wanted.length)) {
    const spans: CharSpan[] = [];
    let k = at;
    const end = at + wanted.length;
    while (k < end) {
      // One cluster at a time: the units of the hit inside it, out of the units it became.
      const first = normalized.from[k] ?? 0;
      const count = normalized.parts[k] ?? 1;
      const startPart = normalized.part[k] ?? 0;
      let last = k;
      while (last + 1 < end && normalized.from[last + 1] === first) {
        last += 1;
      }
      const chars: number[] = [];
      for (let unit = first; unit < (normalized.to[k] ?? first); unit++) {
        const char = search.chars[unit] ?? -1;
        if (char >= 0 && search.text[unit] !== " " && !chars.includes(char)) {
          chars.push(char);
        }
      }
      const whole = count <= 1 || (startPart === 0 && (normalized.part[last] ?? 0) === count - 1);
      for (const char of chars) {
        if (spans.at(-1)?.char === char) {
          continue;
        }
        // A cluster from one char (a ligature) is cut to the share the hit covers; one from several
        // chars (a letter and its mark) is had whole.
        spans.push(whole || chars.length > 1 ? { char, end: 1, start: 0 } : { char, end: ((normalized.part[last] ?? 0) + 1) / count, start: startPart / count });
      }
      k = last + 1;
    }
    hits.push({ index: normalized.from[at] ?? at, boxes: charRangeBoxes(boxes, spans) });
  }
  return hits;
}

/** Reads a response's body, at most `limit` bytes: null past it, the body cancelled. */
async function readCapped(response: Response, limit: number, alive: () => void = () => {}): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    return whole.byteLength > limit ? null : whole;
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    alive();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      // A gzip body's compressed length hides how far it decodes.
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
}

export type WorkerHandler = (request: ViewerRequest) => Promise<void>;

/**
 * The rest of a file opened by range that is downloaded whole: started once its first page is drawn,
 * so it doesn't share the link with that page's reads, or by the first call that reads every page.
 */
type Rest = { start(): void; done(): Promise<void>; stop(): void };

function restOf(doc: PdfRangedDocument, stallMs: number): Rest {
  const controller = new AbortController();
  let running: Promise<void> | null = null;
  return {
    start() {
      running ??= doc.fetchRest({ signal: controller.signal, stallMs }).catch(() => {
        // Reads fetch what they need by range, as they would have anyway.
      });
    },
    done() {
      this.start();
      return running!;
    },
    stop() {
      controller.abort();
    },
  };
}

type OpenDoc = {
  doc: PdfDocument;
  search: Map<number, SearchText>;
  rest: Rest | null;
  /** The standard fonts the first page drawn names, fetched ahead of its render; every render waits for them. */
  fonts: Promise<void> | null;
  /** A page's text read for that, kept for the text layer's request that follows. */
  text: { index: number; value: PdfPageText } | null;
};

export function createWorkerHandler(options: {
  reply: (response: ViewerResponse, transfer: Transferable[]) => void;
  fetch?: typeof fetch;
  /** Overrides each open's `wholeFileMaxBytes`; for tests. */
  wholeFileMaxBytes?: number;
  /** How long a read may wait on the server. Default 30 s. */
  timeoutMs?: number;
}): WorkerHandler {
  const { reply } = options;
  const timeoutMs = options.timeoutMs ?? RANGED_TIMEOUT_MS;
  const fetchFile = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let enginePromise: Promise<PdfEngine> | null = null;
  const documents = new Map<number, Promise<OpenDoc>>();
  const renders = new Map<number, AbortController>();
  // Renders cancelled before they started (their document was still opening).
  const cancelledBeforeStart = new Set<number>();

  const engine = (assetBase: string | undefined): Promise<PdfEngine> => {
    enginePromise ??= createPdfEngine({
      ...(assetBase === undefined ? {} : { assetBase }),
      // A viewer always draws: fetch the render part with the engine instead of on the first page.
      preloadAssets: ["recto-render.wasm"],
    }).catch((cause: unknown) => {
      enginePromise = null;
      throw cause;
    });
    return enginePromise;
  };

  const httpFailure = async (response: Response) => {
    await response.body?.cancel().catch(() => {});
    return new PdfError("fetch-failed", `the PDF could not be read (HTTP ${response.status})`, undefined, response.status);
  };

  // fetch and body reads reject with a bare TypeError on a dropped connection: a failed read.
  const network = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (cause) {
      throw cause instanceof TypeError ? new PdfError("fetch-failed", `the PDF could not be read: ${cause.message}`, cause) : cause;
    }
  };

  const openDocument = async (
    request: Extract<ViewerRequest, { op: "open" }>
  ): Promise<{ doc: PdfDocument; ranged: boolean; rest: Rest | null; timing: ViewerOpenTiming }> => {
    const { source, wholeOnly = false } = request;
    const wholeFileMaxBytes = options.wholeFileMaxBytes ?? request.wholeFileMaxBytes ?? WHOLE_FILE_MAX_BYTES;
    let mark = performance.now();
    const lap = () => {
      const at = performance.now();
      const ms = Math.round(at - mark);
      mark = at;
      return ms;
    };
    // By range from the start, the file's first round under way while the engine downloads. Not on a
    // shared worker, whose other documents a blocking read would stall, nor with cross-origin credentials,
    // which a ranged read doesn't send.
    if (source.kind === "url" && !wholeOnly && source.credentials !== "include" && /^https?:/iu.test(source.url)) {
      const read = startRangedRead(source.url, { maxBytes: RANGED_MAX_BYTES, timeoutMs });
      const pdf = await engine(request.assetBase);
      const engineMs = lap();
      try {
        const doc = await pdf.openRanged(read);
        const { fileBytes } = doc.stats();
        // A file this size is downloaded whole after its first page; past it, only what's read is.
        const whole = fileBytes <= wholeFileMaxBytes;
        // The reads before the parse overlapped the engine's download: what's left is all parse.
        const timing = { bytes: whole ? fileBytes : 0, engineMs, fetchMs: 0, parseMs: lap() };
        return { doc, ranged: !whole, rest: whole ? restOf(doc, timeoutMs) : null, timing };
      } catch (cause) {
        // A server that answers but not by range (a cross-origin one that hides Content-Range, say)
        // still serves the file whole: read it as before. An HTTP error would be the same either way.
        if (!(cause instanceof PdfError && cause.code === "fetch-failed" && !(cause.status && cause.status >= 400))) {
          throw cause;
        }
        lap();
      }
    }
    const pdf = await engine(request.assetBase);
    const engineMs = lap();
    const parse = async (bytes: Uint8Array | ArrayBuffer, fetchMs: number) => {
      const doc = await pdf.open(bytes);
      return { doc, ranged: false, rest: null, timing: { bytes: bytes.byteLength, engineMs, fetchMs, parseMs: lap() } };
    };
    if (source.kind === "bytes") {
      return parse(source.bytes, 0);
    }
    // A server that takes the request and never answers, or stops sending, fails the open as `timeout`
    // (which a later call retries) rather than leaving it pending for ever.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), timeoutMs);
    };
    const timed = async <T>(work: () => Promise<T>): Promise<T> => {
      alive();
      try {
        return await network(work);
      } catch (cause) {
        throw controller.signal.aborted ? new PdfError("timeout", `the PDF server sent nothing for ${timeoutMs} ms`, cause) : cause;
      } finally {
        clearTimeout(timer);
      }
    };
    const init: RequestInit = { ...(source.credentials ? { credentials: source.credentials } : {}), signal: controller.signal };
    // data: and blob: URLs are already in memory: read them whole.
    if (!/^https?:/iu.test(source.url)) {
      const bytes = await timed(async () => {
        const response = await fetchFile(source.url, init);
        if (!response.ok) {
          throw await httpFailure(response);
        }
        return new Uint8Array(await response.arrayBuffer());
      });
      return parse(bytes, lap());
    }
    // One request. A body within the cap is the file; past it (declared, or decoded past it), the
    // file is read by range.
    const response = await timed(() => fetchFile(source.url, init));
    if (!response.ok) {
      throw await httpFailure(response);
    }
    const whole = await timed(() => readCapped(response, wholeFileMaxBytes, alive));
    if (whole) {
      return parse(whole, lap());
    }
    // Not a byte more of the whole file than it took to learn it's too large.
    controller.abort();
    if (wholeOnly) {
      throw new ViewerWorkerError("needs-own-worker", "the PDF is read by range and needs a worker of its own");
    }
    const fetchMs = lap();
    const doc = await pdf.openRanged(source.url, { maxBytes: RANGED_MAX_BYTES, timeoutMs });
    // A ranged open's reads and parse are interleaved: all of it is parse.
    return { doc, ranged: true, rest: null, timing: { bytes: 0, engineMs, fetchMs, parseMs: lap() } };
  };

  const pageInfo = (doc: PdfDocument, page: number): ViewerPageInfo => {
    const { height, rotation, width } = doc.pageInfo(page - 1);
    return { height, rotation, width };
  };

  const fail = (id: number, cause: unknown) => {
    const code =
      typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" ? cause.code : "failed";
    const message = cause instanceof Error ? cause.message : String(cause);
    reply({ error: { code, message }, id, ok: false }, []);
  };

  const open = async (request: Extract<ViewerRequest, { op: "open" }>) => {
    const opened = openDocument(request);
    const opening = opened.then(({ doc, rest }): OpenDoc => ({ doc, fonts: null, rest, search: new Map<number, SearchText>(), text: null }));
    // Callers on this document see the failure through their own await.
    opening.catch(() => {});
    documents.set(request.docId, opening);
    try {
      const { doc, ranged, timing } = await opened;
      reply({ id: request.id, ok: true, value: { firstPage: pageInfo(doc, 1), pageCount: doc.pageCount, ranged, timing } }, []);
    } catch (cause) {
      documents.delete(request.docId);
      fail(request.id, cause);
    }
  };

  /**
   * Before a document's first render: the standard fonts its page names, fetched together. The engine
   * would otherwise ask for each while drawing, a blocking round trip apiece.
   */
  const fetchFonts = (opened: OpenDoc, index: number): Promise<void> =>
    (opened.fonts ??= (async () => {
      try {
        const text = opened.doc.text(index);
        opened.text = { index, value: text };
        const files = standardFontFiles(text.fonts);
        if (files.length > 0) {
          await (await enginePromise!).preload(files);
        }
      } catch {
        // The render reads what it needs itself, and reports what fails.
      }
    })());

  const render = async (opened: OpenDoc, request: Extract<ViewerRequest, { op: "render" }>) => {
    const { doc } = opened;
    const controller = new AbortController();
    if (cancelledBeforeStart.delete(request.id)) {
      controller.abort();
    }
    renders.set(request.id, controller);
    try {
      const size = { maxHeight: Number.POSITIVE_INFINITY, signal: controller.signal, width: request.width };
      const index = request.page - 1;
      await fetchFonts(opened, index);
      let bitmap: PdfBitmap;
      let placed: ViewerResult["render"]["region"];
      if (request.region) {
        const { pageHeight, pageWidth, x, y, ...cut } = await doc.renderAsync(index, { ...size, region: request.region });
        bitmap = cut;
        placed = { pageHeight, pageWidth, x, y };
      } else {
        bitmap = await doc.renderAsync(index, size);
      }
      const rgba = new Uint8ClampedArray(bitmap.rgba.buffer, bitmap.rgba.byteOffset, bitmap.rgba.byteLength);
      const value: ViewerResult["render"] = { height: bitmap.height, rgba, width: bitmap.width, ...(placed && { region: placed }) };
      reply({ id: request.id, ok: true, value }, [rgba.buffer]);
    } finally {
      renders.delete(request.id);
      // The first page is drawn (or failed): the rest of the file may have the link now.
      opened.rest?.start();
    }
  };

  const find = (opened: OpenDoc, request: Extract<ViewerRequest, { op: "find" }>) => {
    const { doc, search } = opened;
    const index = request.page - 1;
    // The page's text is kept as one string per page; its boxes are read again only where it matches.
    let text = search.get(index);
    let page: PdfPageText | null = null;
    if (!text) {
      page = doc.text(index);
      text = searchText(page, doc.pageInfo(index));
      search.set(index, text);
    }
    const wanted = normalizeQuery(request.query, request.caseSensitive);
    const key = request.caseSensitive ? "exact" : "folded";
    const normalized = (text[key] ??= normalizeForSearch(text.text, request.caseSensitive));
    if (!wanted || !normalized.text.includes(wanted)) {
      return [];
    }
    page ??= doc.text(index);
    return findInText(text, page.boxes, request.query, request.caseSensitive, normalized);
  };

  const onDocument = async (request: Extract<ViewerRequest, { op: "pageInfo" | "render" | "text" | "find" | "outline" }>) => {
    const opening = documents.get(request.docId);
    if (!opening) {
      fail(request.id, new PdfError("closed", "the document was closed"));
      return;
    }
    try {
      const opened = await opening;
      const { doc } = opened;
      switch (request.op) {
        case "pageInfo":
          reply({ id: request.id, ok: true, value: pageInfo(doc, request.page) }, []);
          return;
        case "text": {
          const index = request.page - 1;
          const kept = opened.text?.index === index ? opened.text.value : undefined;
          opened.text = null;
          reply({ id: request.id, ok: true, value: pageText(doc, index, kept) }, []);
          return;
        }
        case "find":
          // A search reads every page: one stream of the rest beats a blocking round trip a page.
          await opened.rest?.done();
          reply({ id: request.id, ok: true, value: find(opened, request) }, []);
          return;
        case "outline":
          reply({ id: request.id, ok: true, value: viewerOutline(doc) }, []);
          return;
        case "render":
          await render(opened, request);
          return;
      }
    } catch (cause) {
      fail(request.id, cause);
    }
  };

  return async (request) => {
    switch (request.op) {
      case "open":
        return open(request);
      case "pageInfo":
      case "render":
      case "text":
      case "find":
      case "outline":
        return onDocument(request);
      case "cancel": {
        const running = renders.get(request.id);
        if (running) {
          running.abort();
        } else {
          cancelledBeforeStart.add(request.id);
        }
        return;
      }
      case "close": {
        const opening = documents.get(request.docId);
        documents.delete(request.docId);
        opening
          ?.then(({ doc, rest }) => {
            rest?.stop();
            doc.close();
          })
          .catch(() => {});
        return;
      }
    }
  };
}
