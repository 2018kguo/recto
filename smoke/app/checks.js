// The page's own thread: no synchronous reads here, so assets are fetched up front, and the engine
// works. A ranged read still has to refuse. And the same in a service worker.
import { createPdfEngine, createPdfPool, openPdf } from "@2018kguo/recto";

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
  // Threads from a page, without a word of setup: the bundler has to find their file and what it loads.
  const pool = await createPdfPool({ threads: 2 });
  const pooled = await pool.open(report);
  const [poolText, poolBitmap] = await Promise.all([pooled.text(0), pooled.render(0, { width: 1024 })]);
  mainThread.poolText = poolText.text;
  mainThread.poolInk = ink(poolBitmap);
  // None of these may wait for ever, and a time limit here would only say so later: the page's limit says it.
  mainThread.poolSignal = await pooled
    .render(0, { width: 64, signal: new AbortController().signal })
    .catch((error) => error.name);
  await pooled.render(0, { width: () => 64 }).catch(() => {});
  mainThread.poolAfterBadArgument = (await pooled.text(0)).count > 0 ? "fine" : "no text";
  await pooled.close();
  pool.close();
  const failing = async (assetBase) => {
    const broken = await createPdfPool({ threads: 2, assetBase });
    const code = await broken.open(report).then(
      () => "opened",
      (error) => error.code
    );
    broken.close();
    return code;
  };
  const pdfsBase = new URL(new URLSearchParams(location.search).get("pdfs"), location.href);
  await fetch(new URL("/flaky-set/recto.wasm/gone", pdfsBase));
  mainThread.poolNoWasm = await failing(new URL("/flaky/", pdfsBase).href);
  await fetch(new URL("/flaky-set/none/none", pdfsBase));
  mainThread.poolBadBase = await failing("/nothing-here/");
  // The package from another origin, as from a CDN.
  const cdn = await import(/* @vite-ignore */ new URL("/pkg/dist/index.js", pdfsBase).href);
  const cdnPool = await cdn.createPdfPool({ threads: 2 });
  const cdnDocs = [await cdnPool.open(report), await cdnPool.open(report), await cdnPool.open(report)];
  mainThread.cdnText = (await cdnDocs[0].text(0)).text;
  mainThread.cdnInk = ink(await cdnDocs[1].render(0, { width: 1024 }));
  mainThread.cdnThirdOpen = (await cdnDocs[2].text(0)).count > 0 ? 1 : 0;
  cdnPool.close();
  const rareDoc = await openPdf(await (await fetch("/jbig2.pdf")).arrayBuffer());
  mainThread.rareInk = rareDoc.render(0, { width: 64 }).rgba.some((v) => v < 128);
  rareDoc.close();
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
