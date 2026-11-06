// Deterministic PDFs of any size, written directly (pdf-lib takes minutes
// for the 8k-page, 200 MB shapes the scaling tests need). Test and bench
// input only; nothing in the engine imports it.
//
// Layout, in file order: catalog, page tree, then for each page its page
// dict, its content stream and `padBytes` of incompressible filler (an
// unused stream object), then a classic cross-reference table and trailer.
// The filler spreads page objects across the file, which is what makes a
// ranged reader miss once per page.

export type SyntheticPdfOptions = {
  pages: number;
  /** Characters of Helvetica text on each page (lines of up to 80). */
  charsPerPage?: number;
  /** Filled rectangles (path objects) on each page. */
  pathsPerPage?: number;
  /** Incompressible bytes after each page's objects. */
  padBytes?: number;
  /** Children per page-tree node; 0 keeps one flat /Kids array. */
  fanout?: number;
  /** Pages get /Rotate (index % 4) * 90 and a varying size. */
  vary?: boolean;
};

const encoder = new TextEncoder();

/** xorshift32, so filler is incompressible but identical run to run. */
function filler(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let s = Math.trunc(seed) || 1;
  for (let i = 0; i < length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 0xff;
  }
  return out;
}

const WORDS =
  "the quick brown fox jumps over a lazy dog while seven pale zebras quietly mix fine wax jelly".split(
    " "
  );

/** Deterministic page text: words, lines of at most 80 chars. */
export function syntheticPageText(page: number, chars: number): string[] {
  const lines: string[] = [];
  let line = "";
  let total = 0;
  let w = page;
  while (total < chars) {
    const word = WORDS[w++ % WORDS.length] ?? "x";
    const piece = line === "" ? word : ` ${word}`;
    if (line.length + piece.length > 80) {
      lines.push(line);
      total += line.length;
      line = "";
      continue;
    }
    line += piece;
    if (total + line.length >= chars) {
      break;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}

export function syntheticPdf(options: SyntheticPdfOptions): Uint8Array {
  const {
    pages,
    charsPerPage = 40,
    pathsPerPage = 0,
    padBytes = 0,
    fanout = 0,
    vary = false,
  } = options;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const offsets: number[] = [0];
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    chunks.push(bytes);
    size += bytes.byteLength;
  };
  const object = (id: number, body: string) => {
    offsets[id] = size;
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };
  const stream = (id: number, dict: string, data: Uint8Array) => {
    offsets[id] = size;
    push(`${id} 0 obj\n<< ${dict} /Length ${data.byteLength} >>\nstream\n`);
    push(data);
    push("\nendstream\nendobj\n");
  };

  // Ids: 1 catalog, 2 font, then page tree nodes, then 3 objects per page.
  // The tree is built bottom-up: leaves hold up to `width` pages, each
  // level above holds up to `width` nodes of the one below.
  type Node = { id: number; parent: number; kids: number[]; count: number };
  const width = fanout > 1 ? fanout : Math.max(1, pages);
  let nextId = 3;
  const leaves: Node[] = [];
  for (let i = 0; i === 0 || i < pages; i += width) {
    leaves.push({
      id: nextId++,
      parent: 0,
      kids: [],
      count: Math.min(width, Math.max(0, pages - i)),
    });
  }
  const nodes: Node[] = [...leaves];
  let level = leaves;
  while (level.length > 1) {
    const above: Node[] = [];
    for (let i = 0; i < level.length; i += width) {
      const group = level.slice(i, i + width);
      const node: Node = {
        id: nextId++,
        parent: 0,
        kids: group.map((g) => g.id),
        count: group.reduce((sum, g) => sum + g.count, 0),
      };
      for (const g of group) {
        g.parent = node.id;
      }
      above.push(node);
    }
    nodes.push(...above);
    level = above;
  }
  const root = level[0];
  if (!root) {
    throw new Error("unreachable: no page tree root");
  }
  const pageIds: number[] = [];
  const pageParent: number[] = [];
  for (let i = 0; i < pages; i++) {
    const leaf = leaves[Math.floor(i / width)];
    if (!leaf) {
      throw new Error("unreachable: no leaf for a page");
    }
    pageIds.push(nextId);
    pageParent.push(leaf.id);
    leaf.kids.push(nextId);
    nextId += 3;
  }

  push("%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n");
  object(1, `<< /Type /Catalog /Pages ${root.id} 0 R >>`);
  object(
    2,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
  );
  for (const node of nodes) {
    const parent = node.parent ? ` /Parent ${node.parent} 0 R` : "";
    object(
      node.id,
      `<< /Type /Pages${parent} /Count ${node.count} /Kids [${node.kids.map((k) => `${k} 0 R`).join(" ")}] >>`
    );
  }
  for (let i = 0; i < pages; i++) {
    const id = pageIds[i] ?? 0;
    const w = vary ? 300 + (i % 97) : 612;
    const h = vary ? 500 - (i % 89) : 792;
    const rotate = vary ? ` /Rotate ${(i % 4) * 90}` : "";
    object(
      id,
      `<< /Type /Page /Parent ${pageParent[i]} 0 R /MediaBox [0 0 ${w} ${h}]${rotate} /Resources << /Font << /F1 2 0 R >> >> /Contents ${id + 1} 0 R >>`
    );
    let content = "";
    for (let p = 0; p < pathsPerPage; p++) {
      const px = (p * 7) % (w - 10);
      const py = (p * 13) % (h - 10);
      content += `0.${(p % 9) + 1} g ${px} ${py} 6 4 re f\n`;
    }
    const lines = syntheticPageText(i, charsPerPage);
    if (lines.length > 0) {
      content += "0 g BT /F1 9 Tf 11 TL 20 " + (h - 20) + " Td\n";
      for (const line of lines) {
        content += `(${line}) Tj T*\n`;
      }
      content += "ET\n";
    }
    stream(id + 1, "", encoder.encode(content));
    stream(id + 2, "", filler(padBytes, i + 1));
  }
  const xrefAt = size;
  const count = nextId;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) {
    xref += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(
    `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  );
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
