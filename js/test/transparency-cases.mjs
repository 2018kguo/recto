// Small PDFs for transparency groups and colour-key masks, each with probe points and the colour
// the PDF spec's compositing formulas give there, worked out by hand. The tests render them; the
// compare script in bench/ renders them in poppler and pdfium too.

/** A one-page 100 x 100 PDF: objects are appended after catalog, pages and page. */
export function pdfOf({ content, resources = "", objects = [], pageExtra = "", catalogExtra = "" }) {
  const all = [
    `<</Type /Catalog /Pages 2 0 R${catalogExtra && ` ${catalogExtra}`}>>`,
    "<</Type /Pages /Count 1 /Kids [3 0 R]>>",
    `<</Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources <<${resources}>>${pageExtra && ` ${pageExtra}`}>>`,
    { dict: "", data: content },
    ...objects,
  ];
  let out = "%PDF-1.7\n";
  const offsets = [];
  all.forEach((object, i) => {
    offsets.push(out.length);
    out +=
      typeof object === "string"
        ? `${i + 1} 0 obj\n${object}\nendobj\n`
        : `${i + 1} 0 obj\n<<${object.dict} /Length ${object.data.length}>>\nstream\n${object.data}\nendstream\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${all.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<</Size ${all.length + 1} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}

const YELLOW_BACK = "1 1 0 rg 0 0 100 100 re f\n";
const group = (flags, content, resources = "") => ({
  dict: ` /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group <</S /Transparency ${flags}>> /Resources <<${resources}>>`,
  data: content,
});
const MULTIPLY = "/ExtGState <</Mul <</BM /Multiply>>>>";
const HALF = (object) => `/XObject <</G ${object} 0 R>> /ExtGState <</Half <</ca 0.5 /CA 0.5>>>>`;
const gs = (extra) => `/ExtGState <</A <<${extra}>>>>`;

export function transparencyCases() {
  return [
    {
      name: "non-isolated group, multiply inside",
      pdf: pdfOf({
        content: `${YELLOW_BACK}/G Do`,
        resources: "/XObject <</G 5 0 R>>",
        objects: [group("", "/Mul gs 0 1 1 rg 20 20 60 60 re f", MULTIPLY)],
      }),
      probes: [
        { at: [50, 50], want: [0, 255, 0], note: "cyan x yellow backdrop = green" },
        { at: [5, 5], want: [255, 255, 0], note: "outside: backdrop" },
      ],
    },
    {
      name: "isolated group, multiply inside",
      pdf: pdfOf({
        content: `${YELLOW_BACK}/G Do`,
        resources: "/XObject <</G 5 0 R>>",
        objects: [group("/I true", "/Mul gs 0 1 1 rg 20 20 60 60 re f", MULTIPLY)],
      }),
      probes: [{ at: [50, 50], want: [0, 255, 255], note: "no backdrop to multiply: cyan" }],
    },
    {
      name: "non-isolated group at half opacity, multiply inside",
      pdf: pdfOf({
        content: `${YELLOW_BACK}/Half gs /G Do`,
        resources: HALF(5),
        objects: [group("", "/Mul gs 0 1 1 rg 20 20 60 60 re f", MULTIPLY)],
      }),
      probes: [{ at: [50, 50], want: [128, 255, 0], note: "halfway, yellow to green" }],
    },
    {
      name: "non-isolated group blended multiply, multiply inside",
      pdf: pdfOf({
        content: `0.5 0.5 1 rg 0 0 100 100 re f\n/Mul gs /G Do`,
        resources: `/XObject <</G 5 0 R>> ${MULTIPLY}`,
        objects: [group("", "/Mul gs 1 0.5 0 rg 20 20 60 60 re f", MULTIPLY)],
      }),
      // Inside: 1,.5,0 x .5,.5,1 = .5,.25,0 (group colour, alpha 1, so no backdrop removal term).
      // The group multiplies: .5,.25,0 x .5,.5,1 = .25,.125,0.
      probes: [{ at: [50, 50], want: [64, 32, 0], note: "multiplied twice" }],
    },
    {
      name: "knockout group, isolated, alpha",
      pdf: pdfOf({
        content: `${YELLOW_BACK}/G Do`,
        resources: "/XObject <</G 5 0 R>>",
        objects: [group("/I true /K true", `1 0 0 rg 10 10 50 50 re f\n/A gs 0 0 1 rg 40 40 50 50 re f`, gs("/ca 0.5"))],
      }),
      probes: [
        { at: [20, 20], want: [255, 0, 0], note: "only red" },
        { at: [50, 50], want: [127, 127, 128], note: "blue half over yellow, red gone" },
        { at: [80, 80], want: [127, 127, 128], note: "only blue half over yellow" },
      ],
    },
    {
      name: "knockout group, non-isolated, multiply",
      pdf: pdfOf({
        content: `${YELLOW_BACK}/G Do`,
        resources: "/XObject <</G 5 0 R>>",
        objects: [group("/K true", `/Mul gs 1 0 0 rg 10 10 50 50 re f\n0 1 1 rg 40 40 50 50 re f`, MULTIPLY)],
      }),
      probes: [
        { at: [20, 20], want: [255, 0, 0], note: "red x yellow" },
        { at: [50, 50], want: [0, 255, 0], note: "cyan x yellow; red knocked out" },
      ],
    },
    {
      name: "knockout group, text and an image over a rectangle",
      pdf: pdfOf({
        content: `${YELLOW_BACK}/G Do`,
        resources: "/XObject <</G 5 0 R>>",
        objects: [
          group(
            "/I true /K true",
            `1 0 0 rg 0 0 100 100 re f\n/A gs q 40 0 0 40 10 10 cm /Im Do Q\nBT /F 60 Tf 50 30 Td 0 0 1 rg (I) Tj ET`,
            `${gs("/ca 0.5")} /XObject <</Im 6 0 R>> /Font <</F <</Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold>>>>`,
          ),
          { dict: " /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", data: "\x00" },
        ],
      }),
      probes: [
        { at: [25, 25], want: [128, 128, 0], note: "image: black half over yellow" },
        { at: [5, 95], want: [255, 0, 0], note: "just the rectangle" },
      ],
    },
    {
      name: "knockout group with a group inside",
      pdf: pdfOf({
        content: `${YELLOW_BACK}/G Do`,
        resources: "/XObject <</G 5 0 R>>",
        objects: [
          group("/I true /K true", `1 0 0 rg 0 0 100 100 re f\n/A gs /Inner Do`, `${gs("/ca 0.5")} /XObject <</Inner 6 0 R>>`),
          group("/I true", "0 0 1 rg 20 20 60 60 re f"),
        ],
      }),
      probes: [
        { at: [50, 50], want: [127, 127, 128], note: "inner group half, red gone" },
        { at: [5, 5], want: [255, 0, 0], note: "just the red" },
      ],
    },
    {
      name: "non-isolated inside an isolated group",
      pdf: pdfOf({
        content: `${YELLOW_BACK}/Outer Do`,
        resources: "/XObject <</Outer 5 0 R>>",
        objects: [
          group("/I true", `1 0 1 rg 10 10 80 80 re f\n/Inner Do`, "/XObject <</Inner 6 0 R>>"),
          group("", "/Mul gs 0 1 1 rg 30 30 40 40 re f", MULTIPLY),
        ],
      }),
      probes: [
        { at: [50, 50], want: [0, 0, 255], note: "cyan x magenta (outer's own)" },
        { at: [20, 20], want: [255, 0, 255], note: "magenta" },
        { at: [5, 5], want: [255, 255, 0], note: "yellow" },
      ],
    },
    {
      name: "non-isolated group, soft mask, multiply inside",
      pdf: pdfOf({
        content: `${YELLOW_BACK}/M gs /G Do`,
        resources: `/XObject <</G 5 0 R>> /ExtGState <</M <</SMask <</S /Luminosity /G 6 0 R>>>>>>`,
        objects: [
          group("", "/Mul gs 0 1 1 rg 0 0 100 100 re f", MULTIPLY),
          { dict: " /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group <</S /Transparency /CS /DeviceGray>>", data: "0.5 g 0 0 50 100 re f 1 g 50 0 50 100 re f" },
        ],
      }),
      probes: [
        { at: [25, 50], want: [128, 255, 0], note: "half-masked: yellow to green" },
        { at: [75, 50], want: [0, 255, 0], note: "unmasked: green" },
      ],
    },
    {
      name: "non-isolated group at half opacity, screen inside, over bare paper",
      pdf: pdfOf({
        content: `1 1 0 rg 0 0 50 100 re f\n/Half gs /G Do`,
        resources: HALF(5),
        objects: [group("", "/Scr gs 1 0 0 rg 20 20 60 60 re f", "/ExtGState <</Scr <</BM /Screen>>>>")],
      }),
      // The page group is isolated (ISO 32000-2, 11.4.7): the paper is under it, not in a group's
      // backdrop. Where the page drew nothing, red screened on nothing is red, then half over white.
      probes: [
        { at: [65, 50], want: [255, 128, 128], note: "red, half over the paper (not paper screened)" },
        { at: [35, 50], want: [255, 255, 0], note: "red screened on yellow is yellow" },
        { at: [90, 50], want: [255, 255, 255], note: "paper" },
      ],
    },
    {
      name: "colour-key mask, RGB",
      pdf: pdfOf({
        content: `${YELLOW_BACK}q 100 0 0 100 0 0 cm /Im Do Q`,
        resources: "/XObject <</Im 5 0 R>>",
        objects: [
          {
            dict: " /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Mask [250 255 0 5 0 5]",
            data: "\xff\x00\x00\x00\x00\xff",
          },
        ],
      }),
      probes: [
        { at: [25, 50], want: [255, 255, 0], note: "keyed out: backdrop" },
        { at: [75, 50], want: [0, 0, 255], note: "kept" },
      ],
    },
    {
      name: "colour-key mask, indexed",
      pdf: pdfOf({
        content: `${YELLOW_BACK}q 100 0 0 100 0 0 cm /Im Do Q`,
        resources: "/XObject <</Im 5 0 R>>",
        objects: [
          {
            dict: " /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace [/Indexed /DeviceRGB 1 <FF0000 0000FF>] /BitsPerComponent 8 /Mask [1 1]",
            data: "\x00\x01",
          },
        ],
      }),
      probes: [
        { at: [25, 50], want: [255, 0, 0], note: "index 0 kept" },
        { at: [75, 50], want: [255, 255, 0], note: "index 1 keyed out" },
      ],
    },
  ];
}
