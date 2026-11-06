// A subset of the Apache-2.0 Droid font; its notice is in assets/cjk-fallback.NOTICE.
// Requires fontkit and pdf-lib.
// node js/test/fixtures/make-cjk-embedded.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";

import { create } from "fontkit";
import { PDFDocument } from "pdf-lib";

const pdf = await PDFDocument.create();
pdf.setCreationDate(new Date(0));
pdf.setModificationDate(new Date(0));
pdf.registerFontkit({
  create(bytes) {
    const font = create(bytes);
    const subset = font.createSubset();
    subset.encodeStream = () => Readable.from([subset.encode()]);
    font.createSubset = () => subset;
    return font;
  },
});
const data = readFileSync(
  new URL("../../../assets/cjk-fallback.ttf", import.meta.url)
);
assert.equal(
  createHash("sha256").update(data).digest("hex"),
  "8a4dea0899424438af25a6f1f6eb61e5d111d85367eece0a5d30170861ae6b2e"
);
const font = await pdf.embedFont(data, { subset: true });
pdf
  .addPage([612, 792])
  .drawText("中文日本한국", { x: 72, y: 700, size: 24, font });
writeFileSync(new URL("cjk-embedded.pdf", import.meta.url), await pdf.save());
