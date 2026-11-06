// A service worker has no XMLHttpRequest, so the engine fetches its assets up front.
import { openPdf } from "@2018kguo/recto";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("message", (event) => {
  const [port] = event.ports;
  event.waitUntil(
    (async () => {
      try {
        const doc = await openPdf(await (await fetch("/report.pdf")).arrayBuffer());
        const { rgba } = doc.render(0, { width: 1024 });
        let ink = 0;
        for (let i = 0; i < rgba.length; i += 4) {
          ink += rgba[i] < 128 ? 1 : 0;
        }
        port.postMessage({ text: doc.text(0).text, ink });
        doc.close();
      } catch (error) {
        port.postMessage({ failure: String(error) });
      }
    })(),
  );
});
