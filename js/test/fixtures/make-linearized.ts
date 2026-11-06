// Writes __fixtures__/linearized.pdf: a small linearized ("fast web view")
// file with a form field, rotated and odd-sized pages and Flate content.
// pdf-lib cannot linearize, so qpdf does that step:
//
//   node js/test/fixtures/make-linearized.ts
//
// Needs qpdf on PATH (qpdf 12.4.2 made the checked-in file).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { degrees, PDFDocument, StandardFonts } from "pdf-lib";

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 6; i++) {
  const page = pdf.addPage([612 - i * 10, 792 + i * 7]);
  page.setRotation(degrees((i % 4) * 90));
  for (let line = 0; line < 30; line++) {
    page.drawText(`Page ${i + 1}, line ${line + 1}: linearized fixture`, {
      x: 40,
      y: 740 - line * 20,
      size: 11,
      font,
    });
  }
}
const field = pdf.getForm().createTextField("applicant");
field.addToPage(pdf.getPage(0), { x: 40, y: 60, width: 300, height: 24 });
field.setText("Filled value");

const dir = mkdtempSync(path.join(tmpdir(), "linearized-"));
try {
  const plain = path.join(dir, "plain.pdf");
  writeFileSync(plain, await pdf.save({ useObjectStreams: false }));
  execFileSync("qpdf", [
    "--linearize",
    "--deterministic-id",
    plain,
    new URL("linearized.pdf", import.meta.url).pathname,
  ]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
