// A local server for the browser bench and the film: the engines' own files, a harness, and PDFs
// from memory. `responses` is what the engines' files sent, the real bytes off the wire, with what
// each would be under brotli. Range requests are answered, so a large PDF opens by range as it
// would from any static file server.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";

const here = import.meta.dirname;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };

/**
 * A single `bytes=` range of a body `length` long, as inclusive offsets: null to send it whole (no
 * header, or one this doesn't take, such as several ranges), "unsatisfiable" for a 416.
 */
export function byteRange(header, length) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(String(header ?? "").trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    return null;
  }
  let start;
  let end;
  if (match[1] === "") {
    // A suffix: the last n bytes, all of them if n is past the start.
    start = Math.max(0, length - Number(match[2]));
    end = length - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? length - 1 : Math.min(length - 1, Number(match[2]));
  }
  return start >= length || start > end || length === 0 ? "unsatisfiable" : { start, end };
}

export async function serve({ extraRoots = {} } = {}) {
  const roots = {
    app: path.join(here, "browser"),
    recto: path.join(here, "../js"),
    pdfjs: path.join(here, "node_modules/pdfjs-dist"),
    pdfium: path.join(here, "node_modules/@embedpdf/pdfium/dist"),
    mupdf: path.join(here, "node_modules/mupdf/dist"),
    ...extraRoots,
  };
  const uncounted = new Set(["app", ...Object.keys(extraRoots)]);
  const docs = new Map();
  const responses = [];
  const brotli = new Map();
  const brotliSize = (key, body) => {
    if (!brotli.has(key)) {
      brotli.set(key, zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } }).length);
    }
    return brotli.get(key);
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const [, root, ...rest] = url.pathname.split("/");
    let body;
    let type = "application/octet-stream";
    if (root === "doc") {
      body = docs.get(rest.join("/"));
      type = "application/pdf";
    } else if (root === "app" && rest[0] === "engines.mjs") {
      body = fs.readFileSync(path.join(here, "engines.mjs"));
      type = "text/javascript";
    } else if (roots[root]) {
      const file = path.join(roots[root], ...rest);
      if (file.startsWith(roots[root]) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        body = fs.readFileSync(file);
        type = MIME[path.extname(file)] ?? type;
        if (!uncounted.has(root)) {
          responses.push({ path: url.pathname, raw: body.length, brotli: brotliSize(file, body) });
        }
      }
    }
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
    const range = byteRange(request.headers.range, body.length);
    if (range === "unsatisfiable") {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${body.length}` }).end();
      return;
    }
    const [status, part] = range ? [206, body.subarray(range.start, range.end + 1)] : [200, body];
    response.writeHead(status, {
      ...headers,
      "Content-Length": part.length,
      ...(range && { "Content-Range": `bytes ${range.start}-${range.end}/${body.length}` }),
    });
    response.end(request.method === "HEAD" ? undefined : part);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    docs,
    responses,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
