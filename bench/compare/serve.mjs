// The comparison's server: the page, both viewers' files and the PDFs, through one simulated link.
//
// Everything a side loads is under /x/<network>/<run>/<side>/, so its bytes are counted apart and a
// new run never meets a cached file. Under a network preset every response waits one round trip,
// then shares a single link of the preset's bandwidth with every other response in flight, as a
// phone's one connection would. Code is sent brotli-compressed (quality 11) to a browser that takes
// it, as a production server would; PDFs are sent as they are, with `Range` answered.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";

import { byteRange } from "../serve.mjs";

const here = import.meta.dirname;

/** Round trip and download bandwidth, Chrome DevTools' presets. */
export const NETWORKS = {
  none: { label: "No throttling", latencyMs: 0, kbps: 0 },
  "fast-4g": { label: "Fast 4G", latencyMs: 165, kbps: 9000 * 0.9 },
  "slow-4g": { label: "Slow 4G", latencyMs: 562.5, kbps: 1600 * 0.9 },
  "slow-3g": { label: "Slow 3G", latencyMs: 2000, kbps: 500 * 0.8 },
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".pdf": "application/pdf",
};
// What a production server would compress. The rest (PDFs, deflated cmaps, PNGs) goes as it is.
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".svg", ".wasm", ".json", ".pfb", ".ttf", ".bcmap", ".icc"]);
const CODE = new Set([".js", ".mjs", ".wasm"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `docs` maps a name to `{ label, bytes }`; `word` is the one the script finds.
 */
export async function serveCompare({ docs = new Map(), word = "interchange" } = {}) {
  const version = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
  const roots = {
    recto: path.join(here, "../../js"),
    pdfjs: path.join(here, "node_modules/pdfjs-dist"),
  };
  const page = path.join(here, "page");
  const brotliCache = new Map();
  const brotli = (file, body) => {
    if (!brotliCache.has(file)) {
      brotliCache.set(file, zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } }));
    }
    return brotliCache.get(file);
  };
  // run id -> side -> { requests, wire, doc, code, codeBrotli, other }
  const runs = new Map();
  const count = (run, side) => {
    if (!runs.has(run)) runs.set(run, {});
    const sides = runs.get(run);
    sides[side] ??= { requests: 0, inflight: 0, wire: 0, doc: 0, codeBrotli: 0, codeFiles: [], other: 0, log: [] };
    return sides[side];
  };
  // One link per preset: a byte can leave once every byte reserved before it has.
  const links = new Map();

  async function send(response, body, network, { onChunk }) {
    const preset = NETWORKS[network] ?? NETWORKS.none;
    if (!preset.kbps) {
      onChunk(body.length);
      response.end(body);
      return;
    }
    const bytesPerMs = (preset.kbps * 1000) / 8 / 1000;
    const link = links.get(network) ?? { freeAt: 0 };
    links.set(network, link);
    for (let at = 0; at < body.length; at += 16384) {
      if (response.destroyed) return;
      const chunk = body.subarray(at, at + 16384);
      const start = Math.max(performance.now(), link.freeAt);
      link.freeAt = start + chunk.length / bytesPerMs;
      await sleep(link.freeAt - performance.now());
      if (response.destroyed) return;
      onChunk(chunk.length);
      if (!response.write(chunk)) await new Promise((resolve) => response.once("drain", resolve));
    }
    response.end();
  }

  const isolation = {
    // Cross-origin isolated, so the page may ask the browser how much memory each side holds.
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (url.pathname === "/") {
        response.writeHead(302, { Location: "/compare/" + url.search }).end();
        return;
      }
      if (parts[0] === "api") {
        await api(parts[1], url, request, response);
        return;
      }
      let file;
      let body;
      let tally = null;
      let network = "none";
      let kind = "other";
      if (parts[0] === "compare") {
        file = path.join(page, ...(parts.length > 1 ? parts.slice(1) : ["index.html"]));
        if (!file.startsWith(page)) file = null;
      } else if (parts[0] === "x" && parts.length >= 5) {
        // /x/<network>/<run>/<side>/<what>...
        const [, net, run, side, what, ...rest] = parts;
        network = net;
        tally = count(run, side);
        if (what === "doc") {
          body = docs.get(rest.join("/"))?.bytes;
          kind = "doc";
        } else if (roots[what]) {
          file = path.join(roots[what], ...rest);
          if (!file.startsWith(roots[what])) file = null;
          kind = CODE.has(path.extname(file ?? "")) ? "code" : "other";
        } else {
          // The side's own page and script: not part of either viewer, but sent the same way.
          file = path.join(page, what, ...rest);
          if (!file.startsWith(page)) file = null;
          kind = "harness";
        }
      }
      if (file && fs.existsSync(file) && fs.statSync(file).isFile()) body = fs.readFileSync(file);
      if (!body) {
        response.writeHead(404, isolation).end();
        return;
      }
      const ext = file ? path.extname(file) : ".pdf";
      const headers = { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "no-store", ...isolation };
      let status = 200;
      let part = body;
      if (kind === "doc") {
        headers["Accept-Ranges"] = "bytes";
        const range = byteRange(request.headers.range, body.length);
        if (range === "unsatisfiable") {
          response.writeHead(416, { ...headers, "Content-Range": `bytes */${body.length}` }).end();
          return;
        }
        if (range) {
          status = 206;
          part = body.subarray(range.start, range.end + 1);
          headers["Content-Range"] = `bytes ${range.start}-${range.end}/${body.length}`;
        }
      } else if (COMPRESSIBLE.has(ext) && /\bbr\b/u.test(request.headers["accept-encoding"] ?? "")) {
        part = brotli(file, body);
        headers["Content-Encoding"] = "br";
        headers.Vary = "Accept-Encoding";
      }
      if (tally && kind !== "harness") {
        tally.requests++;
        if (kind === "code") {
          tally.codeBrotli += brotli(file, body).length;
          tally.codeFiles.push(path.relative(roots[parts[4]], file));
        }
      }
      headers["Content-Length"] = part.length;
      const preset = NETWORKS[network] ?? NETWORKS.none;
      const counted = tally && kind !== "harness";
      const entry = counted && { path: parts.slice(4).join("/"), range: request.headers.range ?? null, start: Math.round(performance.now()), end: null };
      if (counted) {
        tally.inflight++;
        tally.log.push(entry);
      }
      try {
        if (preset.latencyMs) await sleep(preset.latencyMs);
        response.writeHead(status, headers);
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        await send(response, part, network, {
        onChunk: (n) => {
          if (!tally || kind === "harness") return;
          tally.wire += n;
          if (kind === "doc") tally.doc += n;
          else if (kind !== "code") tally.other += n;
          },
        });
      } finally {
        if (counted) {
          tally.inflight--;
          entry.end = Math.round(performance.now());
        }
      }
    } catch (error) {
      if (!response.headersSent) response.writeHead(500).end(String(error));
      else response.destroy();
    }
  });

  async function api(name, url, request, response) {
    const json = (value, status = 200) => response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...isolation }).end(JSON.stringify(value));
    if (name === "info") {
      json({
        recto: version(roots.recto),
        pdfjs: version(roots.pdfjs),
        networks: NETWORKS,
        word,
        docs: [...docs].map(([doc, { label, bytes }]) => ({ name: doc, label, bytes: bytes.length })),
      });
    } else if (name === "stats") {
      json(runs.get(url.searchParams.get("run")) ?? {});
    } else if (name === "upload" && request.method === "POST") {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 512 * 1024 * 1024) return json({ error: "too large" }, 413);
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(Buffer.concat(chunks));
      const name = `upload/${Date.now().toString(36)}-${(url.searchParams.get("name") ?? "file.pdf").replace(/[^\w.-]+/gu, "_")}`;
      docs.set(name, { label: url.searchParams.get("name") ?? "file.pdf", bytes });
      json({ name, bytes: bytes.length });
    } else {
      json({ error: "not found" }, 404);
    }
  }

  // Compress what the viewers load before the first request, so no run waits on it.
  const warm = [
    ...["dist", "dist/viewer", "wasm"].flatMap((dir) => fs.readdirSync(path.join(roots.recto, dir)).map((name) => path.join(roots.recto, dir, name))),
    ...["build/pdf.min.mjs", "build/pdf.worker.min.mjs", "web/pdf_viewer.mjs", "web/pdf_viewer.css"].map((name) => path.join(roots.pdfjs, name)),
  ];
  for (const file of warm) {
    if (COMPRESSIBLE.has(path.extname(file)) && fs.statSync(file).isFile()) brotli(file, fs.readFileSync(file));
  }
  await new Promise((resolve) => server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    docs,
    runs,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
