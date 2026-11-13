// What the page or file says, rather than a stand-in for it, and saying so when a page is cut off.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createPdfEngine, openPdf, PdfError } from "../src/index.ts";
import { syntheticPdf } from "./synthetic-pdf.ts";
import { pagePdf } from "./rare-pdfs.ts";
import { pdfOf } from "./transparency-cases.mjs";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** A form of `perForm` operators, drawn `times` times from the page. */
function repeated(formContent: string, times: number): Uint8Array {
  return pdfOf({
    content: "/F Do\n".repeat(times),
    resources: "/XObject <</F 5 0 R>>",
    objects: [
      {
        dict: " /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources <</Font <</H 6 0 R>>>>",
        data: formContent,
      },
      "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
    ],
  });
}

test("a page past the glyph cap says so; one under it doesn't", async () => {
  const text = `BT /H 1 Tf (${"x".repeat(1000)}) Tj ET`;
  await using over = await openPdf(repeated(text, 600));
  const page = over.text(0);
  assert.equal(page.truncated, true);
  assert.ok(page.count <= 2 ** 19 + 1);
  await using under = await openPdf(repeated(text, 2));
  assert.equal(under.text(0).truncated, false);
});

test("a page past the path cap says so on its objects", async () => {
  const paths = "0 0 1 1 re f\n".repeat(5000);
  await using over = await openPdf(repeated(paths, 500));
  assert.equal(over.objects(0).truncated, true);
  await using under = await openPdf(repeated(paths, 2));
  assert.equal(under.objects(0).truncated, false);
});

test("a render past its limit on backdrop groups says so", async () => {
  const group = (n: number) => `q 1 0 0 1 0 0 cm /Half gs /G Do Q % ${n}\n`;
  const page = (count: number) =>
    pdfOf({
      content: Array.from({ length: count }, (_, i) => group(i)).join(""),
      resources: "/XObject <</G 5 0 R>> /ExtGState <</Half <</ca 0.5>>>>",
      objects: [
        {
          dict: " /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group <</S /Transparency>> /Resources <</ExtGState <</Mul <</BM /Multiply>>>>>>",
          data: "/Mul gs 0 1 1 rg 0 0 100 100 re f",
        },
      ],
    });
  await using over = await openPdf(page(40));
  assert.equal(over.render(0, { width: 50 }).truncated, true);
  await using under = await openPdf(page(3));
  assert.equal(under.render(0, { width: 50 }).truncated, false);
});

const scaled = pdfOf({
  content: "q 2 0 0 2 0 0 cm BT /A 10 Tf 3 0 0 3 0 0 Tm (Hi) Tj ET Q",
  resources: "/Font <</A 5 0 R>>",
  objects: ["<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>"],
});

test("fontSizes is the drawn size, tfSizes the operand", async () => {
  await using doc = await openPdf(scaled);
  const page = doc.text(0);
  assert.equal(page.fontSizes[0], 60);
  assert.equal(page.tfSizes[0], 10);
});

const WIDTHS = `/FirstChar 72 /LastChar 72 /Widths [1000]`;
const twoFonts = pdfOf({
  content: "BT /A 100 Tf 0 50 Td (H) Tj /B 20 Tf (H) Tj ET",
  resources: "/Font <</A 5 0 R /B 6 0 R>>",
  objects: [
    `<</Type /Font /Subtype /Type1 /BaseFont /ABCDEF+Fancy-Bold ${WIDTHS} /FontDescriptor 7 0 R>>`,
    `<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>`,
    "<</Type /FontDescriptor /FontName /Fancy-Bold /Flags 34 /FontBBox [0 -300 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -300 /CapHeight 700 /StemV 80 /FontWeight 650>>",
  ],
});

test("char boxes use the font's ascent and descent, or the default where it has none", async () => {
  await using doc = await openPdf(twoFonts);
  const page = doc.text(0);
  const [a, b] = [0, 1].map((i) => page.fonts[page.fontIds[i] ?? -1]!);
  assert.deepEqual([a!.ascent.toFixed(2), a!.descent.toFixed(2)], ["0.90", "-0.30"]);
  assert.deepEqual([b!.ascent.toFixed(2), b!.descent.toFixed(2)], ["0.80", "-0.20"]);
  // Baseline at y = 50 on a 100 pt page, so 50 from the top in the viewer frame.
  assert.ok(Math.abs((page.boxes[1] ?? 0) - (50 - 90)) < 0.01, `top ${page.boxes[1]}`);
  assert.ok(Math.abs((page.boxes[3] ?? 0) - 120) < 0.01, `height ${page.boxes[3]}`);
});

test("a substituted font's char box is the PDF's width, not the stretched one", async () => {
  // Helvetica-Bold stands in for this font, whose H is stated as 1000 units wide.
  await using doc = await openPdf(twoFonts);
  const page = doc.text(0);
  assert.ok(Math.abs((page.boxes[2] ?? 0) - 100) < 0.01, `width ${page.boxes[2]}`);
});

test("fonts: names and weights come from the dictionary, for every font type", async () => {
  await using doc = await openPdf(twoFonts);
  const { fonts } = doc.text(0);
  assert.deepEqual(
    fonts.map((f) => [f.name, f.weight, f.embedded]),
    [
      ["Fancy-Bold", 650, false],
      ["Helvetica", 400, false],
    ],
  );
  assert.equal(fonts[0]?.flags, 34);
});

test("two font dictionaries over one program stay two fonts", async () => {
  const pdf = pdfOf({
    content: "BT /A 10 Tf 0 50 Td (H) Tj /B 10 Tf (i) Tj ET",
    resources: "/Font <</A 5 0 R /B 6 0 R>>",
    objects: [
      "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>",
      "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
    ],
  });
  await using doc = await openPdf(pdf);
  const { fonts, fontIds } = doc.text(0);
  assert.equal(fonts.length, 2);
  assert.notEqual(fontIds[0], fontIds[1]);
});

test("outline: nesting, GoTo, named destinations, links out", async () => {
  const body = pdfOf({
    content: "BT ET",
    resources: "",
    objects: [
      // 5: the outline root; 6..10 its items; 11 a named-destination tree.
      "<</Type /Outlines /First 6 0 R /Last 8 0 R /Count 4>>",
      "<</Title (One) /Parent 5 0 R /Next 8 0 R /First 7 0 R /Last 7 0 R /Dest [3 0 R /Fit]>>",
      "<</Title <FEFF00C9> /Parent 6 0 R /A <</S /GoTo /D (named)>>>>",
      "<</Title (Three) /Parent 5 0 R /Prev 6 0 R /Next 9 0 R /A <</S /URI /URI (https://example.com/)>>>>",
      // A loop: this item's Next is the first again.
      "<</Title (Four) /Parent 5 0 R /Prev 8 0 R /Next 6 0 R>>",
    ],
  });
  const patched = new TextDecoder("latin1")
    .decode(body)
    .replace("<</Type /Catalog /Pages 2 0 R>>", "<</Type /Catalog /Pages 2 0 R /Outlines 5 0 R /Names <</Dests <</Names [(named) [3 0 R /Fit]]>>>>>>");
  await using doc = await openPdf(Uint8Array.from(patched, (c) => c.charCodeAt(0)));
  const fit = (name: string | null) => ({
    kind: "page",
    destination: { page: 0, view: "Fit", x: null, y: null, zoom: null, box: null, left: null, bottom: null, right: null, top: null, name },
  });
  assert.deepEqual(doc.outline(), [
    { title: "One", page: 0, url: null, target: fit(null), children: [{ title: "É", page: 0, url: null, target: fit("named"), children: [] }] },
    { title: "Three", page: -1, url: "https://example.com/", target: { kind: "uri", uri: "https://example.com/" }, children: [] },
    { title: "Four", page: -1, url: null, target: { kind: "none" }, children: [] },
  ]);
  await using none = await openPdf(syntheticPdf({ pages: 1 }));
  assert.deepEqual(none.outline(), []);
});

test("memory past the mark goes back when the last document closes, not at the next open", async () => {
  const engine = await createPdfEngine({ recycleAboveBytes: 1 });
  const before = engine.stats();
  assert.ok(before.heapBytes > 1);
  const first = await engine.open(syntheticPdf({ pages: 2 }));
  const second = await engine.open(syntheticPdf({ pages: 2 }));
  // The second open itself recycled, leaving the first on the old instance.
  second.close();
  assert.equal(engine.stats().heapBytes, 0, "nothing is open on the current instance, so it's gone");
  first.close();
  const reopened = await engine.open(syntheticPdf({ pages: 2 }));
  assert.ok(engine.stats().heapBytes > 0);
  assert.equal(reopened.text(0).count > 0, true);
  reopened.close();
});

test("under the mark, an instance stays for the next open", async () => {
  const engine = await createPdfEngine();
  const { generation } = engine.stats();
  (await engine.open(syntheticPdf({ pages: 2 }))).close();
  assert.ok(engine.stats().heapBytes > 0);
  (await engine.open(syntheticPdf({ pages: 2 }))).close();
  assert.equal(engine.stats().generation, generation);
});

test("encrypted, trailer lost: revision 6 is repaired, with or without a password to ask for", async () => {
  await using plain = await openPdf(fixture("encrypted-r6-no-trailer.pdf"));
  assert.match(plain.text(0).text, /Hello repaired file/u);
  await assert.rejects(openPdf(fixture("encrypted-r6-password-no-trailer.pdf")), (error: PdfError) => error.code === "password-required");
  await using locked = await openPdf(fixture("encrypted-r6-password-no-trailer.pdf"), { password: "pw" });
  assert.match(locked.text(0).text, /Hello repaired file/u);
});

test("encrypted, trailer lost: before revision 6 the key died with it, and it says so, not blank", async () => {
  await assert.rejects(openPdf(fixture("encrypted-r4-no-trailer.pdf")), (error: PdfError) => error.code === "invalid-file");
});

// 16 bytes of CCITTFaxDecode declaring 60,000 by 60,000 pixels crashed the instance; a stream that
// inflates past `maxDecodedBytes` took memory the instance never gives back.
test("a stream or image that decodes past maxDecodedBytes is left out, and the page says so", async () => {
  const { deflateSync } = await import("node:zlib");
  const pdf = pagePdf("BT /H 10 Tf 10 10 Td (kept) Tj ET q 100 0 0 100 0 0 cm /Im Do Q /F Do", "/Font << /H 5 0 R >> /XObject << /Im 6 0 R /F 7 0 R >>", [
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    {
      dict: "/Type /XObject /Subtype /Image /Width 60000 /Height 60000 /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 60000 /Rows 60000 >>",
      data: new Uint8Array(16),
    },
    {
      dict: "/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Filter /FlateDecode",
      data: deflateSync(Buffer.alloc(4 << 20, 0x20)),
    },
  ]);
  const engine = await createPdfEngine();
  await using whole = await engine.open(pdf);
  assert.equal(whole.render(0, { width: 50 }).truncated, true, "the image is past the default");
  const text = whole.text(0);
  assert.equal(text.truncated, false, "text decodes neither the image nor, under 768 MiB, the form");
  assert.ok(String.fromCodePoint(...text.codepoints).includes("kept"));

  const small = await createPdfEngine({ maxDecodedBytes: 1 << 20 });
  await using cut = await small.open(pdf);
  const cutText = cut.text(0);
  assert.equal(cutText.truncated, true, "the form inflates past 1 MiB");
  assert.ok(String.fromCodePoint(...cutText.codepoints).includes("kept"), "the rest of the page still reads");
  await assert.rejects(createPdfEngine({ maxDecodedBytes: -1 }), RangeError);
});

// One stream listed five times in `/Contents`, or forms nested five deep, each under the limit, took
// five times it at once and crashed the instance. And what a limit left out stays left out in what's
// cached, so every call says so, not only the first that decoded it.
test("maxDecodedBytes bounds what a page holds at once, and every call on it says truncated, in any order", async () => {
  const { deflateSync } = await import("node:zlib");
  const MAX = 1 << 20;
  const spaces = deflateSync(Buffer.alloc(300 << 10, 0x20));
  const form = (inner: number | null) => ({
    dict: `/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Filter /FlateDecode${inner ? ` /Resources << /XObject << /N ${inner} 0 R >> >>` : ""}`,
    data: deflateSync(Buffer.concat([Buffer.from(inner ? "/N Do\n" : ""), Buffer.alloc(400 << 10, 0x20)])),
  });
  // Objects from 5: the font, the spaces, three nested forms.
  // The page's content is object 4 and the spaces five times over.
  const pdf = pagePdf(
    "BT /H 10 Tf 10 10 Td (kept) Tj ET /N Do",
    "/Font << /H 5 0 R >> /XObject << /N 7 0 R >>",
    ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", { dict: "/Filter /FlateDecode", data: spaces }, form(8), form(9), form(null)],
    "[4 0 R 6 0 R 6 0 R 6 0 R 6 0 R 6 0 R]"
  );
  type Doc = Awaited<ReturnType<Awaited<ReturnType<typeof createPdfEngine>>["open"]>>;
  const reads: [string, (doc: Doc) => boolean | Promise<boolean>][] = [
    ["text", (doc) => doc.text(0).truncated],
    ["objects", (doc) => doc.objects(0).truncated],
    ["render", (doc) => doc.render(0, { width: 50 }).truncated],
    ["renderAsync", async (doc) => (await doc.renderAsync(0, { width: 50 })).truncated],
  ];
  for (const order of [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1]]) {
    const engine = await createPdfEngine({ maxDecodedBytes: MAX });
    await using doc = await engine.open(pdf);
    const before = engine.stats().heapBytes;
    for (let round = 0; round < 2; round++) {
      for (const index of order) {
        const [name, read] = reads[index]!;
        assert.equal(await read(doc), true, `${name}, order ${order}, round ${round}`);
      }
    }
    assert.ok(engine.stats().heapBytes - before < 6 * MAX, `${engine.stats().heapBytes - before} bytes more`);
  }
  // The pool's threads run the built package.
  const { createPdfPool } = await import("../dist/index.js");
  using pool = await createPdfPool({ maxDecodedBytes: MAX, threads: 1 });
  const pooled = await pool.open(pdf);
  for (let i = 0; i < 2; i++) {
    assert.equal((await pooled.render(0, { width: 50 })).truncated, true);
    assert.equal((await pooled.text(0)).truncated, true);
  }
});
