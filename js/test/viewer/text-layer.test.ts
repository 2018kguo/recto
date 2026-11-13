// The text layer and its links: spans over their glyphs on every rotation, overlays over their
// rects, and only safe schemes followed.

import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";
import { degrees, PDFDocument, PDFName, type PDFObject, PDFString, StandardFonts } from "pdf-lib";

import { boxAt, openPdf, type PdfDocument } from "../../src/index.ts";
import { buildTextLayer, placeTextSpan, safeLinkHref } from "../../src/viewer/text-layer.ts";
import { followableLinks, MAX_LINKS_PER_PAGE, pageText, textRuns } from "../../src/viewer/worker-core.ts";

const { document } = new JSDOM("<!doctype html><div></div>").window;

// A span is laid out unrotated at (left, top), then rotated by its CSS `rotate()` about that corner
// (y down). Where its middle lands on the page.
function spanMiddle(span: HTMLElement, width: number) {
  const left = Number.parseFloat(span.style.left);
  const top = Number.parseFloat(span.style.top);
  const height = Number.parseFloat(span.style.fontSize);
  const turn = /rotate\((-?[\d.]+)deg\)/u.exec(span.style.transform);
  const r = ((turn ? Number(turn[1]) : 0) * Math.PI) / 180;
  const x = width / 2;
  const y = height / 2;
  return { x: left + x * Math.cos(r) - y * Math.sin(r), y: top + x * Math.sin(r) + y * Math.cos(r) };
}

const LINE = "Quarterly revenue grew in every region";

async function rotatedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const rotation of [0, 90, 180, 270]) {
    const page = doc.addPage([612, 792]);
    page.setRotation(degrees(rotation));
    page.drawText(LINE, { font, size: 14, x: 72, y: 600 });
    page.drawText(`Second line on the ${rotation} page`, { font, size: 14, x: 72, y: 560 });
  }
  return doc.save();
}

// The span for each run must sit over that run's glyphs on the page, on every /Rotate. The engine's
// own word boxes are the oracle: they come from its char boxes, not from the placement under test.
test("text layer spans sit over their glyphs on every page rotation", async () => {
  const scale = 1.5;
  const doc = await openPdf(await rotatedPdf());
  try {
    for (let index = 0; index < doc.pageCount; index++) {
      const info = doc.pageInfo(index);
      const text = doc.text(index);
      const runs = textRuns(text, info);
      const container = document.createElement("div");
      buildTextLayer({ container, pageHeight: info.height, runs, scale });
      const spans = [...container.querySelectorAll("span")];
      assert.equal(spans.length, runs.length);
      assert.ok(container.textContent?.includes(LINE), `page ${index + 1}`);
      const words = Array.from({ length: text.words.count }, (_, w) => boxAt(text.words.boxes, w));
      for (const [i, span] of spans.entries()) {
        const run = runs[i]!;
        const middle = spanMiddle(span, run.width * scale);
        const covered = words.some(
          (box) =>
            middle.x >= box.x * scale - 2 &&
            middle.x <= (box.x + box.width) * scale + 2 &&
            middle.y >= box.y * scale - 2 &&
            middle.y <= (box.y + box.height) * scale + 2
        );
        const nearest = Math.min(
          ...words.map((box) => Math.hypot(middle.x - (box.x + box.width / 2) * scale, middle.y - (box.y + box.height / 2) * scale))
        );
        assert.ok(covered || nearest < run.height * scale, `page ${index + 1} (${info.rotation}°) run "${run.str}" sits off its glyphs`);
      }
    }
  } finally {
    doc.close();
  }
});

test("the layer's text reads like the page: words spaced, lines broken", async () => {
  const doc = await openPdf(await rotatedPdf());
  try {
    const container = document.createElement("div");
    buildTextLayer({ container, pageHeight: 792, runs: textRuns(doc.text(0), doc.pageInfo(0)), scale: 1 });
    assert.equal(container.querySelectorAll("br").length, 1);
    assert.match(container.textContent ?? "", /every region\s*Second line/u);
  } finally {
    doc.close();
  }
});

for (const direction of [0, 90, 180, 270] as const) {
  test(`a run read at ${direction}° keeps its baseline origin on the canvas`, () => {
    const run = { direction, height: 10, x: 100, y: 500 };
    const { fontSize, left, top } = placeTextSpan({ pageHeight: 792, run, scale: 1.5 });
    const r = (-direction * Math.PI) / 180;
    const ascent = 0.8 * fontSize;
    // The span's baseline-left point (0, ascent), rotated about its corner.
    assert.ok(Math.abs(left - ascent * Math.sin(r) - run.x * 1.5) < 1e-9);
    assert.ok(Math.abs(top + ascent * Math.cos(r) - (792 - run.y) * 1.5) < 1e-9);
  });
}

type LinkSpec = {
  rect: [number, number, number, number];
  action?: Record<string, PDFObject | string>;
  dest?: { page: number; left: number; top: number };
};

/** Two 600 x 800 pages, the first turned a quarter by /Rotate, with `links` on the first. */
async function linkedPdf(links: LinkSpec[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const pages = [doc.addPage([600, 800]), doc.addPage([600, 800])];
  pages[0]?.setRotation(degrees(90));
  const { context } = doc;
  const annots = links.map(({ action, dest, rect }) =>
    context.register(
      context.obj({
        Border: [0, 0, 0],
        Rect: rect,
        Subtype: "Link",
        Type: "Annot",
        ...(action && { A: context.obj(action) }),
        ...(dest && { Dest: [pages[dest.page]?.ref ?? null, PDFName.of("XYZ"), dest.left, dest.top, null] }),
      })
    )
  );
  pages[0]?.node.set(PDFName.of("Annots"), context.obj(annots));
  return doc.save();
}

const uriAction = (uri: string) => ({ S: PDFName.of("URI"), URI: PDFString.of(uri) });

async function linkLayer(bytes: Uint8Array, scale: number) {
  const doc = await openPdf(bytes);
  try {
    const container = document.createElement("div");
    buildTextLayer({ container, links: followableLinks(doc, 0), pageHeight: doc.pageInfo(0).height, runs: [], scale });
    return [...container.querySelectorAll("a")];
  } finally {
    doc.close();
  }
}

const boxOf = (anchor: HTMLElement) => ["left", "top", "width", "height"].map((side) => Number.parseFloat(anchor.style.getPropertyValue(side)));

// A link's /Rect is in the page's user space (y up); the overlay is on the page as shown. Under
// /Rotate 90 a point (u, v) of user space shows at (v, u) from the top-left. Computed by hand here.
test("link overlays cover their /Rect on a rotated page at a zoom", async () => {
  const scale = 1.5;
  const anchors = await linkLayer(
    await linkedPdf([
      { action: uriAction("https://example.com/report"), rect: [100, 700, 200, 720] },
      { dest: { left: 50, page: 1, top: 500 }, rect: [300, 40, 340, 90] },
    ]),
    scale
  );
  assert.equal(anchors.length, 2);
  const [external, internal] = anchors as [HTMLAnchorElement, HTMLAnchorElement];
  assert.deepEqual(boxOf(external), [700, 100, 20, 100].map((v) => v * scale));
  assert.equal(external.getAttribute("href"), "https://example.com/report");
  assert.equal(external.target, "_blank");
  assert.equal(external.rel, "noopener noreferrer");
  assert.deepEqual(boxOf(internal), [40, 300, 50, 40].map((v) => v * scale));
  // XYZ 50 500 on the upright 600 x 800 page 2: 50 from its left, 300 from its top, in points.
  assert.equal(internal.dataset.destPage, "2");
  assert.equal(Number(internal.dataset.destX), 50);
  assert.equal(Number(internal.dataset.destY), 300);
  assert.equal(internal.target, "");
});

test("links to unsafe schemes, other files and programs get no overlay", async () => {
  const unsafe = [
    "javascript:alert(document.cookie)",
    " JavaScript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "relative/page.html",
  ];
  const safe = ["https://example.com/a", "http://example.com/b", "mailto:qa@example.com"];
  const anchors = await linkLayer(
    await linkedPdf([
      ...[...unsafe, ...safe].map((uri, i) => ({ action: uriAction(uri), rect: [10, 10 + i * 30, 50, 30 + i * 30] as LinkSpec["rect"] })),
      { action: { F: PDFString.of("calc.exe"), S: PDFName.of("Launch") }, rect: [100, 10, 150, 30] },
      { action: { JS: PDFString.of("app.alert(1)"), S: PDFName.of("JavaScript") }, rect: [100, 40, 150, 60] },
    ]),
    1
  );
  assert.deepEqual(
    anchors.map((anchor) => anchor.getAttribute("href")),
    safe
  );
  // Web pages open in a tab; a mail link hands off to the mail app.
  assert.deepEqual(
    anchors.map((anchor) => anchor.target),
    ["_blank", "_blank", ""]
  );
  // The URL parser drops tabs and newlines anywhere and control characters at the ends, so these
  // read as javascript: and must not slip past.
  const disguised = ["java\tscript:alert(1)", "java\nscript:alert(1)", "\u0001javascript:alert(1)", "\u0000 javascript:alert(1)", "javascript\u0001:alert(1)"];
  for (const uri of [...unsafe, ...disguised]) {
    assert.equal(safeLinkHref(uri), null, JSON.stringify(uri));
  }
  assert.equal(safeLinkHref("\u0001https://example.com/a"), "https://example.com/a");
});

/** A document whose page 0 has `links`, without a file. */
function linksOnly(links: ({ page: number } | { uri: string })[], pageCount = 2): Pick<PdfDocument, "links" | "pageCount"> {
  const box = { height: 10, width: 10, x: 0, y: 0 };
  return {
    links: () =>
      links.map((link, annotation) => ({
        annotation,
        box,
        target:
          "uri" in link
            ? { kind: "uri" as const, uri: link.uri }
            : {
                destination: { box: null, bottom: null, left: 1, name: null, page: link.page, right: null, top: 2, view: "XYZ", x: 1, y: 2, zoom: null },
                kind: "page" as const,
              },
      })),
    pageCount,
  };
}

test("a link to a page outside the file gets no overlay", () => {
  // The engine says -1 for a destination that goes nowhere in the file.
  const links = followableLinks(linksOnly([{ page: -1 }, { page: 2 }, { page: 1 }]), 0);
  assert.deepEqual(
    links.map(({ target }) => target),
    [{ box: null, kind: "page", page: 2, view: "XYZ", x: 1, y: 2, zoom: null }]
  );
});

test("a page draws at most MAX_LINKS_PER_PAGE link overlays", () => {
  const many = Array.from({ length: MAX_LINKS_PER_PAGE + 50 }, (_, i) => ({ uri: `https://example.com/${i}` }));
  assert.equal(followableLinks(linksOnly(many), 0).length, MAX_LINKS_PER_PAGE);
});

// Links are extra: a page whose link annotations can't be read still gets its text layer.
test("a page whose links throw still gets its text", async () => {
  const doc = await openPdf(await rotatedPdf());
  try {
    const page = pageText(
      {
        links: () => {
          throw new Error("damaged /Annots");
        },
        pageCount: doc.pageCount,
        pageInfo: (index) => doc.pageInfo(index),
        text: (index) => doc.text(index),
      },
      0
    );
    assert.deepEqual(page.links, []);
    assert.ok(page.runs.some((run) => run.str.includes("Quarterly")));
  } finally {
    doc.close();
  }
});
