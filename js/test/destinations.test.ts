// Destinations through the public API: every view, on pages turned each way and cropped off their
// origin; names from the catalog's Dests and the name tree; other files; the outline's and the
// document's open action; and looking a destination up in the file a link goes to. Imports the built
// package, for the pool.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createPdfEngine, createPdfPool, type PdfDestination, type PdfDocument } from "../dist/index.js";

const engine = await createPdfEngine();
const encoder = new TextEncoder();

function pdfOf(objects: string[]): Uint8Array {
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
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(out);
}

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

/**
 * Page 0 links everywhere. Pages 1 to 4 have a crop box off the media box's origin, 500 by 700, turned
 * 0, 90, 180 and 270 degrees; page 1 has a /UserUnit as well. (100, 700) in their user space is (50, 60)
 * on the unturned one as shown.
 */
function destinationsPdf(): Uint8Array {
  const annots = [
    "/Dest [4 0 R /XYZ 100 700 1.5]",
    "/Dest [5 0 R /XYZ 100 700 null]",
    "/Dest [6 0 R /FitR 100 200 300 400]",
    "/Dest [7 0 R /FitH 700]",
    "/Dest [4 0 R /FitBV 100]",
    "/Dest (missing)",
    "/A << /S /GoToR /F (../other/report.pdf) /D [2 /XYZ 10 20 3] /NewWindow true >>",
    "/A << /S /GoToR /F << /Type /Filespec /UF (sibling file.pdf) /FS /URL >> /D /Chapter2 >>",
    "/A << /S /GoToE /T << /R /C /N (attached.pdf) >> /D (inner) >>",
    "/Dest /legacy",
    "/Dest (deep)",
  ]
    .map((a) => `<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] ${a} >>`)
    .join(" ");
  const turned = (rotate: number, extra = "") =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /CropBox [50 60 550 760] /Rotate ${rotate} ${extra}>>`;
  return pdfOf([
    "<< /Type /Catalog /Pages 2 0 R /Dests 8 0 R /Names << /Dests 9 0 R >> /Outlines 12 0 R /OpenAction 15 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R 7 0 R] /Count 5 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Annots [${annots}] >>`,
    turned(0, "/UserUnit 2 "),
    turned(90),
    turned(180),
    turned(270),
    // 8: the catalog's Dests.
    "<< /legacy << /D [4 0 R /XYZ 100 700 null] >> >>",
    // 9 to 11: a name tree with kids and limits.
    "<< /Kids [10 0 R 11 0 R] >>",
    "<< /Limits [(a) (e)] /Names [(deep) [6 0 R /Fit]] >>",
    "<< /Limits [(f) (z)] /Names [(zed) << /D [7 0 R /XYZ 100 700 null] >>] >>",
    // 12 to 14: the outline.
    "<< /First 13 0 R /Last 14 0 R >>",
    "<< /Title (Deep) /Parent 12 0 R /Next 14 0 R /A << /S /GoTo /D (deep) >> >>",
    "<< /Title (Elsewhere) /Parent 12 0 R /A << /S /GoToR /F (other.pdf) /D (start) >> >>",
    // 15: the open action, an action dictionary.
    "<< /S /GoTo /D [5 0 R /FitV 100] >>",
  ]);
}

function check(doc: PdfDocument) {
  const [xyz, turned, fitR, fitH, fitBV, missing, remote, remoteNamed, embedded, legacy, deep] = doc.links(0).map((l) => l.target);
  assert.deepEqual(xyz, { kind: "page", destination: dest({ page: 1, view: "XYZ", x: 50, y: 60, zoom: 1.5, left: 100, top: 700 }) });
  assert.deepEqual(turned, { kind: "page", destination: dest({ page: 2, view: "XYZ", x: 640, y: 50, left: 100, top: 700 }) });
  assert.deepEqual(fitR, {
    kind: "page",
    destination: dest({ page: 3, view: "FitR", x: 250, y: 140, box: { x: 250, y: 140, width: 200, height: 200 }, left: 100, bottom: 200, right: 300, top: 400 }),
  });
  assert.deepEqual(fitH, { kind: "page", destination: dest({ page: 4, view: "FitH", x: 60, top: 700 }) });
  assert.deepEqual(fitBV, { kind: "page", destination: dest({ page: 1, view: "FitBV", x: 50, left: 100 }) });
  assert.deepEqual(missing, { kind: "page", destination: dest({ page: -1, name: "missing" }) });
  assert.deepEqual(remote, {
    kind: "remote",
    file: "../other/report.pdf",
    fileSystem: null,
    destination: dest({ page: 2, view: "XYZ", zoom: 3, left: 10, top: 20 }),
    newWindow: true,
    name: null,
    page: 2,
  });
  assert.deepEqual(remoteNamed, {
    kind: "remote",
    file: "sibling file.pdf",
    fileSystem: "URL",
    destination: dest({ page: -1, name: "Chapter2" }),
    newWindow: null,
    name: "Chapter2",
    page: null,
  });
  assert.deepEqual(embedded, {
    kind: "embedded",
    file: null,
    path: [{ relation: "child", name: "attached.pdf" }],
    destination: dest({ page: -1, name: "inner" }),
    newWindow: null,
  });
  assert.deepEqual(legacy, { kind: "page", destination: dest({ page: 1, view: "XYZ", x: 50, y: 60, left: 100, top: 700, name: "legacy" }) });
  assert.deepEqual(deep, { kind: "page", destination: dest({ page: 3, view: "Fit", name: "deep" }) });

  const [inside, elsewhere] = doc.outline();
  assert.deepEqual(inside!.target, deep);
  assert.equal(inside!.page, 3);
  assert.deepEqual(elsewhere!.target, {
    kind: "remote",
    file: "other.pdf",
    fileSystem: null,
    destination: dest({ page: -1, name: "start" }),
    newWindow: null,
    name: "start",
    page: null,
  });
  assert.equal(elsewhere!.page, -1);
  // FitV 100 on the page turned a quarter: the left is a viewer y.
  assert.deepEqual(doc.openAction(), { kind: "page", destination: dest({ page: 2, view: "FitV", y: 50, left: 100 }) });

  // The other side of a link from another file: a name, down the tree, and an explicit destination placed.
  assert.deepEqual(doc.destination("zed"), dest({ page: 4, view: "XYZ", x: 60, y: 450, left: 100, top: 700, name: "zed" }));
  assert.deepEqual(doc.destination("missing"), dest({ page: -1, name: "missing" }));
  assert.deepEqual(
    doc.destination(dest({ page: 2, view: "XYZ", left: 100, top: 700, zoom: 2 })),
    dest({ page: 2, view: "XYZ", x: 640, y: 50, left: 100, top: 700, zoom: 2 })
  );
  assert.equal(doc.destination(dest({ page: 7, view: "Fit" })).page, -1);
}

test("destinations go to the exact place, whole and ranged", async () => {
  const bytes = destinationsPdf();
  const whole = await engine.open(bytes);
  const ranged = await engine.openRanged(bytes, { chunkBytes: 256 });
  try {
    check(whole);
    check(ranged);
  } finally {
    whole.close();
    ranged.close();
  }
});

test("an open action given as a destination, and none", async () => {
  const doc = await engine.open(
    pdfOf([
      "<< /Type /Catalog /Pages 2 0 R /OpenAction [3 0 R /XYZ null null 0] >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
    ])
  );
  const bare = await engine.open(
    pdfOf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>"])
  );
  try {
    assert.deepEqual(doc.openAction(), { kind: "page", destination: dest({ page: 0, view: "XYZ" }) });
    assert.deepEqual(bare.openAction(), { kind: "none" });
    assert.throws(() => bare.destination(42 as unknown as string), TypeError);
  } finally {
    doc.close();
    bare.close();
  }
});

test("a pool answers the open action and destination lookups as one thread does", async () => {
  const bytes = destinationsPdf();
  using single = await engine.open(bytes);
  using pool = await createPdfPool({ threads: 1 });
  await using doc = await pool.open(bytes);
  assert.deepEqual(await doc.openAction(), single.openAction());
  assert.deepEqual(await doc.destination("deep"), single.destination("deep"));
  const remote = single.links(0)[6]!.target;
  assert.equal(remote.kind, "remote");
  const there = remote.kind === "remote" ? remote.destination : dest({ page: -1 });
  assert.deepEqual(await doc.destination(there), single.destination(there));
  assert.deepEqual(await doc.links(0), single.links(0));
  assert.deepEqual(await doc.outline(), single.outline());
});
