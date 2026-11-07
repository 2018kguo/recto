// Causes the rendering scorecard (bench/scorecard.mjs) found, each on a small generated PDF: what the
// page must look like, where pdfium, pdf.js and poppler agree on it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createPdfEngine } from "../src/index.ts";
import { pdfOf } from "./transparency-cases.mjs";

const engine = await createPdfEngine();
const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const WHITE = [255, 255, 255];

function render(bytes: Uint8Array, width = 100) {
  const doc = engine.open(bytes);
  return doc.then((d) => {
    const { width: w, height, rgba } = d.render(0, { width });
    d.close();
    return { width: w, height, at: (x: number, y: number) => [...rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)] };
  });
}
const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

test("a hybrid file's XRefStm with the table's own Prev doesn't lose the update", async () => {
  // The update replaces the page tree from an object stream named only by the XRefStm, whose Prev
  // is the table already read. A repair would take the first copy, 300 high.
  let out = "%PDF-1.7\n";
  const offsets: Record<number, number> = {};
  const object = (n: number, body: string) => {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${body}\nendobj\n`;
  };
  object(1, "<</Type /Catalog /Pages 2 0 R>>");
  object(2, "<</Type /Pages /MediaBox [0 0 200 300] /Count 1 /Kids [3 0 R]>>");
  object(3, "<</Type /Page /Parent 2 0 R>>");
  const entry = (n: number) => `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  const first = out.length;
  out += `xref\n0 4\n0000000000 65535 f \n${entry(1)}${entry(2)}${entry(3)}trailer\n<</Size 4 /Root 1 0 R>>\nstartxref\n${first}\n%%EOF\n`;
  const inner = "2 0 <</Type /Pages /MediaBox [0 0 200 350] /Count 1 /Kids [3 0 R]>>";
  object(4, `<</Type /ObjStm /N 1 /First 4 /Length ${inner.length}>>\nstream\n${inner}\nendstream`);
  const stream = out.length;
  const hex = "02 0004 00 >";
  object(5, `<</Type /XRef /Filter /ASCIIHexDecode /Index [2 1] /W [1 2 1] /Size 6 /Root 1 0 R /Prev ${first} /Length ${hex.length}>>\nstream\n${hex}\nendstream`);
  const table = out.length;
  out += `xref\n4 1\n${entry(4)}trailer\n<</Size 6 /Root 1 0 R /Prev ${first} /XRefStm ${stream}>>\nstartxref\n${table}\n%%EOF\n`;
  const page = await render(latin1(out), 200);
  assert.equal(page.height, 350);
});

const twoGroups = {
  // Group 5 is on, 6 is off.
  catalogExtra: "/OCProperties <</OCGs [5 0 R 6 0 R] /D <</OFF [6 0 R]>>>>",
  objects: ["<</Type /OCG /Name (on)>>", "<</Type /OCG /Name (off)>>"],
};

test("an OCMD's visibility expression decides, over its OCGs and policy", async () => {
  const cases: [string, number[]][] = [
    ["[/Not 5 0 R]", WHITE],
    ["[/Not 6 0 R]", RED],
    ["[/And 5 0 R 6 0 R]", WHITE],
    ["[/Or 5 0 R 6 0 R]", RED],
    ["[/And 5 0 R [/Not 6 0 R]]", RED],
    ["[/Not [/Or 5 0 R 6 0 R]]", WHITE],
  ];
  for (const [ve, want] of cases) {
    const page = await render(
      pdfOf({
        catalogExtra: twoGroups.catalogExtra,
        content: "/OC /M BDC 1 0 0 rg 0 0 100 100 re f EMC",
        resources: "/Properties <</M 7 0 R>>",
        // /OCGs and /P alone would show it: the group that's on is on.
        objects: [...twoGroups.objects, `<</Type /OCMD /OCGs [5 0 R] /P /AnyOn /VE ${ve}>>`],
      })
    );
    assert.deepEqual(page.at(50, 50), want, ve);
  }
});

test("an annotation in a hidden optional content group isn't drawn", async () => {
  const appearance = (oc: string, n: number) => `<</Type /Annot /Subtype /Stamp /Rect [0 0 100 100] /AP <</N ${n} 0 R>> /OC ${oc}>>`;
  const form = { dict: " /Type /XObject /Subtype /Form /BBox [0 0 100 100]", data: "1 0 0 rg 0 0 100 100 re f" };
  for (const [oc, want] of [
    ["6 0 R", WHITE],
    ["5 0 R", RED],
  ] as [string, number[]][]) {
    const page = await render(
      pdfOf({
        ...twoGroups,
        objects: [...twoGroups.objects, form, appearance(oc, 7)],
        content: "",
        pageExtra: "/Annots [8 0 R]",
      })
    );
    assert.deepEqual(page.at(50, 50), want, oc);
  }
});

test("a Q with no q in a form leaves the caller's state alone", async () => {
  const page = await render(
    pdfOf({
      content: "0 1 0 rg q /F Do 0 0 100 100 re f Q",
      resources: "/XObject <</F 5 0 R>>",
      objects: [{ dict: " /Type /XObject /Subtype /Form /BBox [0 0 100 100]", data: "Q Q Q 1 0 0 rg" }],
    })
  );
  assert.deepEqual(page.at(50, 50), GREEN);
});

/** A TrueType font of 3 glyphs, the last a filled square, whose `loca` is out of order. */
function fontWithBackwardLoca(): string {
  const be16 = (v: number) => String.fromCharCode((v >> 8) & 255, v & 255);
  const be32 = (v: number) => be16(v >>> 16) + be16(v & 0xffff);
  const square = (from: number, to: number) =>
    be16(1) + be16(from) + be16(from) + be16(to) + be16(to) + be16(3) + be16(0) + "\x01\x01\x01\x01" + be16(from) + be16(0) + be16(to - from) + be16(0) + be16(from) + be16(to - from) + be16(0) + be16(from - to);
  // Glyph 2 is first in `glyf`, glyph 1 second, and glyph 1's end in `loca` comes before its start.
  const a = square(0, 100);
  const b = square(0, 1000);
  const padded = b + (b.length % 2 ? "\0" : "");
  const paddedA = a + (a.length % 2 ? "\0" : "");
  const tables: Record<string, string> = {
    cvt_: "",
    glyf: paddedA + padded,
    head: be32(0x10000) + be32(0) + be32(0) + be32(0x5f0f3cf5) + be16(0) + be16(1000) + "\0".repeat(16) + be16(0) + be16(0) + be16(1000) + be16(1000) + be16(0) + be16(8) + be16(2) + be16(1) + be16(0),
    hhea: be32(0x10000) + be16(800) + be16(-200 & 0xffff) + be16(0) + be16(1000) + "\0".repeat(22) + be16(3),
    hmtx: (be16(1000) + be16(0)).repeat(3),
    loca: be32(paddedA.length) + be32(paddedA.length) + be32(0) + be32(paddedA.length),
    maxp: be32(0x10000) + be16(3) + be16(8) + be16(1) + "\0".repeat(22),
  };
  delete tables.cvt_;
  const names = Object.keys(tables).sort();
  let offset = 12 + names.length * 16;
  let directory = be32(0x10000) + be16(names.length) + be16(0) + be16(0) + be16(0);
  let body = "";
  for (const name of names) {
    const table = tables[name] ?? "";
    directory += name + be32(0) + be32(offset) + be32(table.length);
    const aligned = table + "\0".repeat((4 - (table.length % 4)) % 4);
    body += aligned;
    offset += aligned.length;
  }
  return directory + body;
}

test("a TrueType glyph whose loca entry runs backwards is still drawn", async () => {
  const font = fontWithBackwardLoca();
  const page = await render(
    pdfOf({
      // CID 1: the glyph with `loca` going from the second to the first in the table.
      content: "BT /F 100 Tf 0 0 Td <0001> Tj ET",
      resources: "/Font <</F 5 0 R>>",
      objects: [
        "<</Type /Font /Subtype /Type0 /BaseFont /T /Encoding /Identity-H /DescendantFonts [6 0 R]>>",
        "<</Type /Font /Subtype /CIDFontType2 /BaseFont /T /CIDSystemInfo <</Registry (Adobe) /Ordering (Identity) /Supplement 0>> /CIDToGIDMap /Identity /DW 1000 /FontDescriptor 7 0 R>>",
        "<</Type /FontDescriptor /FontName /T /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 8 0 R>>",
        { dict: ` /Length1 ${font.length}`, data: font },
      ],
    })
  );
  // The big square, and not the small one that sits first in `glyf`.
  assert.deepEqual(page.at(50, 50), [0, 0, 0]);
});

test("a soft mask's group with its BBox corners the other way round still masks by its contents", async () => {
  const page = await render(
    pdfOf({
      content: "/M gs 1 0 0 rg 0 0 100 100 re f",
      resources: "/ExtGState <</M <</SMask <</S /Luminosity /G 5 0 R>>>>>>",
      objects: [{ dict: " /Type /XObject /Subtype /Form /BBox [0 100 100 0] /Group <</S /Transparency /CS /DeviceGray>>", data: "1 g 0 0 100 100 re f" }],
    })
  );
  assert.deepEqual(page.at(50, 50), RED);
});

// An annotation with no /AP, drawn from its dictionary. The page is white, or green under a highlight.
function annotated(annot: string, content = "") {
  return pdfOf({ content, objects: [annot], pageExtra: "/Annots [5 0 R]" });
}

test("a highlight with no appearance multiplies over what's under it", async () => {
  const page = await render(
    annotated("<</Type /Annot /Subtype /Highlight /Rect [10 10 90 50] /C [1 1 0] /QuadPoints [10 50 90 50 10 10 90 10]>>", "0 1 1 rg 0 0 50 100 re f")
  );
  assert.deepEqual(page.at(70, 70), [255, 255, 0], "yellow on paper");
  assert.deepEqual(page.at(30, 70), GREEN, "yellow times cyan");
  assert.deepEqual(page.at(70, 20), WHITE, "outside its quad");
});

test("markup, shapes and ink with no appearance are drawn from their dictionaries", async () => {
  const cases: [string, string, [number, number], number[], [number, number]][] = [
    ["underline", "/Subtype /Underline /Rect [0 40 100 61] /C [1 0 0] /QuadPoints [0 60.5 100 60.5 0 40.5 100 40.5]", [50, 59], RED, [50, 50]],
    ["strikeout", "/Subtype /StrikeOut /Rect [0 40 100 61] /C [1 0 0] /QuadPoints [0 60.5 100 60.5 0 40.5 100 40.5]", [50, 49], RED, [50, 42]],
    ["square, filled", "/Subtype /Square /Rect [20 20 80 80] /IC [0 1 0] /C [1 0 0] /BS <</W 4>>", [50, 50], GREEN, [10, 10]],
    ["square, outline", "/Subtype /Square /Rect [20 20 80 80] /C [1 0 0] /BS <</W 4>>", [21, 50], RED, [50, 50]],
    ["circle", "/Subtype /Circle /Rect [20 20 80 80] /IC [1 0 0] /C [1 0 0]", [50, 50], RED, [22, 22]],
    ["line", "/Subtype /Line /Rect [0 0 100 100] /L [0 50 100 50] /C [1 0 0] /BS <</W 6>>", [50, 49], RED, [50, 30]],
    ["polygon", "/Subtype /Polygon /Rect [0 0 100 100] /Vertices [10 10 90 10 50 90] /IC [0 1 0] /C [0 1 0]", [50, 60], GREEN, [15, 20]],
    ["ink", "/Subtype /Ink /Rect [0 0 100 100] /InkList [[0 50 100 50]] /C [1 0 0] /BS <</W 6>>", [50, 49], RED, [50, 30]],
  ];
  for (const [name, dict, at, want, away] of cases) {
    const page = await render(annotated(`<</Type /Annot ${dict}>>`));
    assert.deepEqual(page.at(...at), want, name);
    assert.deepEqual(page.at(...away), WHITE, `${name}, away from it`);
  }
});

test("a hidden annotation with no appearance stays hidden, and an empty /C draws no stroke", async () => {
  for (const dict of ["/F 2 /Subtype /Square /Rect [20 20 80 80] /IC [1 0 0]", "/Subtype /Square /Rect [20 20 80 80] /C []"]) {
    const page = await render(annotated(`<</Type /Annot ${dict}>>`));
    assert.deepEqual(page.at(50, 50), WHITE, dict);
    assert.deepEqual(page.at(20, 50), WHITE, dict);
  }
});

test("a free text box with no appearance shows its fill and its words", async () => {
  const page = await render(annotated("<</Type /Annot /Subtype /FreeText /Rect [10 10 90 90] /C [0 1 0] /DA (0 0 0 rg /Nope 20 Tf) /Contents (HHHH) /BS <</W 0>>>>"));
  assert.deepEqual(page.at(50, 80), GREEN);
  let dark = 0;
  for (let y = 10; y < 45; y++) for (let x = 10; x < 90; x++) if ((page.at(x, y)[1] ?? 255) < 100) dark++;
  assert.ok(dark > 40, `the text is there: ${dark} dark pixels`);
});
