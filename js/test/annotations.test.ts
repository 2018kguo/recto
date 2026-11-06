// Annotation text and form fields through the public API.

import assert from "node:assert/strict";
import { test } from "node:test";

import { PDFDocument } from "pdf-lib";

import { createPdfEngine } from "../src/index.ts";
import { cpuMsPerCallWithin, threadCpuMs } from "./cpu-time.ts";

const encoder = new TextEncoder();
const engine = await createPdfEngine();

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

/** One stamp whose appearance paints `text` in one Tj. */
function stampPdf(text: string): Uint8Array {
  const ap = `BT /F1 1 Tf 0 0 Td (${text}) Tj ET`;
  return pdfOf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R] /Resources << >> >>",
    "<< /Type /Annot /Subtype /Stamp /Rect [10 10 200 100] /AP << /N 5 0 R >> >>",
    `<< /Type /XObject /Subtype /Form /BBox [0 0 190 90] /Resources << /Font << /F1 6 0 R >> >> /Length ${ap.length} >>\nstream\n${ap}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

test("appearance text reads exactly, in time linear in its length", async () => {
  const doc = await engine.open(stampPdf("APPROVED (by) \\\\ QA"));
  assert.equal(doc.annotations(0)[0]?.appearanceText, "APPROVED (by) \\ QA");
  doc.close();

  const stamped = async (words: number) => {
    const text = "a ".repeat(words);
    const big = await engine.open(stampPdf(text));
    return { big, read: () => big.annotations(0) };
  };
  const short = await stamped(2000);
  const long = await stamped(16_000);
  // 8x the words: linear is 8, a quadratic 64.
  const bound = 22;
  const [large, small] = cpuMsPerCallWithin(bound, long.read, short.read);
  short.big.close();
  long.big.close();
  assert.ok(large < small * bound, `${small} ms -> ${large} ms`);
});

test("form field values, inherited through /Parent", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  const field = pdf.getForm().createTextField("applicant.name");
  field.setText("Ada Lovelace");
  field.addToPage(page, { x: 20, y: 300, width: 200, height: 24 });
  const doc = await engine.open(await pdf.save());
  const [annotation] = doc.annotations(0);
  doc.close();
  assert.deepEqual(annotation?.field, { type: "Tx", value: "Ada Lovelace" });
});

test("a deep /Parent chain is followed in bounded time", async () => {
  const depth = 20_000;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R] >>",
    "<< /Type /Annot /Subtype /Widget /Rect [0 0 10 10] /T (w) /Parent 5 0 R >>",
  ];
  for (let i = 0; i < depth; i++) {
    const parent = i + 1 < depth ? ` /Parent ${6 + i} 0 R` : "";
    objects.push(`<< /T (n${i})${parent} >>`);
  }
  const doc = await engine.open(pdfOf(objects));
  const started = threadCpuMs();
  const [annotation] = doc.annotations(0);
  const elapsed = threadCpuMs() - started;
  doc.close();
  assert.equal(annotation?.subtype, 20);
  assert.ok(elapsed < 500, `${elapsed.toFixed(0)} ms`);
});
