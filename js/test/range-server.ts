// A local HTTP server that answers Range requests, well or badly, on its own thread. A
// ranged document blocks its thread while it fetches, so the server cannot share that thread.

import { Worker } from "node:worker_threads";

export type RangeServerMode =
  | "range"
  | "ignore" // Sends the whole file with a 200.
  | "forbidden" // A 403.
  | "short" // A 206 with fewer bytes than the Content-Range says.
  | "unknown-total" // A 206 whose Content-Range total is `*`.
  | "changed" // A correct 206 whose total changes after the first answer.
  | "replaced" // A correct 206 whose ETag changes on every answer.
  | "absurd-total" // A 206 claiming a total of 100 TB.
  | "huge" // Claims 1.9 GiB, serving zeros: address space, not memory, to exhaust.
  | "stalled"; // Takes the request and never answers.

export type RangeServer = {
  /** A URL with a credential-like query, as an S3 presigned GET has. */
  url: string;
  /** Bytes and responses served so far. */
  served(): { bytes: number; requests: number };
  setMode(mode: RangeServerMode): void;
  close(): Promise<void>;
};

const SERVER_SOURCE = `
const http = require("node:http");
const { parentPort, workerData } = require("node:worker_threads");
const { bytes, counters, mode, latencyMs } = workerData;
const body = new Uint8Array(bytes);
const MODES = ["range", "ignore", "forbidden", "short", "unknown-total", "changed", "replaced", "absurd-total", "huge", "stalled"];
const HUGE = 1900 * 1024 * 1024;
// Streams in pieces and counts only what was written, so a client that
// drops a whole-file response after its headers (pdf.js probing for Range
// support) is not charged for the rest.
function send(res, status, headers, part) {
  res.writeHead(status, { "Accept-Ranges": "bytes", "Content-Length": part.byteLength, ...headers });
  let at = 0;
  const pump = () => {
    while (at < part.byteLength && !res.destroyed) {
      const piece = part.subarray(at, at + 65536);
      at += piece.byteLength;
      Atomics.add(counters, 0, piece.byteLength);
      if (!res.write(piece)) { res.once("drain", pump); return; }
    }
    if (!res.destroyed) res.end();
  };
  pump();
}
const server = http.createServer((req, res) => {
  const answer = () => {
    const current = MODES[Atomics.load(mode, 0)];
    if (current === "stalled") return;
    if (current === "forbidden") { res.writeHead(403).end("no"); return; }
    const match = /bytes=(\\d*)-(\\d*)/u.exec(req.headers.range || "");
    Atomics.add(counters, 1, 1);
    if (current === "ignore" || !match) {
      send(res, 200, {}, body);
      return;
    }
    if (current === "huge") {
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), HUGE - 1);
      send(res, 206, { "Content-Range": "bytes " + start + "-" + end + "/" + HUGE }, new Uint8Array(end - start + 1));
      return;
    }
    const start = match[1] === "" ? Math.max(0, body.byteLength - Number(match[2])) : Number(match[1]);
    const end = match[1] === "" || match[2] === "" ? body.byteLength - 1 : Math.min(Number(match[2]), body.byteLength - 1);
    const part = body.subarray(start, end + 1);
    if (current === "short") {
      send(res, 206, { "Content-Range": "bytes " + start + "-" + end + "/" + body.byteLength }, part.subarray(0, part.byteLength >> 1));
      return;
    }
    if (current === "absurd-total") {
      send(res, 206, { "Content-Range": "bytes " + start + "-" + end + "/100000000000000" }, part);
      return;
    }
    if (current === "replaced") {
      const headers = { ETag: '"v' + Atomics.load(counters, 1) + '"', "Content-Range": "bytes " + start + "-" + end + "/" + body.byteLength };
      send(res, 206, headers, part);
      return;
    }
    const total = current === "unknown-total" ? "*" : current === "changed" && Atomics.load(counters, 1) > 1 ? body.byteLength + 1 : body.byteLength;
    send(res, 206, { "Content-Range": "bytes " + start + "-" + (start + part.byteLength - 1) + "/" + total }, part);
  };
  if (latencyMs > 0) setTimeout(answer, latencyMs); else answer();
});
server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
parentPort.on("message", () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
`;

const MODES: RangeServerMode[] = ["range", "ignore", "forbidden", "short", "unknown-total", "changed", "replaced", "absurd-total", "huge", "stalled"];

export async function startRangeServer(
  bytes: Uint8Array,
  options: { latencyMs?: number } = {}
): Promise<RangeServer> {
  const shared = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(shared).set(bytes);
  const counters = new Int32Array(new SharedArrayBuffer(8));
  const mode = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(SERVER_SOURCE, {
    eval: true,
    workerData: {
      bytes: shared,
      counters,
      mode,
      latencyMs: options.latencyMs ?? 0,
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  return {
    url: `http://127.0.0.1:${port}/doc.pdf?X-Amz-Signature=topsecret`,
    served: () => ({
      bytes: Atomics.load(counters, 0),
      requests: Atomics.load(counters, 1),
    }),
    setMode: (next) => Atomics.store(mode, 0, MODES.indexOf(next)),
    close: async () => {
      worker.postMessage("close");
      await new Promise((resolve) => worker.once("exit", resolve));
    },
  };
}
