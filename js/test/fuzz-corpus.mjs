// Small generated PDFs with a little of everything, for damaging. Fonts, images, masks, patterns,
// shadings, annotations and object streams, so that a damaged byte lands somewhere that parses it.
import { deflateSync } from "node:zlib";

import { pdfOf, transparencyCases } from "./transparency-cases.mjs";

const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");

function trueTypeFont() {
  const be16 = (v) => String.fromCharCode((v >> 8) & 255, v & 255);
  const be32 = (v) => be16(v >>> 16) + be16(v & 0xffff);
  const square = be16(1) + be16(0) + be16(0) + be16(500) + be16(500) + be16(3) + be16(0) + "\x01\x01\x01\x01" + be16(0) + be16(0) + be16(500) + be16(0) + be16(0) + be16(500) + be16(0) + be16(-500 & 0xffff);
  const glyph = square + (square.length % 2 ? "\0" : "");
  const tables = {
    glyf: glyph + glyph,
    head: be32(0x10000) + be32(0) + be32(0) + be32(0x5f0f3cf5) + be16(0) + be16(1000) + "\0".repeat(16) + be16(0) + be16(0) + be16(1000) + be16(1000) + be16(0) + be16(8) + be16(2) + be16(1) + be16(0),
    hhea: be32(0x10000) + be16(800) + be16(-200 & 0xffff) + be16(0) + be16(1000) + "\0".repeat(22) + be16(3),
    hmtx: (be16(1000) + be16(0)).repeat(3),
    loca: be32(glyph.length) + be32(glyph.length) + be32(0) + be32(glyph.length),
    maxp: be32(0x10000) + be16(3) + be16(8) + be16(1) + "\0".repeat(22),
  };
  const names = Object.keys(tables).sort();
  let offset = 12 + names.length * 16;
  let directory = be32(0x10000) + be16(names.length) + be16(0) + be16(0) + be16(0);
  let body = "";
  for (const name of names) {
    const table = tables[name];
    directory += name + be32(0) + be32(offset) + be32(table.length);
    const aligned = table + "\0".repeat((4 - (table.length % 4)) % 4);
    body += aligned;
    offset += aligned.length;
  }
  return directory + body;
}

export function seedCorpus() {
  const flate = (text) => latin1(deflateSync(Buffer.from(text, "latin1")));
  const font = trueTypeFont();
  const pixels = "\xff\0\0\0\xff\0\0\0\xff\xff\xff\0".repeat(16);
  const cases = {
    standardFonts: pdfOf({ content: "BT /F 12 Tf 10 50 Td (Some text) Tj [(ki)-20(ng)] TJ ET BT /S 12 Tf 10 30 Td (abc) Tj ET", resources: "/Font <</F <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>> /S <</Type /Font /Subtype /Type1 /BaseFont /Symbol>>>>" }),
    embeddedFont: pdfOf({
      content: "BT /F 40 Tf 0 10 Td <00010002> Tj ET",
      resources: "/Font <</F 5 0 R>>",
      objects: [
        "<</Type /Font /Subtype /Type0 /BaseFont /T /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 9 0 R>>",
        "<</Type /Font /Subtype /CIDFontType2 /BaseFont /T /CIDSystemInfo <</Registry (Adobe) /Ordering (Japan1) /Supplement 0>> /CIDToGIDMap /Identity /DW 1000 /W [0 [500 600] 1 2 700] /FontDescriptor 7 0 R>>",
        "<</Type /FontDescriptor /FontName /T /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 8 0 R>>",
        { dict: ` /Length1 ${font.length}`, data: font },
        { dict: "", data: "1 begincodespacerange <0000> <ffff> endcodespacerange 1 beginbfrange <0001> <0002> <0041> endbfrange" },
      ],
    }),
    images: pdfOf({
      content: "q 40 0 0 40 5 5 cm /I Do Q q 40 0 0 40 50 5 cm /M Do Q q 30 0 0 30 5 60 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \0\xff\xff\0 EI Q",
      resources: "/XObject <</I 5 0 R /M 6 0 R>>",
      objects: [
        { dict: " /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms <</Predictor 15 /Colors 3 /Columns 4>> /SMask 7 0 R", data: flate(Array.from({ length: 4 }, () => `\x01${pixels.slice(0, 12)}`).join("")) },
        { dict: " /Type /XObject /Subtype /Image /Width 8 /Height 2 /ImageMask true /BitsPerComponent 1", data: "\xaa\x55" },
        { dict: " /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8", data: "\xff\x80\x40\0" },
      ],
    }),
    colours: pdfOf({
      content: "/I cs 1 sc 0 0 50 50 re f /Sep cs 0.5 sc 50 0 50 50 re f /Lab cs 50 20 20 sc 0 50 50 50 re f /Pat cs /P scn 50 50 50 50 re f /Sh sh",
      resources: "/ColorSpace <</I [/Indexed /DeviceRGB 1 <ff000000ff00>] /Sep [/Separation /Spot /DeviceCMYK <</FunctionType 2 /Domain [0 1] /N 1 /C0 [0 0 0 0] /C1 [1 0 0 0]>>] /Lab [/Lab <</WhitePoint [0.95 1 1.09]>>] /Pat /Pattern>> /Pattern <</P 5 0 R>> /Shading <</Sh <</ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] /BBox [0 0 100 10] /Function <</FunctionType 3 /Domain [0 1] /Bounds [0.5] /Encode [0 1 0 1] /Functions [<</FunctionType 2 /Domain [0 1] /N 1>> <</FunctionType 0 /Domain [0 1] /Range [0 1 0 1 0 1] /Size [2] /BitsPerSample 8 /Length 6>>]>>>>>>",
      objects: [{ dict: " /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10", data: "1 0 0 rg 0 0 5 5 re f" }],
    }),
    dashes: pdfOf({ content: "[3 2] 1 d 2 w 1 J 1 j 10 M 0 0 m 100 100 l S 10 10 m 20 40 50 40 90 10 c S" }),
    annotations: pdfOf({
      content: "",
      objects: [
        "<</Type /Annot /Subtype /Highlight /Rect [0 0 50 20] /C [1 1 0] /QuadPoints [0 20 50 20 0 0 50 0]>>",
        "<</Type /Annot /Subtype /Ink /Rect [0 0 100 100] /InkList [[0 0 50 50 100 0]] /BS <</W 2 /S /D /D [3 1]>>>>",
        "<</Type /Annot /Subtype /FreeText /Rect [10 40 90 90] /Contents (Words) /DA (/Helv 9 Tf 0 g)>>",
        "<</Type /Annot /Subtype /Widget /Rect [10 10 90 30] /FT /Tx /V (Value) /DA (/Helv 0 Tf 0 g) /MK <</BG [1 1 1] /BC [0 0 0]>> /Parent 9 0 R>>",
        "<</T (field) /Kids [8 0 R]>>",
      ],
      pageExtra: "/Annots [5 0 R 6 0 R 7 0 R 8 0 R]",
    }),
    hidden: pdfOf({
      catalogExtra: "/OCProperties <</OCGs [5 0 R] /D <</OFF [5 0 R]>>>> /Outlines 6 0 R /PageLabels <</Nums [0 <</S /r>>]>>",
      content: "/OC /G BDC 1 0 0 rg 0 0 50 50 re f EMC q 0 1 0 rg Q",
      resources: "/Properties <</G 5 0 R>>",
      objects: ["<</Type /OCG /Name (off)>>", "<</Type /Outlines /Count 1 /First 7 0 R /Last 7 0 R>>", "<</Title (One) /Parent 6 0 R /Dest [3 0 R /Fit]>>"],
    }),
  };
  const corpus = Object.entries(cases).map(([name, pdf]) => ({ name, pdf }));
  for (const [i, { pdf }] of transparencyCases().entries()) if (i % 4 === 0) corpus.push({ name: `transparency-${i}`, pdf });
  return corpus;
}
