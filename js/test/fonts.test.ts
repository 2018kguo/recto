// A char's horizontal scale and a run's matrix, and the fonts a page's text uses with their programs,
// through the public API, on a thread and on a pool. The pool starts from the built package.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";
import zlib from "node:zlib";

import { createPdfPool } from "../dist/index.js";
import { createPdfEngine, type PdfFontInfo } from "../src/index.ts";

const engine = await createPdfEngine();
const encoder = new TextEncoder();
const here = (path: string) => new URL(path, import.meta.url);

/** A PDF from objects (object 1 is the catalog), each a string or the bytes of one. */
function pdfOf(objects: (string | Uint8Array)[]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [encoder.encode("%PDF-1.7\n")];
  let length = parts[0]!.length;
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    parts.push(bytes);
    length += bytes.length;
  };
  const offsets = objects.map((body, i) => {
    const at = length;
    push(`${i + 1} 0 obj\n`);
    push(body);
    push("\nendobj\n");
    return at;
  });
  const xref = length;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const at of offsets) push(`${String(at).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(parts));
}

function stream(dict: string, data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return Buffer.concat([encoder.encode(`<< ${dict} /Length ${bytes.length} >>\nstream\n`), bytes, encoder.encode("\nendstream")]);
}

const page = (resources: string, contents: string) => [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << ${resources} >> >>`,
  stream("", contents),
];

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("each char's Tz over 100, kept across BT and restored by Q, and each run's text rendering matrix", async () => {
  using doc = await engine.open(
    pdfOf([
      ...page(
        "/Font << /F1 5 0 R >>",
        "BT /F1 10 Tf 10 90 Td (a) Tj ET BT 50 Tz 10 75 Td (b) Tj 200 Tz 30 0 Td (c) Tj ET " +
          "BT 10 60 Td (d) Tj ET q 50 Tz BT 10 45 Td (e) Tj ET Q BT 10 30 Td (f) Tj ET " +
          "100 Tz BT 1 0 0.5 1 10 15 Tm (g) Tj ET"
      ),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ])
  );
  const text = doc.text(0);
  const at = (s: string) => text.text.indexOf(s);
  assert.deepEqual(["a", "b", "c", "d", "e", "f", "g"].map((s) => text.hScales[at(s)]), [1, 0.5, 2, 2, 0.5, 2, 1]);
  const matrix = (s: string) => {
    const run = text.runIds[at(s)]!;
    return [...text.runs.matrices.subarray(6 * run, 6 * run + 6)];
  };
  assert.deepEqual(matrix("b"), [5, 0, 0, -10, 10, 25]);
  assert.deepEqual(matrix("g"), [10, 0, 5, -10, 10, 85]);
  assert.equal(text.runs.matrices.length, 6 * text.runs.count);
});

const ttf = fs.readFileSync(here("../wasm/cjk-fallback.ttf"));
const pfb = fs.readFileSync(here("../wasm/FoxitSans.pfb"));
const cff = fs.readFileSync(here("../../crates/recto/src/notdef.cff"));

const fontsPdf = () =>
  pdfOf([
    ...page(
      "/Font << /TT 5 0 R /CF 8 0 R /HV 11 0 R /T0 12 0 R /T3 16 0 R /T1 18 0 R >>",
      "BT /TT 10 Tf 5 90 Td (A) Tj ET BT /CF 10 Tf 5 80 Td (A) Tj ET BT /HV 10 Tf 5 70 Td (Hel) Tj ET " +
        "BT /T0 10 Tf 5 60 Td <07D0> Tj ET BT /T3 10 Tf 5 50 Td (A) Tj ET BT /T1 10 Tf 5 40 Td (S) Tj ET"
    ),
    // 5: a subset TrueType font, its program deflated.
    "<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Probe /FirstChar 65 /LastChar 65 /Widths [600] /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>",
    "<< /Type /FontDescriptor /FontName /ABCDEF+Probe /Flags 96 /ItalicAngle -10 /FontWeight 400 /FontFile2 7 0 R >>",
    stream("/Filter /FlateDecode", zlib.deflateSync(ttf)),
    // 8: CFF.
    "<< /Type /Font /Subtype /Type1 /BaseFont /CffProbe-Bold /FirstChar 65 /LastChar 65 /Widths [500] /FontDescriptor 9 0 R >>",
    "<< /Type /FontDescriptor /FontName /CffProbe-Bold /Flags 32 /ItalicAngle 0 /FontFile3 10 0 R >>",
    stream("/Subtype /Type1C", cff),
    // 11: not embedded.
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    // 12: a CID font.
    "<< /Type /Font /Subtype /Type0 /BaseFont /CJK /Encoding /Identity-H /DescendantFonts [13 0 R] /ToUnicode 15 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /CJK /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 14 0 R /CIDToGIDMap /Identity >>",
    "<< /Type /FontDescriptor /FontName /CJK /Flags 4 /ItalicAngle 0 /FontFile2 7 0 R >>",
    stream(
      "",
      "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /U def 1 begincodespacerange <0000> <FFFF> endcodespacerange " +
        "1 beginbfchar <07D0> <4E2D> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end"
    ),
    // 16: Type 3.
    "<< /Type /Font /Subtype /Type3 /Name /Stamp /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /A 17 0 R >> " +
      "/Encoding << /Type /Encoding /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [1000] /Resources << >> >>",
    stream("", "1000 0 0 0 1000 1000 d1 0 0 1000 1000 re f"),
    // 18: Type 1.
    "<< /Type /Font /Subtype /Type1 /BaseFont /SansProbe /FirstChar 83 /LastChar 83 /Widths [600] /FontDescriptor 19 0 R >>",
    "<< /Type /FontDescriptor /FontName /SansProbe /Flags 32 /ItalicAngle 0 /FontFile 20 0 R >>",
    stream("", pfb),
  ]);

/** What the fonts must say, by name, whichever thread listed them. */
function checkFonts(fonts: PdfFontInfo[], textFonts: { name: string }[]) {
  assert.deepEqual(fonts.map((f) => f.name), textFonts.map((f) => f.name));
  fonts.forEach((f, i) => assert.equal(f.id, i));
  const font = (name: string) => fonts.find((f) => f.name === name)!;
  const tt = font("Probe");
  assert.deepEqual(
    { baseFont: tt.baseFont, subset: tt.subset, subtype: tt.subtype, kind: tt.kind, program: tt.program, italic: tt.italic, bold: tt.bold, flags: tt.flags, italicAngle: tt.italicAngle, weight: tt.weight },
    { baseFont: "ABCDEF+Probe", subset: true, subtype: "TrueType", kind: "truetype", program: { id: "7 0", file: "FontFile2", subtype: null }, italic: true, bold: false, flags: 96, italicAngle: -10, weight: 400 }
  );
  const a = tt.codes.codes.indexOf(65);
  assert.equal(tt.codes.unicode[a], "A");
  assert.ok(tt.codes.glyphs[a]! > 0, "the program's glyph for A");
  assert.deepEqual([font("CffProbe-Bold").kind, font("CffProbe-Bold").program?.subtype, font("CffProbe-Bold").bold], ["cff", "Type1C", true]);
  const hv = font("Helvetica");
  assert.deepEqual([hv.embedded, hv.kind, hv.program, hv.flags, hv.weight], [false, null, null, null, null]);
  assert.equal(hv.codes.glyphs[hv.codes.codes.indexOf(72)], -1);
  const cjk = font("CJK");
  assert.deepEqual([cjk.subtype, cjk.cidSubtype, cjk.encoding, cjk.toUnicode, cjk.kind, cjk.program?.id], ["Type0", "CIDFontType2", "Identity-H", true, "truetype", "7 0"]);
  assert.deepEqual([[...cjk.codes.codes], [...cjk.codes.glyphs], cjk.codes.unicode], [[0x07d0], [2000], ["中"]]);
  const t3 = font("Stamp");
  assert.deepEqual([t3.kind, t3.program, t3.embedded, t3.codes.unicode], ["type3", null, true, ["A"]]);
  assert.deepEqual([font("SansProbe").kind, font("SansProbe").program?.file], ["type1", "FontFile"]);
}

test("fonts lists each font of the page's text, in its order, and fontProgram gives each program as its stream decodes", async () => {
  using doc = await engine.open(fontsPdf());
  const text = doc.text(0);
  const fonts = doc.fonts(0);
  checkFonts(fonts, text.fonts);
  // Joined by the text's font ids.
  assert.equal(fonts[text.fontIds[text.text.indexOf("中")]!]!.name, "CJK");
  assert.equal(sha(doc.fontProgram("7 0")!), sha(ttf), "the deflated program, inflated");
  assert.equal(sha(doc.fontProgram("10 0")!), sha(cff));
  assert.equal(sha(doc.fontProgram("20 0")!), sha(pfb));
  assert.equal(doc.fontProgram("99 0"), null);
  assert.equal(doc.fontProgram("nonsense"), null);
  assert.throws(() => doc.fontProgram(7 as never), TypeError);
  assert.deepEqual(doc.text(0), text, "listing fonts changes nothing the text reads");
});

test("a pool lists the same fonts and gives the same bytes, on any of its threads", async () => {
  const bytes = fontsPdf();
  using single = await engine.open(bytes);
  using pool = await createPdfPool({ threads: 2 });
  await using doc = await pool.open(bytes);
  const [fonts, program, text] = await Promise.all([doc.fonts(0), doc.fontProgram("7 0"), doc.text(0)]);
  checkFonts(fonts, text.fonts);
  assert.deepEqual(fonts, single.fonts(0));
  assert.equal(sha(program!), sha(ttf));
  assert.deepEqual(text.hScales, single.text(0).hScales);
});
