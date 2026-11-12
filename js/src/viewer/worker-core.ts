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
  type PdfPageInfo,
  type PdfPageText,
  readingOrder,
  textItems,
  visibleCodepoint,
} from "../index.ts";
import type {
  ViewerFindHit,
  ViewerLink,
  ViewerOpenTiming,
  ViewerPageInfo,
  ViewerRequest,
  ViewerResponse,
  ViewerResult,
  ViewerTextRun,
} from "./protocol.ts";

/**
 * Files up to this size are read in one request; larger ones by range. A ranged open needs several
 * dependent requests before the first page, so one request wins until the transfer itself costs more
 * than those round trips: 8 MiB is about 0.7 to 1.3 s at 50 to 100 Mbit/s, the cost of three to five
 * ranged rounds on a slow server.
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
export function pageText(doc: Pick<PdfDocument, "links" | "pageCount" | "pageInfo" | "text">, index: number): ViewerResult["text"] {
  const runs = textRuns(doc.text(index), doc.pageInfo(index));
  let links: ViewerLink[] = [];
  try {
    links = followableLinks(doc, index);
  } catch {
    // Text without overlays beats no text layer at all.
  }
  return { runs, links };
}

const HYPHEN_MARK = 0x02;

/**
 * A page's text as one searchable string in reading order, and the char each UTF-16 unit of it came
 * from. Word and line breaks are one space each; a line-end hyphenation joins its word ("anti-" and
 * "body" read "antibody"), as a reader would search for it.
 */
export type SearchText = { text: string; chars: Int32Array };

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

/** Folds case (and nothing else) unit by unit, so offsets in the folded string are offsets in the original. */
function foldCase(text: string): string {
  let out = "";
  for (const unit of text) {
    const lower = unit.toLowerCase();
    // A fold that changes length ("İ" to "i̇") would shift every later offset: keep the original.
    out += lower.length === unit.length ? lower : unit;
  }
  return out;
}

/** The boxes chars `first..last` cover, one per line: consecutive chars that sit on one baseline merge. */
export function charRangeBoxes(boxes: Float32Array, chars: readonly number[]): PdfBox[] {
  const out: PdfBox[] = [];
  let line: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (const char of chars) {
    const x = boxes[4 * char] ?? 0;
    const y = boxes[4 * char + 1] ?? 0;
    const width = boxes[4 * char + 2] ?? 0;
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

/** Every hit of `query` on a page, whitespace in it matching any break. */
export function findInText(search: SearchText, boxes: Float32Array, query: string, caseSensitive: boolean): ViewerFindHit[] {
  const needle = query.trim().replace(/\s+/gu, " ");
  if (!needle) {
    return [];
  }
  const haystack = caseSensitive ? search.text : foldCase(search.text);
  const wanted = caseSensitive ? needle : foldCase(needle);
  const hits: ViewerFindHit[] = [];
  for (let at = haystack.indexOf(wanted); at >= 0; at = haystack.indexOf(wanted, at + wanted.length)) {
    const chars: number[] = [];
    for (let unit = at; unit < at + wanted.length; unit++) {
      const char = search.chars[unit] ?? -1;
      if (char >= 0 && chars.at(-1) !== char && haystack[unit] !== " ") {
        chars.push(char);
      }
    }
    hits.push({ index: at, boxes: charRangeBoxes(boxes, chars) });
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
  const documents = new Map<number, Promise<{ doc: PdfDocument; search: Map<number, SearchText> }>>();
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
  ): Promise<{ doc: PdfDocument; ranged: boolean; timing: ViewerOpenTiming }> => {
    const { source, wholeOnly = false } = request;
    const wholeFileMaxBytes = options.wholeFileMaxBytes ?? request.wholeFileMaxBytes ?? WHOLE_FILE_MAX_BYTES;
    let mark = performance.now();
    const lap = () => {
      const at = performance.now();
      const ms = Math.round(at - mark);
      mark = at;
      return ms;
    };
    const pdf = await engine(request.assetBase);
    const engineMs = lap();
    const parse = async (bytes: Uint8Array | ArrayBuffer, fetchMs: number) => {
      const doc = await pdf.open(bytes);
      return { doc, ranged: false, timing: { bytes: bytes.byteLength, engineMs, fetchMs, parseMs: lap() } };
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
    if (wholeOnly) {
      throw new ViewerWorkerError("needs-own-worker", "the PDF is read by range and needs a worker of its own");
    }
    const fetchMs = lap();
    const doc = await pdf.openRanged(source.url, { maxBytes: RANGED_MAX_BYTES, timeoutMs });
    // A ranged open's reads and parse are interleaved: all of it is parse.
    return { doc, ranged: true, timing: { bytes: 0, engineMs, fetchMs, parseMs: lap() } };
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
    const opening = opened.then(({ doc }) => ({ doc, search: new Map<number, SearchText>() }));
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

  const render = async (doc: PdfDocument, request: Extract<ViewerRequest, { op: "render" }>) => {
    const controller = new AbortController();
    if (cancelledBeforeStart.delete(request.id)) {
      controller.abort();
    }
    renders.set(request.id, controller);
    try {
      const size = { maxHeight: Number.POSITIVE_INFINITY, signal: controller.signal, width: request.width };
      const index = request.page - 1;
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
    }
  };

  const find = (opened: { doc: PdfDocument; search: Map<number, SearchText> }, request: Extract<ViewerRequest, { op: "find" }>) => {
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
    const needle = request.query.trim().replace(/\s+/gu, " ");
    const folded = request.caseSensitive ? needle : foldCase(needle);
    if (!needle || !(request.caseSensitive ? text.text : foldCase(text.text)).includes(folded)) {
      return [];
    }
    page ??= doc.text(index);
    return findInText(text, page.boxes, request.query, request.caseSensitive);
  };

  const onDocument = async (request: Extract<ViewerRequest, { op: "pageInfo" | "render" | "text" | "find" }>) => {
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
        case "text":
          reply({ id: request.id, ok: true, value: pageText(doc, request.page - 1) }, []);
          return;
        case "find":
          reply({ id: request.id, ok: true, value: find(opened, request) }, []);
          return;
        case "render":
          await render(doc, request);
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
        opening?.then(({ doc }) => doc.close()).catch(() => {});
        return;
      }
    }
  };
}
