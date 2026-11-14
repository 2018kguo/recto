// PDFs that run what a profile of ordinary files doesn't: JBIG2, CCITT, JPEG 2000, mesh shadings and
// a PostScript function. Each draws something a test can state without another engine.
import { readFileSync } from "node:fs";

/** A one-page 100 x 100 PDF whose content and objects are given; objects start at 5. `contents` can list more. */
export function pagePdf(
  content: string,
  resources: string,
  objects: (string | { dict: string; data: Uint8Array })[],
  contents = "4 0 R"
): Uint8Array {
  const body = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents ${contents} /Resources << ${resources} >> >>`,
    { dict: "", data: new TextEncoder().encode(content) },
    ...objects,
  ];
  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (bytes: Uint8Array | string) => {
    const chunk = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    parts.push(chunk);
    length += chunk.length;
  };
  push("%PDF-1.7\n");
  const offsets = body.map((object, i) => {
    const at = length;
    if (typeof object === "string") {
      push(`${i + 1} 0 obj\n${object}\nendobj\n`);
    } else {
      push(`${i + 1} 0 obj\n<< ${object.dict} /Length ${object.data.length} >>\nstream\n`);
      push(object.data);
      push("\nendstream\nendobj\n");
    }
    return at;
  });
  const xref = length;
  push(`xref\n0 ${body.length + 1}\n0000000000 65535 f \n`);
  for (const at of offsets) {
    push(`${String(at).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${body.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const SIDE = 16;
/** A bilevel image: black in the 8 x 8 squares where row and column bands differ. */
const black = (x: number, y: number) => (x >> 3 !== y >> 3);

/** ITU T.6, in horizontal mode only: each row is one code for its white run and one for its black. */
function mmr(): Uint8Array {
  const WHITE: Record<number, string> = { 0: "00110101", 8: "10011", 16: "101010" };
  const BLACK: Record<number, string> = { 0: "0000110111", 8: "000101", 16: "0000010111" };
  let bits = "";
  for (let y = 0; y < SIDE; y++) {
    // A row is white then black, or black then white: two pairs of runs in horizontal mode.
    if (black(0, y)) {
      bits += `001${WHITE[0]}${BLACK[8]}001${WHITE[8]}${BLACK[0]}`;
    } else {
      bits += `001${WHITE[8]}${BLACK[8]}`;
    }
  }
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, "0");
  return Uint8Array.from(bits.match(/.{8}/gu)!, (byte) => parseInt(byte, 2));
}

const u32 = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];

/** An embedded JBIG2 stream: a page, and one MMR generic region covering it. */
function jbig2(): Uint8Array {
  const page = [...u32(SIDE), ...u32(SIDE), ...u32(0), ...u32(0), 0, 0, 0];
  const data = mmr();
  // The region's size and place, its combination operator, then flags: MMR on.
  const region = [...u32(SIDE), ...u32(SIDE), ...u32(0), ...u32(0), 0, 1, ...data];
  const segment = (number: number, type: number, body: number[]) => [...u32(number), type, 0, 1, ...u32(body.length), ...body];
  return Uint8Array.from([...segment(0, 48, page), ...segment(1, 38, region)]);
}

const IMAGE = "/Type /XObject /Subtype /Image /Width 16 /Height 16";
const drawImage = "q 100 0 0 100 0 0 cm /I Do Q";

/** The same picture three ways: `raw` is the control. */
export const bilevel = {
  raw: () => {
    const rows = new Uint8Array(SIDE * 2);
    for (let y = 0; y < SIDE; y++) {
      for (let x = 0; x < SIDE; x++) {
        // A bilevel image's 0 is black.
        if (!black(x, y)) {
          rows[y * 2 + (x >> 3)]! |= 0x80 >> (x & 7);
        }
      }
    }
    return pagePdf(drawImage, "/XObject << /I 5 0 R >>", [
      { dict: `${IMAGE} /BitsPerComponent 1 /ColorSpace /DeviceGray`, data: rows },
    ]);
  },
  ccitt: () =>
    pagePdf(drawImage, "/XObject << /I 5 0 R >>", [
      {
        dict: `${IMAGE} /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 16 /Rows 16 >>`,
        data: mmr(),
      },
    ]),
  jbig2: () =>
    pagePdf(drawImage, "/XObject << /I 5 0 R >>", [
      { dict: `${IMAGE} /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /JBIG2Decode`, data: jbig2() },
    ]),
};

export const jpxPdf = () =>
  pagePdf(drawImage, "/XObject << /I 5 0 R >>", [
    { dict: `${IMAGE} /Filter /JPXDecode`, data: new Uint8Array(readFileSync(new URL("./fixtures/half-red-half-blue.jp2", import.meta.url))) },
  ]);

/** A triangle mesh, type 4: 8 bits a flag, 8 a coordinate, 8 a component. */
export const meshPdf = () => {
  const vertex = (x: number, y: number, r: number, g: number, b: number) => [0, x, y, r, g, b];
  return pagePdf("/S sh", "/Shading << /S 5 0 R >>", [
    {
      dict: "/ShadingType 4 /ColorSpace /DeviceRGB /BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 100 0 100 0 1 0 1 0 1]",
      data: Uint8Array.from([
        ...vertex(0, 0, 255, 0, 0),
        ...vertex(255, 0, 255, 0, 0),
        ...vertex(0, 255, 255, 0, 0),
        ...vertex(255, 255, 255, 0, 0),
        ...vertex(255, 0, 255, 0, 0),
        ...vertex(0, 255, 255, 0, 0),
      ]),
    },
  ]);
};

/** A patch mesh, type 7: one square patch in one colour, `patches` times over. */
export const tensorPdf = (patches = 1) => {
  const c = (x: number, y: number) => [x, y];
  const points = [c(0, 0), c(0, 85), c(0, 170), c(0, 255), c(85, 255), c(170, 255), c(255, 255), c(255, 170), c(255, 85), c(255, 0), c(170, 0), c(85, 0), c(85, 85), c(85, 170), c(170, 170), c(170, 85)];
  return pagePdf("/S sh", "/Shading << /S 5 0 R >>", [
    {
      dict: "/ShadingType 7 /ColorSpace /DeviceRGB /BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 100 0 100 0 1 0 1 0 1]",
      data: Uint8Array.from(Array.from({ length: patches }, () => [0, ...points.flat(), 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255]).flat()),
    },
  ]);
};

/** An axial shading whose colours come from a PostScript function: blue, whatever the position. */
export const postScriptPdf = () =>
  pagePdf("/S sh", "/Shading << /S 5 0 R >>", [
    "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] /Function 6 0 R /Extend [true true] >>",
    { dict: "/FunctionType 4 /Domain [0 1] /Range [0 1 0 1 0 1]", data: new TextEncoder().encode("{ pop 0 0 1 }") },
  ]);
