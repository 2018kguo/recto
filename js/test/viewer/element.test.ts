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
      assert.ok(button.getAttribute("aria-label"), button.className);
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
