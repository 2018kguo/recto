// The page's own thread: the engine must refuse it, with a message saying what to do.
import { openPdf } from "@2018kguo/recto";

const failure = await openPdf(new Uint8Array(1)).then(
  () => null,
  (error) => error
);
const worker = new Worker(new URL("./checks-worker.js", import.meta.url), { type: "module" });
worker.onmessage = ({ data }) => {
  window.smokeResult = { ...data, mainThread: { code: failure?.code, message: failure?.message } };
};
worker.onerror = (event) => {
  window.smokeResult = { failure: `worker error: ${event.message}` };
};
worker.postMessage(new URLSearchParams(location.search).get("pdfs"));
