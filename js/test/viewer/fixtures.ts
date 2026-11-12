// PDFs and stand-ins for the viewer's tests: text a test can search for on every page, links of each
// kind, and a worker that runs the real worker core and engine in this thread.

import { createWorkerHandler } from "../../src/viewer/worker-core.ts";
import type { WorkerPort } from "../../src/viewer/client.ts";
import type { ViewerRequest } from "../../src/viewer/protocol.ts";

const encoder = new TextEncoder();

/** xorshift32 bytes: filler that doesn't compress, so a file is as large as asked. */
function filler(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let s = seed || 1;
  for (let i = 0; i < length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 0xff;
  }
  return out;
}

export type TextPdfOptions = {
  pages: number;
  /** Lines "Page n line i" on each page. Default 3. */
  lines?: number;
  /** Incompressible bytes after each page, to make a file that is read by range. */
  padBytes?: number;
  /** Page 1 gets links: a web page, a script, a mail address, and page 2 at a point. */
  links?: boolean;
  /** Extra lines for page 1, drawn after the others. */
  extra?: string[];
  /** Width and height of every page but the last; the last can differ. */
  size?: [number, number];
  lastSize?: [number, number];
};

/** "Page n line i" on every page, in Helvetica, 14 pt apart from the top. */
export function textPdf(options: TextPdfOptions): Uint8Array {
  const { pages, lines = 3, padBytes = 0, links = false, extra = [], size = [612, 792], lastSize = size } = options;
  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    parts.push(bytes);
    length += bytes.byteLength;
  };
  const offsets: number[] = [];
  const object = (id: number, body: string) => {
    offsets[id] = length;
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };
  const stream = (id: number, data: Uint8Array) => {
    offsets[id] = length;
    push(`${id} 0 obj\n<< /Length ${data.byteLength} >>\nstream\n`);
    push(data);
    push("\nendstream\nendobj\n");
  };
  push("%PDF-1.7\n");
  // 1 catalog, 2 pages, 3 font, then per page: page, content, filler; then the link annotations.
  const pageId = (page: number) => 4 + 3 * (page - 1);
  const annots = 4 + 3 * pages;
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${pageId(i + 1)} 0 R`).join(" ")}] /Count ${pages} >>`);
  object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let page = 1; page <= pages; page++) {
    const [width, height] = page === pages ? lastSize : size;
    const id = pageId(page);
    const annotations = links && page === 1 ? ` /Annots [${annots} 0 R ${annots + 1} 0 R ${annots + 2} 0 R ${annots + 3} 0 R]` : "";
    object(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R${annotations} >>`
    );
    const shown = [...Array.from({ length: lines }, (_, i) => `Page ${page} line ${i}`), ...(page === 1 ? extra : [])];
    const ops = shown.map((line, i) => `${i === 0 ? `72 ${height - 72} Td` : "0 -14 Td"} (${line}) Tj`).join("\n");
    stream(id + 1, encoder.encode(`BT /F1 12 Tf\n${ops}\nET`));
    stream(id + 2, filler(padBytes, page));
  }
  if (links) {
    object(annots, "<< /Type /Annot /Subtype /Link /Rect [72 600 272 620] /A << /S /URI /URI (https://example.com/a?b=1) >> >>");
    object(annots + 1, "<< /Type /Annot /Subtype /Link /Rect [72 560 272 580] /A << /S /URI /URI (javascript:alert\\(1\\)) >> >>");
    object(annots + 2, "<< /Type /Annot /Subtype /Link /Rect [72 520 272 540] /A << /S /URI /URI (mailto:someone@example.com) >> >>");
    object(annots + 3, `<< /Type /Annot /Subtype /Link /Rect [72 480 272 500] /Dest [${pageId(Math.min(2, pages))} 0 R /XYZ 36 400 null] >>`);
  }
  const count = links ? annots + 4 : annots;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) {
    push(`${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

export type TestPort = WorkerPort & { die(): void; hang: boolean; opens: number; terminated: boolean; sent: ViewerRequest[] };

/**
 * Workers in this thread: the real worker core and engine behind the port the client talks to.
 * Messages are handled on a later turn, as a real worker's are. `hang` swallows renders; `die` fires
 * the error a crashed worker fires.
 */
export function inProcessWorkers(options: { wholeFileMaxBytes?: number } = {}) {
  const ports: TestPort[] = [];
  const createWorker = (): WorkerPort => {
    const target = new EventTarget();
    const port: TestPort = {
      addEventListener: (type, listener) => target.addEventListener(type, listener),
      die() {
        target.dispatchEvent(Object.assign(new Event("error", { cancelable: true }), { message: "worker crashed" }));
      },
      hang: false,
      opens: 0,
      sent: [],
      postMessage(message) {
        port.sent.push(message);
        if (message.op === "open") {
          port.opens += 1;
        }
        if (port.terminated || (port.hang && message.op === "render")) {
          return;
        }
        setTimeout(() => {
          handle(message).catch(() => {});
        });
      },
      terminate() {
        port.terminated = true;
      },
      terminated: false,
    };
    const handle = createWorkerHandler({
      ...options,
      reply: (response) => {
        if (!port.terminated) {
          target.dispatchEvent(new MessageEvent("message", { data: response }));
        }
      },
    });
    ports.push(port);
    return port;
  };
  return { createWorker, ports };
}
