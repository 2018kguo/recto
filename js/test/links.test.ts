// Link annotations' targets, through the public API.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createPdfEngine, type PdfDestination, type PdfDocument, type PdfLink } from "../src/index.ts";

const engine = await createPdfEngine();
const encoder = new TextEncoder();

function pdfOf(objects: string[], trailer = ""): Uint8Array {
  let out = "%PDF-1.7\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) {
    out += `${String(at).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer}>>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(out);
}

/** A destination with every field the engine gives, null where `fields` says nothing. */
const dest = (fields: Partial<PdfDestination> & { page: number }): PdfDestination => ({
  view: null,
  x: null,
  y: null,
  zoom: null,
  box: null,
  left: null,
  bottom: null,
  right: null,
  top: null,
  name: null,
  ...fields,
});

const link = (rect: string, rest: string) => `<< /Type /Annot /Subtype /Link /Rect [${rect}] ${rest} >>`;

/**
 * Page 1 links to everything. Page 2 is turned a quarter and cropped; page 3 is plain. Each target
 * page holds a degenerate annotation at the point a destination names, whose box is that point in
 * the page's viewer frame, as annotations give it.
 */
function linkedPdf(): Uint8Array {
  return pdfOf([
    // 1: catalog, with a Dests dictionary and a name tree.
    "<< /Type /Catalog /Pages 2 0 R /Dests 21 0 R /Names << /Dests << /Names [(chapter) [5 0 R /FitH 500]] >> >> >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>",
    // 3: page 1, with every kind of link, and a text annotation between them.
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [6 0 R 7 0 R 8 0 R 9 0 R 10 0 R 22 0 R 11 0 R 12 0 R 13 0 R 14 0 R 15 0 R 16 0 R 17 0 R 23 0 R] >>",
    // 4: page 2, a quarter turn, cropped.
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [50 60 562 752] /Rotate 90 /Annots [18 0 R] >>",
    // 5: page 3.
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [19 0 R 20 0 R] >>",
    link("10 10 110 30", "/A << /S /URI /URI (https://example.com/a?b=c) >>"),
    link("10 40 110 60", "/A << /S /GoTo /D [4 0 R /XYZ 100 700 2] >>"),
    link("10 70 110 90", "/Dest /named-in-dests"),
    link("10 100 110 120", "/Dest (chapter)"),
    "<< /Type /Annot /Subtype /Text /Rect [200 200 220 220] /Contents (a note) >>",
    link("10 130 110 150", "/A << /S /GoToR /F (other.pdf) /D (intro) >>"),
    link("10 160 110 180", "/A << /S /GoToR /F << /Type /Filespec /UF (other file.pdf) >> /D [4 /Fit] >>"),
    link("10 190 110 210", "/A << /S /Launch /F (setup.exe) >>"),
    link("10 220 110 240", "/A << /S /Named /N /NextPage >>"),
    link("10 250 110 270", "/A << /S /JavaScript /JS (app.alert(1)) >>"),
    link("10 280 110 300", "/Dest [5 0 R /FitR 100 200 300 400]"),
    link("10 310 110 330", "/Dest [99 0 R /Fit]"),
    // 18: on page 2, the point (100, 700) that link 7 names.
    "<< /Type /Annot /Subtype /Square /Rect [100 700 100 700] >>",
    // 19, 20: on page 3, the corners of link 16's FitR and the top of chapter's FitH.
    "<< /Type /Annot /Subtype /Square /Rect [100 200 300 400] >>",
    "<< /Type /Annot /Subtype /Square /Rect [0 500 0 500] >>",
    // 21: the catalog's Dests.
    "<< /named-in-dests << /D [3 0 R /FitV 72] >> >>",
    // 22: a link with no action and no destination.
    link("10 340 110 360", ""),
    // 23: a top on the turned page 2, which there is a viewer x.
    link("10 370 110 390", "/Dest [4 0 R /FitH 700]"),
  ]);
}

function check(doc: PdfDocument, links: PdfLink[]): void {
  const annots = doc.annotations(0);
  assert.equal(links.length, 13);
  // Each is its annotation: index and box as `annotations` gives them.
  for (const l of links) {
    assert.deepEqual(l.box, annots[l.annotation]!.box);
    assert.equal(annots[l.annotation]!.subtype, 2);
  }
  assert.deepEqual(
    links.map((l) => l.annotation),
    [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13]
  );
  const [uri, goTo, dests, named, none, remote, remoteSpec, launch, nextPage, script, fitR, nowhere, turnedTop] = links.map((l) => l.target);
  assert.deepEqual(uri, { kind: "uri", uri: "https://example.com/a?b=c" });

  // Page 2's viewer frame: the point is where page 2's degenerate annotation at it is.
  const point = doc.annotations(1)[0]!.box;
  assert.equal(doc.pageInfo(1).rotation, 90);
  assert.deepEqual(goTo, { kind: "page", destination: dest({ page: 1, view: "XYZ", x: point.x, y: point.y, zoom: 2, left: 100, top: 700 }) });

  // FitV names a left: on an unturned page, x, with y left as it was.
  assert.deepEqual(dests, { kind: "page", destination: dest({ page: 0, view: "FitV", x: 72, left: 72, name: "named-in-dests" }) });
  const top = doc.annotations(2)[1]!.box;
  assert.deepEqual(named, { kind: "page", destination: dest({ page: 2, view: "FitH", y: top.y, top: 500, name: "chapter" }) });
  assert.deepEqual(none, { kind: "none" });
  assert.deepEqual(remote, {
    kind: "remote",
    file: "other.pdf",
    fileSystem: null,
    destination: dest({ page: -1, name: "intro" }),
    newWindow: null,
    name: "intro",
    page: null,
  });
  assert.deepEqual(remoteSpec, {
    kind: "remote",
    file: "other file.pdf",
    fileSystem: null,
    destination: dest({ page: 4, view: "Fit" }),
    newWindow: null,
    name: null,
    page: 4,
  });
  assert.deepEqual(launch, { kind: "launch", file: "setup.exe" });
  assert.deepEqual(nextPage, { kind: "action", action: "Named", name: "NextPage" });
  assert.deepEqual(script, { kind: "action", action: "JavaScript", name: null });
  const rect = doc.annotations(2)[0]!.box;
  assert.deepEqual(fitR, {
    kind: "page",
    destination: dest({ page: 2, view: "FitR", x: rect.x, y: rect.y, box: rect, left: 100, bottom: 200, right: 300, top: 400 }),
  });
  // On page 2, a quarter turn, FitH's top is the point's viewer x, and y is left as it was.
  assert.deepEqual(turnedTop, { kind: "page", destination: dest({ page: 1, view: "FitH", x: point.x, top: 700 }) });
  assert.deepEqual(nowhere, { kind: "page", destination: dest({ page: -1, view: "Fit" }) });
}

test("links: a URI, destinations to a page and a place on it, and what's only reported", async () => {
  const bytes = linkedPdf();
  const doc = await engine.open(bytes);
  check(doc, doc.links(0));
  assert.deepEqual(doc.links(1), []);
  doc.close();
  // A ranged read finds the same.
  const ranged = await engine.openRanged(bytes, { chunkBytes: 256 });
  check(ranged, ranged.links(0));
  ranged.close();
});

test("a link with neither an action nor a destination says so", async () => {
  const doc = await engine.open(linkedPdf());
  const annots = doc.annotations(0);
  const none = pdfOf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Annots [4 0 R] >>",
    link("1 2 3 4", ""),
  ]);
  const bare = await engine.open(none);
  assert.deepEqual(bare.links(0), [{ annotation: 0, box: bare.annotations(0)[0]!.box, target: { kind: "none" } }]);
  assert.equal(annots.length, 14);
  bare.close();
  doc.close();
});

test("a ranged read finds a link's page where a whole read and the outline do, a page the tree repeats too", async () => {
  // Page 6 0 R is listed twice: page 1 under node 3, and page 2 under node 4, which its /Parent names.
  // It goes to where it first appears, as a bookmark to it does.
  const bytes = pdfOf([
    "<< /Type /Catalog /Pages 2 0 R /Outlines << /First 9 0 R >> >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 3 >>",
    "<< /Type /Pages /Parent 2 0 R /Kids [5 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Pages /Parent 2 0 R /Kids [6 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 3 0 R /MediaBox [0 0 100 100] /Annots [7 0 R] >>",
    "<< /Type /Page /Parent 4 0 R /MediaBox [0 0 200 300] /Rotate 90 >>",
    link("0 0 10 10", "/Dest [6 0 R /XYZ 10 20 0]"),
    "<< >>",
    "<< /Title (a) /Dest [6 0 R /XYZ 10 20 0] >>",
  ]);
  const whole = await engine.open(bytes);
  const ranged = await engine.openRanged(bytes, { chunkBytes: 256 });
  try {
    const expected = whole.links(0);
    assert.equal(expected[0]?.target.kind === "page" && expected[0].target.destination.page, 1);
    assert.equal(whole.outline()[0]?.page, 1);
    assert.deepEqual(ranged.links(0), expected);
    assert.equal(ranged.outline()[0]?.page, 1);
  } finally {
    whole.close();
    ranged.close();
  }
});

test("a link whose page its parents place wrongly is found by the whole tree, as the outline's is", async () => {
  // Object 4 is the root's second kid, page 1, but its /Parent is a node outside the tree that
  // lists it first: up its parents it would be page 0. The tree says page 1, whole or ranged.
  const pages = 40;
  const stray = pages + 4;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [5 0 R 4 0 R ${Array.from({ length: pages - 2 }, (_, i) => `${i + 6} 0 R`).join(" ")}] /Count ${pages} >>`,
    link("10 10 50 50", "/Dest [4 0 R /Fit]"),
    `<< /Type /Page /Parent ${stray} 0 R /MediaBox [0 0 200 200] /Annots [3 0 R] >>`,
  ];
  for (let i = 1; i < pages; i++) {
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>");
  }
  objects.push("<< /Type /Pages /Kids [4 0 R] /Count 1 >>");
  assert.equal(objects.length, stray);
  const bytes = pdfOf(objects);
  const whole = await engine.open(bytes);
  const ranged = await engine.openRanged(bytes, { chunkBytes: 256 });
  try {
    const expected = whole.links(1);
    assert.equal(expected[0]?.target.kind === "page" && expected[0].target.destination.page, 1);
    assert.deepEqual(ranged.links(1), expected);
  } finally {
    whole.close();
    ranged.close();
  }
});
