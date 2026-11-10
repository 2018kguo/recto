import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { degrees, PDFDocument } from "pdf-lib";

import { createPdfEngine } from "../src/index.ts";

test("native ActualText parentheses retain semantic Unicode in RTL", async () => {
  // Chromium with an embedded DejaVu Sans subset, source: הסכם ABC 123 בתוקף (2026).
  const source = await PDFDocument.load(
    readFileSync(new URL("fixtures/chrome-mixed-rtl.pdf", import.meta.url))
  );
  const pdf = await PDFDocument.create();
  for (const rotation of [0, 90, 180, 270]) {
    const [page] = await pdf.copyPages(source, [0]);
    assert.ok(page);
    page.setRotation(degrees(rotation));
    pdf.addPage(page);
  }
  const engine = await createPdfEngine();
  const doc = await engine.open(await pdf.save());
  try {
    for (let index = 0; index < 4; index++) {
      const text = doc.text(index).text;
      assert.ok(text.includes("בתוקף (2026)"));
      // "ABC 123" was laid out as one LTR run, the Arabic line's "123" and
      // "ABC" as two: each reads back in its source order.
      assert.ok(text.includes("הסכם ABC 123 בתוקף (2026)"), text);
      assert.ok(text.includes("هذه الاتفاقية 123 ABC سارية"), text);
    }
  } finally {
    doc.close();
  }
});

/**
 * One page of lines drawn left to right as their pieces, one text-showing
 * operator each, in Courier (every glyph 600 units) with a ToUnicode CMap
 * that gives each byte the char it stands for: right-to-left text drawn in
 * visual order, as a browser prints it.
 */
function visualLinesPdf(lines: string[][]): Uint8Array {
  const chars = [...new Set(lines.flat().join(""))];
  const code = new Map(chars.map((c, i) => [c, 0x21 + i]));
  const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, "0");
  const cmap = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CMapName /Visual def /CMapType 2 def",
    "1 begincodespacerange <00> <FF> endcodespacerange",
    `${chars.length} beginbfchar`,
    ...chars.map((c) => `<${hex(code.get(c) ?? 0, 2)}> <${hex(c.codePointAt(0) ?? 0, 4)}>`),
    "endbfchar endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
  const content = lines
    .map((pieces, i) => {
      let x = 72;
      return pieces
        .map((piece) => {
          const glyphs = [...piece].map((c) => hex(code.get(c) ?? 0, 2)).join("");
          const op = `BT /F1 12 Tf 1 0 0 1 ${x} ${700 - 20 * i} Tm <${glyphs}> Tj ET`;
          x += 7.2 * [...piece].length;
          return op;
        })
        .join("\n");
    })
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /ToUnicode 6 0 R >>",
    `<< /Length ${new TextEncoder().encode(cmap).length} >>\nstream\n${cmap}\nendstream`,
  ];
  let body = "%PDF-1.7\n";
  const offsets = objects.map((object, i) => {
    const offset = new TextEncoder().encode(body).length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = new TextEncoder().encode(body).length;
  const rows = offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows.join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

test("an RTL line's number and Latin word read in logical order, as they were laid out", async () => {
  // Drawn as a browser prints them: left to right, a text-showing operator
  // per bidi run. "هذه الاتفاقية 123 ABC سارية" puts ABC left of 123 on the
  // page, but the two are separate LTR runs and read right to left. Where one
  // operator drew "ABC 123" it was one LTR run (the number after the word).
  const doc = await createPdfEngine().then((engine) =>
    engine.open(
      visualLinesPdf([
        ["ةيراس", " ", "ABC", " ", "123", " ", "ةيقافتالا هذه"],
        ["ףקותב ", "ABC 123", " םכסה"],
        ["(2026) ", "ףקותב", " ", "ABC", " ", "50%", " ", "םכסה"],
        ["Left ABC 123 ", "םולש", " right."],
      ])
    )
  );
  try {
    assert.equal(
      doc.text(0).text.replaceAll("\r\n", "\n"),
      [
        "هذه الاتفاقية 123 ABC سارية",
        "הסכם ABC 123 בתוקף",
        "הסכם 50% ABC בתוקף (2026)",
        "Left ABC 123 שלום right.",
      ].join("\n")
    );
  } finally {
    doc.close();
  }
});
