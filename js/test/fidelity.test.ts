// Causes the rendering scorecard (bench/scorecard.mjs) found, each on a small generated PDF: what the
// page must look like, where pdfium, pdf.js and poppler agree on it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

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

test("an ink stroke with an odd count of numbers is left out", async () => {
  const page = await render(annotated("<</Type /Annot /Subtype /Ink /Rect [0 0 100 100] /InkList [[0 50 100 50 7]] /C [1 0 0] /BS <</W 6>>>>"));
  assert.deepEqual(page.at(50, 49), WHITE);
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

test("a password that protects only attachments isn't asked for to read the pages", async () => {
  // Revision 2 style strings that no empty password opens; /StmF and /StrF are /Identity.
  const hash = "00".repeat(32);
  const encrypt = (stm: string) => `<</Filter /Standard /V 4 /R 4 /Length 128 /P -4 /O <${hash}> /U <${hash}> /CF <</StdCF <</CFM /AESV2 /Length 16>>>> /StmF ${stm} /StrF ${stm} /EFF /StdCF>>`;
  const file = (stm: string) => {
    let out = "%PDF-1.6\n";
    const offsets: number[] = [];
    [
      "<</Type /Catalog /Pages 2 0 R>>",
      "<</Type /Pages /Count 1 /Kids [3 0 R]>>",
      "<</Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R>>",
      "<</Length 24>>\nstream\n1 0 0 rg 0 0 100 100 re f\nendstream",
      encrypt(stm),
    ].forEach((body, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<</Size 6 /Root 1 0 R /Encrypt 5 0 R /ID [<00> <00>]>>\nstartxref\n${xref}\n%%EOF\n`;
    return latin1(out);
  };
  assert.deepEqual((await render(file("/Identity"))).at(50, 50), RED);
  // The same strings with the pages encrypted do need it.
  await assert.rejects(engine.open(file("/StdCF")), { code: "password-required" });
});

test("a form field with no appearance shows its background, border, value and caption", async () => {
  const dark = (page: Awaited<ReturnType<typeof render>>) => {
    let count = 0;
    for (let y = 0; y < page.height; y++) for (let x = 0; x < page.width; x++) if ((page.at(x, y)[1] ?? 255) < 100) count++;
    return count;
  };
  const box = "/Type /Annot /Subtype /Widget /Rect [10 40 90 60]";
  const filled = await render(annotated(`<<${box} /FT /Btn /Ff 65536 /MK <</BG [0 1 0] /BC [1 0 0] /CA (Go)>> /BS <</W 2>> /DA (/Nope 12 Tf 0 g)>>`));
  assert.deepEqual(filled.at(15, 50), GREEN, "background");
  assert.deepEqual(filled.at(10, 50), RED, "border");
  assert.ok(dark(filled) > 60, "border and caption");
  const value = await render(annotated(`<<${box} /FT /Tx /V (HHHH) /DA (/Nope 14 Tf 0 g)>>`));
  assert.ok(dark(value) > 30, `the value is drawn: ${dark(value)}`);
  const inheritedValue = await render(pdfOf({ content: "", objects: [`<<${box} /Parent 6 0 R>>`, "<</FT /Tx /V (HHHH) /DA (/Nope 14 Tf 0 g)>>"], pageExtra: "/Annots [5 0 R]" }));
  assert.ok(dark(inheritedValue) > 30, "from the field it belongs to");
  const secret = await render(annotated(`<<${box} /FT /Tx /Ff 8192 /V (HHHH) /DA (/Nope 14 Tf 0 g)>>`));
  assert.equal(dark(secret), 0, "a password field keeps its value");
});

test("Identity-H text in an embedded font of a known CJK collection reads through the collection", async () => {
  const font = fontWithBackwardLoca();
  const bytes = pdfOf({
    // CIDs 34 and 843 in Adobe-Japan1: A and あ. Without a ToUnicode map the codes mean nothing alone.
    content: "BT /F 20 Tf 0 50 Td <0022034B> Tj ET",
    resources: "/Font <</F 5 0 R>>",
    objects: [
      "<</Type /Font /Subtype /Type0 /BaseFont /T /Encoding /Identity-H /DescendantFonts [6 0 R]>>",
      "<</Type /Font /Subtype /CIDFontType2 /BaseFont /T /CIDSystemInfo <</Registry (Adobe) /Ordering (Japan1) /Supplement 7>> /CIDToGIDMap /Identity /DW 1000 /FontDescriptor 7 0 R>>",
      "<</Type /FontDescriptor /FontName /T /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 8 0 R>>",
      { dict: ` /Length1 ${font.length}`, data: font },
    ],
  });
  const doc = await engine.open(bytes);
  assert.equal(doc.text(0).text.trim(), "A\u3042");
  doc.close();
});

test("a predictor's parameters from a damaged file don't take the engine down", async () => {
  const data = deflateSync(Buffer.from("1 0 0 rg 0 0 100 100 re f")).toString("latin1");
  for (const parms of ["/Predictor 2 /Columns 0", "/Predictor 12 /Columns 0", "/Predictor 2 /Colors 0", "/Predictor 12 /Colors 32 /BitsPerComponent 8 /Columns 2", "/Predictor 2 /Columns 2147483647 /Colors 255 /BitsPerComponent 16", "/Predictor 12 /Columns 9007199254740991 /Colors 255"]) {
    const bytes = pdfOf({ content: "", objects: [] });
    const text = Buffer.from(bytes).toString("latin1").replace("<< /Length 0>>", `<< /Filter /FlateDecode /DecodeParms <<${parms}>> /Length ${data.length}>>`).replace("stream\n\nendstream", `stream\n${data}\nendstream`);
    const doc = await engine.open(latin1(text));
    doc.render(0, { width: 50 });
    doc.text(0);
    doc.close();
  }
});

test("a short dash along a very long line, or a huge dash offset, is bounded", async () => {
  for (const content of ["[0.01 0.01] 0 d 1 0 0 RG 4 w 0 50 m 100000000 50 l S", "[1 1] 100000000000 d 1 0 0 RG 4 w 0 50 m 100 50 l S"]) {
    const started = performance.now();
    const page = await render(pdfOf({ content }));
    assert.ok(performance.now() - started < 2000, content);
    assert.notDeepEqual(page.at(50, 49), [0, 0, 0], content);
    assert.notDeepEqual(page.at(50, 49), WHITE, content);
  }
});

test("a font whose table directory is damaged doesn't take the engine down", async () => {
  const good = fontWithBackwardLoca();
  const directory = 12;
  const records = Number(good.charCodeAt(5));
  for (let record = 0; record < records; record++) {
    for (const field of [8, 12]) {
      const at = directory + record * 16 + field;
      const font = `${good.slice(0, at)}\xff\xff\xff\xf0${good.slice(at + 4)}`;
      const doc = await engine.open(
        pdfOf({
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
      doc.text(0);
      doc.render(0, { width: 50 });
      doc.close();
    }
  }
});

test("a page the xref has lost is found by scanning the file", async () => {
  // The xref reads, and marks the page free. Every reference's engine still finds it.
  const body = pdfOf({ content: "1 0 0 rg 0 0 100 100 re f" });
  const text = Buffer.from(body).toString("latin1");
  const damaged = text.replace(/(xref\n0 \d+\n0000000000 65535 f \n\d{10} 00000 n \n\d{10} 00000 n \n\d{10}) 00000 n/, "$1 00000 f");
  assert.notEqual(damaged, text);
  const doc = await engine.open(latin1(damaged));
  assert.equal(doc.pageCount, 1);
  const { rgba } = doc.render(0, { width: 10 });
  assert.deepEqual([...rgba.subarray(0, 3)], RED);
  doc.close();
});

test("page labels follow the catalog's number tree", async () => {
  const pages = (n: number) => Array.from({ length: n }, (_, i) => `${5 + i} 0 R`).join(" ");
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  const bodies = [
    "<</Type /Catalog /Pages 2 0 R /PageLabels <</Nums [0 <</S /r>> 2 <</P (A-) /S /D /St 5>> 3 <</S /a /St 27>> 4 <</P (cover)>>]>>>>",
    `<</Type /Pages /Count 5 /Kids [${pages(5).replaceAll("5 0 R", "3 0 R").replaceAll("6 0 R", "4 0 R").replaceAll("7 0 R", "5 0 R").replaceAll("8 0 R", "6 0 R").replaceAll("9 0 R", "7 0 R")}]>>`,
    ...Array.from({ length: 5 }, () => "<</Type /Page /Parent 2 0 R /MediaBox [0 0 10 10]>>"),
  ];
  bodies.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<</Size ${bodies.length + 1} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  const doc = await engine.open(latin1(out));
  assert.deepEqual(doc.pageLabels(), ["i", "ii", "A-5", "aa", "cover"]);
  doc.close();
  const plain = await engine.open(pdfOf({ content: "" }));
  assert.equal(plain.pageLabels(), null);
  plain.close();
});

test("a page with no usable /MediaBox is Letter, or the valid box above it", async () => {
  const red = pdfOf({ content: "1 0 0 rg 0 0 50 50 re f" });
  const text = String.fromCharCode(...red);
  const box = "/MediaBox [0 0 100 100]";
  const opened = async (bytes: Uint8Array) => {
    const doc = await engine.open(bytes);
    const { width, height } = doc.pageInfo(0);
    doc.close();
    return [width, height];
  };
  for (const [name, replacement] of [
    ["missing", "/XediaBox [0 0 100 100]"],
    ["empty", "/MediaBox []           "],
    ["no area", "/MediaBox [0 0 100   0]"],
    ["all zero", "/MediaBox [0 0   0   0]"],
  ]) {
    const damaged = latin1(text.replace(box, replacement));
    assert.deepEqual(await opened(damaged), [612, 792], name);
    const page = await render(damaged, 612);
    assert.deepEqual(page.at(10, 780), RED, `${name}: the content is drawn`);
  }
  assert.deepEqual(await opened(red), [100, 100], "a good box is left alone");
});

test("a page tree whose kids are all lost falls back to the pages the file holds", async () => {
  const text = String.fromCharCode(...pdfOf({ content: "1 0 0 rg 0 0 100 100 re f" }));
  const lost = text.replace("/Kids [3 0 R]", "/Kids [9 0 R]");
  assert.notEqual(lost, text);
  const doc = await engine.open(latin1(lost));
  assert.equal(doc.pageCount, 1);
  doc.close();
  assert.deepEqual((await render(latin1(lost))).at(50, 50), RED);
});

test("a one-row image under a TIFF predictor is drawn", async () => {
  // 4 RGB pixels, each the previous plus red, deflated with /Predictor 2: the data is exactly one row.
  const row = Uint8Array.from([255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const packed = deflateSync(row);
  const image = `<</Type/XObject/Subtype/Image/Width 4/Height 1/BitsPerComponent 8/ColorSpace/DeviceRGB/Filter/FlateDecode/DecodeParms<</Predictor 2/Colors 3/Columns 4>>/Length ${packed.length}>>\nstream\n${String.fromCharCode(...packed)}\nendstream`;
  const page = await render(
    pdfOf({ content: "100 0 0 100 0 0 cm /I Do", resources: "/XObject <</I 5 0 R>>", objects: [image] }),
  );
  assert.deepEqual(page.at(50, 50), RED);
});

test("what a page's annotations with no appearance can draw is bounded in total", async () => {
  // A squiggle of 4,096 steps from 8 numbers, in a list too short for a cap per list to catch.
  const quad = "0 10 9000 10 0 0 9000 0";
  const annot = `<</Subtype/Squiggly/Rect[0 0 100 100]/QuadPoints[${Array(40_000).fill(quad).join(" ")}]>>`;
  const doc = await engine.open(pdfOf({ content: "", pageExtra: `/Annots[${annot}]` }));
  const before = process.memoryUsage().rss;
  doc.render(0, { width: 100 });
  doc.close();
  assert.ok(process.memoryUsage().rss - before < 1e9, "stays under a gigabyte");
});

test("forms nested a few levels deep and used many times are all drawn", async () => {
  // A budget for streams that multiply mustn't reach a real page: a group of 2,000 symbols, each a form.
  const form = (resources: string, data: string) =>
    `<</Type/XObject/Subtype/Form/BBox[0 0 100 100]/Resources<<${resources}>>/Length ${data.length}>>\nstream\n${data}\nendstream`;
  const page = await render(
    pdfOf({
      content: "/G Do",
      resources: "/XObject <</G 5 0 R>>",
      objects: [
        form("/XObject<</S 6 0 R>>", `${"q 1 0 0 1 0 0 cm /S Do Q\n".repeat(2000)}`),
        form("/XObject<</T 7 0 R>>", "/T Do"),
        form("", "1 0 0 rg 0 0 100 100 re f"),
      ],
    }),
  );
  assert.deepEqual(page.at(50, 50), RED);
});

test("planted /Identity names don't open a file of a version that has no crypt filters", async () => {
  const hash = "00".repeat(32);
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  [
    "<</Type /Catalog /Pages 2 0 R>>",
    "<</Type /Pages /Count 1 /Kids [3 0 R]>>",
    "<</Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R>>",
    "<</Length 24>>\nstream\n1 0 0 rg 0 0 100 100 re f\nendstream",
    `<</Filter /Standard /V 1 /R 2 /P -4 /O <${hash}> /U <${hash}> /StmF /Identity /StrF /Identity>>`,
  ].forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<</Size 6 /Root 1 0 R /Encrypt 5 0 R /ID [<00> <00>]>>\nstartxref\n${xref}\n%%EOF\n`;
  await assert.rejects(engine.open(latin1(out)), { code: "password-required" });
});

test("an annotation's /OC can be a direct membership dictionary", async () => {
  const stamp = (oc: string) => `<</Type /Annot /Subtype /Square /Rect [0 0 100 100] /IC [1 0 0] /OC ${oc}>>`;
  const page = (oc: string) =>
    render(
      pdfOf({
        content: "",
        pageExtra: `/Annots [${stamp(oc)}]`,
        catalogExtra: "/OCProperties <</OCGs [5 0 R 6 0 R] /D <</OFF [6 0 R]>>>>",
        objects: ["<</Type /OCG /Name (On)>>", "<</Type /OCG /Name (Off)>>"],
      }),
    );
  assert.deepEqual((await page("<</Type /OCMD /OCGs [6 0 R]>>")).at(50, 50), WHITE);
  assert.deepEqual((await page("<</Type /OCMD /OCGs [5 0 R]>>")).at(50, 50), RED);
});
