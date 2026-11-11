// One thread of a pool: opens what it's sent on demand, and answers each call with its result.

import type { PdfDocument } from "./document.ts";
import { adoptEngineModule, createPdfEngine, type PdfEngine } from "./engine.ts";

export type PoolRequest = {
  id: number;
  doc: number;
  /** Only until this thread has the document. */
  open?: { bytes: Uint8Array; password: string | undefined };
  method: string;
  args: unknown[];
};

/** `module`: recto.wasm as the pool's thread compiled it, when it could. */
export type PoolStart = { assetBase: string | undefined; maxDecodedBytes: number | undefined; module?: WebAssembly.Module };

type Port = {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
};

const parent = globalThis.process?.getBuiltinModule?.("node:worker_threads")?.parentPort;
const port = (parent ?? self) as unknown as Port;
const docs = new Map<number, PdfDocument>();
let engine: PdfEngine;

/** Every column in a result, so it moves rather than being copied. */
function buffersIn(value: unknown, found: Set<ArrayBuffer>): void {
  if (ArrayBuffer.isView(value)) {
    found.add(value.buffer as ArrayBuffer);
  } else if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) {
      buffersIn(inner, found);
    }
  }
}

async function answer({ doc: id, open, method, args }: PoolRequest): Promise<unknown> {
  let doc = docs.get(id);
  if (!doc) {
    doc = await engine.open(open!.bytes, open!.password === undefined ? {} : { password: open!.password });
    docs.set(id, doc);
  }
  if (method === "pageCount") {
    return doc.pageCount;
  }
  return (doc as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!(...args);
}

function failureOf(error: unknown) {
  const { name, code, message } = error as { name?: string; code?: string; message?: string };
  return { name, code, message: message ?? String(error) };
}

async function handle(message: PoolRequest | PoolStart): Promise<void> {
  if (!("id" in message)) {
    const { assetBase, maxDecodedBytes, module } = message;
    try {
      if (module) {
        adoptEngineModule(assetBase, module);
      }
      engine = await createPdfEngine({ ...(assetBase ? { assetBase } : {}), ...(maxDecodedBytes === undefined ? {} : { maxDecodedBytes }) });
      port.postMessage({ ready: true }, []);
    } catch (error) {
      port.postMessage({ startFailed: true, failure: failureOf(error) }, []);
    }
    return;
  }
  if (message.method === "close") {
    docs.get(message.doc)?.close();
    docs.delete(message.doc);
    return;
  }
  try {
    const result = await answer(message);
    const buffers = new Set<ArrayBuffer>();
    buffersIn(result, buffers);
    port.postMessage({ result, opened: docs.has(message.doc) }, [...buffers]);
  } catch (error) {
    port.postMessage({ failure: failureOf(error), opened: docs.has(message.doc) }, []);
  }
}

if (parent) {
  parent.on("message", (message: PoolRequest | PoolStart) => void handle(message));
} else {
  self.onmessage = ({ data }) => void handle(data as PoolRequest | PoolStart);
}
