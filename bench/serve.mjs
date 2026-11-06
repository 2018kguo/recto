// A local server for the browser bench and the film: the engines' own files, a harness, and PDFs
// from memory. `responses` is what the engines' files sent, the real bytes off the wire, with what
// each would be under brotli.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";

const here = import.meta.dirname;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };

export async function serve({ extraRoots = {} } = {}) {
  const roots = {
    app: path.join(here, "browser"),
    recto: path.join(here, "../js"),
    pdfjs: path.join(here, "node_modules/pdfjs-dist"),
    pdfium: path.join(here, "node_modules/@embedpdf/pdfium/dist"),
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
    response.writeHead(200, { "Content-Type": type, "Content-Length": body.length, "Cache-Control": "no-store" });
    response.end(body);
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
