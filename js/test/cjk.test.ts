// Predefined CJK CMaps come from wasm/cmaps.deflate and CJK glyphs from
// wasm/cjk-fallback.ttf, each read only when a document needs it.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";

import { createPdfEngine } from "../src/index.ts";
import { syntheticPdf } from "./synthetic-pdf.ts";

const encoder = new TextEncoder();

/**
 * One page per CID set, each a non-embedded CID font on a legacy-encoding
 * CMap with no ToUnicode, so text needs both the CMap (code -> CID) and the
 * set's CID -> Unicode table. GBK-EUC-V also follows its use-offset chain
 * to GBK-EUC-H.
 */
const PAGES = [
  { cmap: "GBK-EUC-V", ordering: "GB1", hex: "D6D0CEC4", text: "中文" },
  { cmap: "ETen-B5-H", ordering: "CNS1", hex: "A4A4A4E5", text: "中文" },
  { cmap: "90ms-RKSJ-H", ordering: "Japan1", hex: "93FA967B", text: "日本" },
  { cmap: "KSC-EUC-H", ordering: "Korea1", hex: "C7D1B1B9", text: "한국" },
];

function cjkPdf(): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  const kids = PAGES.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  add(`<< /Type /Pages /Kids [${kids}] /Count ${PAGES.length} >>`);
  for (const [i, page] of PAGES.entries()) {
    const id = 3 + i * 3;
    const content = `BT /F1 24 Tf 72 700 Td <${page.hex}> Tj ET`;
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`
    );
    add(
      `<< /Type /Font /Subtype /Type0 /BaseFont /CJK /Encoding /${page.cmap} /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /CJK /CIDSystemInfo << /Registry (Adobe) /Ordering (${page.ordering}) /Supplement 2 >> /FontDescriptor << /Type /FontDescriptor /FontName /CJK /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >> >>] >>`
    );
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
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

/** A directory of the package's assets without those named, for assetBase. */
function assetsWithout(...missing: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "recto-assets-"));
  for (const name of ["recto.wasm", "recto-text.wasm", "fonts.bin", "cjk-fallback.ttf", "cmaps.deflate"]) {
    if (!missing.includes(name)) {
      copyFileSync(new URL(`../wasm/${name}`, import.meta.url), join(dir, name));
    }
  }
  return dir;
}

test("nonembedded Chinese, Japanese and Korean have visible glyphs", async () => {
  // Poppler 22.02.0, with only assets/cjk-fallback.ttf visible to fontconfig, on the file
  // whose hash this checks: an oracle that shares no code with the engine.
  assert.equal(
    createHash("sha256").update(cjkPdf()).digest("hex"),
    "9e9ae1a982470d28c7aba205e46ce963ec8b7796c45092d1a3c72465d0700c2e"
  );
  const expected = gunzipSync(
    await readFile(
      new URL("fixtures/cjk-fallback-poppler.gray.gz", import.meta.url)
    )
  );
  assert.equal(expected.length, 4 * 612 * 792);
  const engine = await createPdfEngine();
  const doc = await engine.open(cjkPdf());
  try {
    for (const [page, { text }] of PAGES.entries()) {
      const bitmap = doc.render(page, { width: 612 });
      let ink = 0;
      for (let i = 0; i < bitmap.rgba.length; i += 4) {
        if ((bitmap.rgba[i] ?? 255) < 128) {
          ink += 1;
        }
      }
      assert.ok(
        ink > 100,
        `${text} must have visible glyphs, got ${ink} dark pixels`
      );
      const truth = expected.subarray(page * 612 * 792, (page + 1) * 612 * 792);
      const actual = Uint8Array.from(
        { length: 612 * 792 },
        (_, i) => bitmap.rgba[i * 4] ?? 255
      );
      // Require both shape precision and recall. A blank page, tofu, or the
      // wrong script fails; allow one pixel of rasterizer/hinting difference.
      for (const [from, to] of [
        [truth, actual],
        [actual, truth],
      ] as const) {
        let dark = 0;
        let matched = 0;
        for (let y = 0; y < 792; y += 1) {
          for (let x = 0; x < 612; x += 1) {
            if ((from[y * 612 + x] ?? 255) >= 128) {
              continue;
            }
            dark += 1;
            let found = false;
            for (let dy = -1; dy <= 1; dy += 1) {
              for (let dx = -1; dx <= 1; dx += 1) {
                if (
                  x + dx >= 0 &&
                  x + dx < 612 &&
                  y + dy >= 0 &&
                  y + dy < 792 &&
                  (to[(y + dy) * 612 + x + dx] ?? 255) < 128
                ) {
                  found = true;
                }
              }
            }
            if (found) {
              matched += 1;
            }
          }
        }
        assert.ok(
          matched / dark >= 0.85,
          `${text} shape overlap ${matched}/${dark}`
        );
      }
    }
  } finally {
    doc.close();
  }
});

test("CJK assets are lazy: a document that does not need one never reads it", async () => {
  const engine = await createPdfEngine({
    assetBase: assetsWithout("cjk-fallback.ttf", "cmaps.deflate"),
  });
  const latin = await engine.open(syntheticPdf({ pages: 1, charsPerPage: 80 }));
  latin.text(0);
  latin.render(0, { width: 612 });
  latin.close();
});

test("Unicode extraction alone needs no glyph font", async () => {
  const engine = await createPdfEngine({ assetBase: assetsWithout("cjk-fallback.ttf") });
  const doc = await engine.open(cjkPdf());
  try {
    assert.deepEqual(
      PAGES.map((_, i) => doc.text(i).text.trim()),
      PAGES.map((p) => p.text)
    );
  } finally {
    doc.close();
  }
});

test("a recycled instance keeps the CJK asset loader and old documents stay valid", async () => {
  const engine = await createPdfEngine({ recycleAboveBytes: 1 });
  const old = await engine.open(cjkPdf());
  const pixels = old.render(2, { width: 612 }).rgba;
  const fresh = await engine.open(cjkPdf());
  try {
    assert.ok(engine.stats().generation >= 1);
    assert.deepEqual(fresh.render(2, { width: 612 }).rgba, pixels);
    assert.deepEqual(old.render(2, { width: 612 }).rgba, pixels);
  } finally {
    fresh.close();
    old.close();
  }
});

test("embedded CJK glyphs do not load or depend on the fallback asset", async () => {
  const engine = await createPdfEngine({ assetBase: assetsWithout("cjk-fallback.ttf") });
  const doc = await engine.open(
    await readFile(new URL("fixtures/cjk-embedded.pdf", import.meta.url))
  );
  try {
    assert.equal(doc.text(0).text.trim(), "中文日本한국");
    const bitmap = doc.render(0, { width: 612 });
    let ink = 0;
    for (let i = 0; i < bitmap.rgba.length; i += 4) {
      if ((bitmap.rgba[i] ?? 255) < 128) {
        ink += 1;
      }
    }
    assert.ok(ink > 500);
  } finally {
    doc.close();
  }
});

test("missing Identity-H fonts render CJK from their ToUnicode map", async () => {
  const source = await readFile(
    new URL("fixtures/cjk-embedded.pdf", import.meta.url)
  );
  const pdf = await PDFDocument.load(source);
  const fonts = pdf
    .getPage(0)
    .node.Resources()
    ?.lookup(PDFName.of("Font"), PDFDict);
  assert.ok(fonts);
  const name = fonts.keys()[0];
  assert.ok(name);
  const font = fonts.lookup(name, PDFDict);
  const cid = font
    .lookup(PDFName.of("DescendantFonts"), PDFArray)
    .lookup(0, PDFDict);
  cid
    .lookup(PDFName.of("FontDescriptor"), PDFDict)
    .delete(PDFName.of("FontFile2"));
  const engine = await createPdfEngine();
  const embedded = await engine.open(source);
  const missing = await engine.open(await pdf.save());
  try {
    assert.equal(missing.text(0).text.trim(), "中文日本한국");
    const drawn = missing.render(0, { width: 612 }).rgba;
    const reference = embedded.render(0, { width: 612 }).rgba;
    // The same Droid glyphs, from the full font instead of the embedded
    // subset: hinting moves under 0.1% of bytes.
    let differing = 0;
    for (let i = 0; i < drawn.length; i++) {
      differing += drawn[i] === reference[i] ? 0 : 1;
    }
    assert.ok(differing < drawn.length / 1000, `${differing} bytes differ`);
  } finally {
    embedded.close();
    missing.close();
  }
});

test("CJK CMaps map codes to Unicode, and a file with a wrong one is refused", async () => {
  const engine = await createPdfEngine();
  const doc = await engine.open(cjkPdf());
  const texts = PAGES.map((_, i) => doc.text(i).text.trim());
  doc.close();
  assert.deepEqual(
    texts,
    PAGES.map((page) => page.text)
  );

  const dir = assetsWithout();
  writeFileSync(join(dir, "cmaps.deflate"), "not the CMaps");
  const tampered = await createPdfEngine({ assetBase: dir });
  const bad = await tampered.open(cjkPdf());
  assert.throws(() => bad.text(0), { code: "missing-asset", message: /cmaps\.deflate/u });
  bad.close();
  // The refusal retired that instance; the next open gets a fresh one, and a repaired
  // directory reads.
  assert.equal(tampered.stats().generation, 0);
  copyFileSync(new URL("../wasm/cmaps.deflate", import.meta.url), join(dir, "cmaps.deflate"));
  const latin = await tampered.open(syntheticPdf({ pages: 1 }));
  assert.equal(tampered.stats().generation, 1);
  latin.close();
});
