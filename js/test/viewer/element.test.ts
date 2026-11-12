// <recto-viewer>: its toolbar follows the viewer, and its find bar works from the keyboard.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createViewerEngine } from "../../src/viewer/client.ts";
import { defineViewerElement, type ViewerElement } from "../../src/viewer/element.ts";
import { fakeLayout } from "./dom.ts";
import { inProcessWorkers, textPdf } from "./fixtures.ts";

test("the element's toolbar shows the file, the page and the zoom, and its find bar steps through hits", async () => {
  const layout = fakeLayout();
  const { window } = layout;
  // The element's class extends the page's HTMLElement, made when it's defined.
  Object.assign(globalThis, { HTMLElement: window.HTMLElement, ShadowRoot: window.ShadowRoot });
  defineViewerElement("recto-viewer", window.customElements);
  assert.equal(defineViewerElement("recto-viewer", window.customElements), window.customElements.get("recto-viewer"), "defining twice is a no-op");
  const engine = createViewerEngine({ createWorker: inProcessWorkers().createWorker });
  const element = layout.document.createElement("recto-viewer") as ViewerElement;
  element.engine = engine;
  element.setAttribute("name", "Quarterly report.pdf");
  layout.container.append(element);
  element.source = textPdf({ pages: 5 });
  try {
    const shadow = element.shadowRoot!;
    const $ = <T extends Element>(selector: string) => shadow.querySelector<T>(selector)!;
    await element.viewer!.ready;
    assert.equal($(".name").textContent, "Quarterly report.pdf");
    assert.equal($(".of").textContent, "of 5");
    assert.equal($<HTMLInputElement>(".page-input").value, "1");
    assert.equal($(".fit").textContent, "100%");
    // Every control has a name a screen reader can say.
    for (const button of shadow.querySelectorAll("button")) {
      assert.ok(button.getAttribute("aria-label") || button.textContent?.trim(), button.className);
    }

    $<HTMLButtonElement>(".zoom-in").click();
    assert.equal($(".fit").textContent, "125%");
    $<HTMLButtonElement>(".fit").click();
    assert.equal($(".fit").textContent, "100%");

    // Go to a page by typing it.
    const pageInput = $<HTMLInputElement>(".page-input");
    pageInput.value = "4";
    pageInput.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await layout.until(() => element.viewer!.page === 4, "page 4");

    // ⌘F from inside the viewer opens find.
    element.viewer!.element.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "f", metaKey: true }));
    assert.equal($(".findbar").hasAttribute("hidden"), false);
    const findInput = $<HTMLInputElement>(".find-input");
    findInput.value = "line 1";
    findInput.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    // The first hit at or after the reader's page is the current one.
    await layout.until(() => $(".count").textContent === "4 of 5", "the hit on page 4");
    // Drawn on the pages near the screen only: page 1 is three pages up.
    assert.equal(shadow.querySelectorAll(".recto-highlights > div").length, 4);
    assert.equal(shadow.querySelectorAll(".recto-highlights > .recto-active").length, 1);
    findInput.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    assert.equal($(".count").textContent, "5 of 5");
    findInput.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Enter", shiftKey: true }));
    assert.equal($(".count").textContent, "4 of 5");
    findInput.value = "no such words";
    findInput.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await layout.until(() => $(".count").textContent === "No matches", "no matches");
    assert.equal(shadow.querySelectorAll(".recto-highlights > div").length, 0);
    findInput.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    assert.equal($(".findbar").hasAttribute("hidden"), true);
  } finally {
    element.remove();
    engine.close();
  }
  assert.equal(element.viewer, null, "removing it destroys its viewer");
});

test("the sidebar: hidden until asked for, thumbnails drawn only near view and after the pages, an outline to jump with, and keys", async () => {
  const layout = fakeLayout();
  const { window } = layout;
  Object.assign(globalThis, { HTMLElement: window.HTMLElement, ShadowRoot: window.ShadowRoot });
  defineViewerElement("recto-viewer", window.customElements);
  const workers = inProcessWorkers();
  const engine = createViewerEngine({ createWorker: workers.createWorker });
  const element = layout.document.createElement("recto-viewer") as ViewerElement;
  element.engine = engine;
  layout.container.append(element);
  element.source = textPdf({
    outline: [
      { page: 1, title: "Introduction" },
      { children: [{ page: 12, title: "Sampling" }, { page: 15, title: "Analysis" }], page: 10, title: "Methods" },
      { page: 30, title: "Results" },
    ],
    pages: 40,
  });
  try {
    const shadow = element.shadowRoot!;
    const $ = <T extends Element>(selector: string) => shadow.querySelector<T>(selector)!;
    const viewer = element.viewer!;
    await viewer.ready;
    const toggle = $<HTMLButtonElement>(".sidebar-toggle");
    assert.equal($(".sidebar").hidden, true, "hidden by default");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(shadow.querySelectorAll(".thumb").length, 0, "nothing is made for a sidebar never shown");
    await layout.until(() => viewer.pageElement(1)!.dataset.rendered === "true", "page 1");

    toggle.click();
    assert.equal($(".sidebar").hidden, false);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    const thumbs = [...shadow.querySelectorAll<HTMLElement>(".thumb")];
    assert.equal(thumbs.length, 40);
    const drawnThumbs = () => thumbs.filter((thumb) => thumb.querySelector("canvas")).map((thumb) => Number(thumb.dataset.page));
    await layout.until(() => drawnThumbs().length >= 5, "the thumbnails in view");
    await layout.idle(100);
    // Those in view and a little past it; small bitmaps, drawn after the pages near the screen.
    assert.deepEqual(drawnThumbs(), [1, 2, 3, 4, 5]);
    const renders = workers.ports.flatMap((port) => port.sent).filter((message) => message.op === "render");
    const small = renders.filter((message) => message.op === "render" && message.width === 224);
    assert.equal(small.length, 5);
    assert.ok(renders.indexOf(small[0]!) > 0, "a page's own render went first");
    // The page being read is marked, and is the list's one tab stop.
    assert.equal(thumbs[0]!.getAttribute("aria-current"), "page");
    assert.equal(thumbs[0]!.tabIndex, 0);
    assert.equal(thumbs[1]!.tabIndex, -1);

    // Scrolled to the end: the end is drawn, and the start lets go of its bitmaps.
    $<HTMLElement>(".thumbs").scrollTop = 36 * 160;
    await layout.until(() => drawnThumbs().includes(40), "the last thumbnail");
    assert.ok(!drawnThumbs().includes(1));
    $<HTMLElement>(".thumbs").scrollTop = 0;

    // Keys move through the list; a thumbnail goes to its page.
    thumbs[0]!.focus();
    thumbs[0]!.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    assert.equal(shadow.activeElement, thumbs[1]);
    assert.equal(thumbs[1]!.tabIndex, 0);
    thumbs[1]!.click();
    await layout.until(() => viewer.page === 2, "page 2");
    await layout.until(() => thumbs[1]!.getAttribute("aria-current") === "page", "the thumbnail to follow");

    // The outline: its tab appears once read; nested entries open with the arrow keys.
    await layout.until(() => !$(".tabs").hidden, "the outline tab");
    $<HTMLButtonElement>(".tab-outline").click();
    assert.equal($(".thumbs").hidden, true);
    assert.equal($(".outline").hidden, false);
    const items = () => [...shadow.querySelectorAll<HTMLElement>(".outline .item")].filter((item) => !item.closest("ul[hidden]")).map((item) => item.textContent);
    assert.deepEqual(items(), ["Introduction", "Methods", "Results"]);
    const methods = [...shadow.querySelectorAll<HTMLElement>(".outline .item")].find((item) => item.textContent === "Methods")!;
    methods.focus();
    methods.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    assert.equal(methods.getAttribute("aria-expanded"), "true");
    assert.deepEqual(items(), ["Introduction", "Methods", "Sampling", "Analysis", "Results"]);
    methods.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    const sampling = shadow.activeElement as HTMLElement;
    assert.equal(sampling.textContent, "Sampling");
    sampling.click();
    await layout.until(() => viewer.page === 12, "the bookmark's page");
    sampling.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    assert.equal(shadow.activeElement, methods, "Left goes up to the parent");
    // Escape closes it, back to the button that opened it.
    methods.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    assert.equal($(".sidebar").hidden, true);
    assert.equal(shadow.activeElement, toggle);
  } finally {
    element.remove();
    engine.close();
  }
});
