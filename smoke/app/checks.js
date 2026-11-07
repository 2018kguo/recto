// The page's own thread: no synchronous reads here, so assets are fetched up front, and the engine
// works. A ranged read still has to refuse. And the same in a service worker.
import { createPdfEngine, openPdf } from "@2018kguo/recto";

const ink = ({ rgba }) => {
  let dark = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    dark += rgba[i] < 128 ? 1 : 0;
  }
  return dark;
};
const mainThread = {};
try {
  const report = await (await fetch("/report.pdf")).arrayBuffer();
  const doc = await openPdf(report);
  mainThread.text = doc.text(0).text;
  mainThread.ink = ink(doc.render(0, { width: 1024 }));
  doc.close();
  const engine = await createPdfEngine();
  mainThread.ranged = await engine.openRanged("/report.pdf").then(
    () => "opened",
    (error) => error.code
  );
  const pdfs = new URLSearchParams(location.search).get("pdfs");
  const base = new URL(pdfs, location.href);
  const plain = await createPdfEngine({ assetBase: new URL("/plain/", base), preloadAssets: [] });
  const plainDoc = await plain.open(report);
  mainThread.plainMime = plainDoc.text(0).text;
  plainDoc.close();
  mainThread.tampered = await createPdfEngine({ assetBase: new URL("/tampered/", base), preloadAssets: [] }).then(
    () => "opened",
    (error) => error.code
  );
  // A fetch wrapper that passes on only the URL has to make no difference.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input) => realFetch(input);
  mainThread.tamperedThroughWrapper = await createPdfEngine({ assetBase: new URL("/tampered/", base), preloadAssets: [] }).then(
    () => "opened",
    (error) => error.code
  );
  globalThis.fetch = realFetch;
} catch (error) {
  mainThread.failure = String(error);
}

async function inServiceWorker() {
  const registration = await navigator.serviceWorker.register("/sw.js", { type: "module", scope: "/" });
  const active = registration.active ?? registration.waiting ?? registration.installing;
  if (active.state !== "activated") {
    await new Promise((resolve) => {
      active.addEventListener("statechange", () => active.state === "activated" && resolve());
    });
  }
  return await new Promise((resolve, reject) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = ({ data }) => resolve(data);
    active.postMessage("check", [port2]);
    setTimeout(() => reject(new Error("no answer from the service worker")), 30_000);
  });
}
const serviceWorker = await inServiceWorker().catch((error) => ({ failure: String(error) }));

const worker = new Worker(new URL("./checks-worker.js", import.meta.url), { type: "module" });
worker.onmessage = ({ data }) => {
  window.smokeResult = { ...data, mainThread, serviceWorker };
};
worker.onerror = (event) => {
  window.smokeResult = { failure: `worker error: ${event.message}` };
};
worker.postMessage(new URLSearchParams(location.search).get("pdfs"));
