// A viewer's worker. The client starts one per open document (up to a few), because a ranged read
// blocks its thread for a network round trip: a slow file then only ever blocks itself, and closing
// it can stop a stuck read by stopping the worker.

import type { ViewerRequest, ViewerResponse } from "./protocol.ts";
import { createWorkerHandler } from "./worker-core.ts";

type WorkerScope = {
  postMessage(message: ViewerResponse, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<ViewerRequest>) => void): void;
};

const scope = globalThis as unknown as WorkerScope;
const handle = createWorkerHandler({ reply: (response, transfer) => scope.postMessage(response, transfer) });
scope.addEventListener("message", ({ data }) => {
  handle(data).catch(() => {});
});
