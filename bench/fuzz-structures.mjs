// PDFs that are well formed and built to cost: repeats and chains in every tree the API walks, and
// annotations and forms that ask for far more drawing than their size. Damage rarely makes one of these,
// so bench/fuzz.mjs and js/test/fuzz.test.ts generate them. The same seed gives the same file.
import { randomFrom } from "./fuzz-mutations.mjs";

/** Objects 1 to 4 are the catalog, the page tree, the page and its content; `extras` start at 5. */
function pdf({ catalog = "", pages = "/Kids[3 0 R]/Count 1", page = "", content = "", extras = [] }) {
  const bodies = [
    `<</Type/Catalog/Pages 2 0 R${catalog}>>`,
    `<</Type/Pages${pages}>>`,
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 400]/Contents 4 0 R${page}>>`,
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    ...extras,
  ];
  let file = "%PDF-1.7\n";
  const offsets = bodies.map((body, i) => {
    const at = file.length;
    file += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = file.length;
  file += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  file += offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("");
  file += `trailer\n<</Size ${bodies.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(file, (c) => c.charCodeAt(0));
}

const stream = (dict, data) => `<<${dict}/Length ${data.length}>>\nstream\n${data}\nendstream`;
const times = (count, make) => Array.from({ length: count }, (_, i) => make(i)).join(" ");

/** Nodes from object 5, each naming the next twice: 2^depth visits from a file of a few KB. */
const doubling = (depth, link, leaf) =>
  Array.from({ length: depth }, (_, i) => (i === depth - 1 ? leaf : link(5 + i + 1)));

const annotated = (annots, extras = []) => pdf({ page: `/Annots[${annots}]`, extras });
/** A widget that's in the form, as object 5. */
const field = (widget, extras = []) =>
  pdf({ page: "/Annots[5 0 R]", catalog: "/AcroForm<</Fields[5 0 R]>>", extras: [widget, ...extras] });

const CASES = {
  labelTree: (r) =>
    pdf({
      catalog: "/PageLabels 5 0 R",
      extras: doubling(20 + r.int(25), (n) => `<</Kids[${n} 0 R ${n} 0 R]>>`, "<</Nums[0<</S/D>>]>>"),
    }),
  labelRanges: (r) =>
    pdf({ catalog: `/PageLabels<</Nums[${times(100_000, (i) => `${i}<</S/${"rRaAD"[r.int(5)]}/St ${1 + r.int(2 ** 31)}>>`)}]>>` }),
  destTree: (r) => {
    const depth = 20 + r.int(25);
    const nodes = doubling(depth, (n) => `<</Kids[${n} 0 R ${n} 0 R]>>`, "<</Names[(a)[3 0 R/Fit]]>>");
    return pdf({ catalog: `/Names<</Dests 5 0 R>>/Outlines<</First ${5 + depth} 0 R>>`, extras: [...nodes, "<</Title(a)/Dest(a)>>"] });
  },
  dictDests: () => pdf({ catalog: `/Dests<<${times(50_000, (i) => `/n${i} 5 0 R`)}>>/Outlines<</First 5 0 R>>`, extras: ["<</Title(a)/Dest/n7>>"] }),
  outlineDiamond: (r) =>
    pdf({
      catalog: "/Outlines<</First 5 0 R>>",
      extras: doubling(20 + r.int(25), (n) => `<</Title(a)/First ${n} 0 R/Next ${n} 0 R>>`, "<</Title(z)>>"),
    }),
  outlineChain: (r) => {
    const key = r.int(2) ? "First" : "Next";
    const length = 70_000 + r.int(10_000);
    return pdf({
      catalog: "/Outlines<</First 5 0 R>>",
      extras: Array.from({ length }, (_, i) => `<</Title(a)${i === length - 1 ? "" : `/${key} ${6 + i} 0 R`}>>`),
    });
  },
  outlineLoop: () => pdf({ catalog: "/Outlines<</First 5 0 R>>", extras: ["<</Title(a)/First 5 0 R/Next 6 0 R>>", "<</Title(b)/Next 5 0 R/First 6 0 R>>"] }),
  pageKids: (r) => {
    const nodes = doubling(30 + r.int(30), (n) => `<</Type/Pages/Kids[${n} 0 R ${n} 0 R]>>`, "<</Type/Pages/Kids[3 0 R 3 0 R]>>");
    return pdf({ pages: "/Kids[5 0 R 5 0 R]", extras: nodes });
  },
  largePageRepeated: () => {
    const nodes = doubling(18, (n) => `<</Type/Pages/Kids[${n} 0 R ${n} 0 R]>>`, "<</Type/Pages/Kids[3 0 R 3 0 R]>>");
    return pdf({ pages: "/Kids[5 0 R 5 0 R]", page: `/Junk[${times(100_000, () => "1")}]`, extras: nodes });
  },
  fieldParents: (r) => {
    const length = 20_000 + r.int(20_000);
    const parents = Array.from({ length }, (_, i) => (i === length - 1 ? "<</Parent 6 0 R>>" : `<</Parent ${7 + i} 0 R>>`));
    return field("<</Subtype/Widget/Rect[0 0 100 20]/Parent 6 0 R>>", parents);
  },
  visibilityTree: (r) => {
    const depth = 20 + r.int(25);
    const nodes = Array.from({ length: depth }, (_, i) => `[/And ${6 + i + 1} 0 R ${6 + i + 1} 0 R]`);
    nodes[depth - 1] = "[/Not 5 0 R]";
    return pdf({
      page: "/Resources<</Properties<</V 5 0 R>>>>",
      content: "/OC /V BDC 0 0 10 10 re f EMC",
      catalog: "/OCProperties<</OCGs[5 0 R]/D<<>>>>",
      extras: ["<</Type/OCMD/VE 6 0 R>>", ...nodes],
    });
  },
  squiggles: (r) => {
    const quad = () => `0 ${r.int(400)} 9000 ${r.int(400)} 0 ${r.int(400)} 9000 ${r.int(400)}`;
    return annotated(`<</Subtype/Squiggly/Rect[0 0 400 400]/QuadPoints[${times(2_000 + r.int(30_000), quad)}]>>`);
  },
  quads: (r) => {
    const subtype = ["Underline", "StrikeOut", "Highlight"][r.int(3)];
    const quad = () => `0 ${r.int(400)} 9000 ${r.int(400)} 0 ${r.int(400)} 9000 ${r.int(400)}`;
    return annotated(`<</Subtype/${subtype}/Rect[0 0 400 400]/QuadPoints[${times(40_000 + r.int(10_000), quad)}]>>`);
  },
  inkStrokes: (r) => {
    const strokes = 50_000 + r.int(30_000);
    return annotated(`<</Subtype/Ink/Rect[0 0 400 400]/InkList[${times(strokes, () => `[${r.int(400)} ${r.int(400)} ${r.int(400)} ${r.int(400)}]`)}]>>`);
  },
  vertices: (r) => {
    const subtype = ["PolyLine", "Polygon"][r.int(2)];
    return annotated(`<</Subtype/${subtype}/Rect[0 0 400 400]/IC[1 0 0]/Vertices[${times(60_000, () => `${r.int(400)} ${r.int(400)}`)}]>>`);
  },
  repeatedAnnotation: () => {
    const quad = "0 0 9000 0 0 9 9000 9";
    return annotated(times(50_000, () => "5 0 R"), [`<</Subtype/Squiggly/Rect[0 0 400 400]/QuadPoints[${times(2_000, () => quad)}]/InkList[[${times(4_000, (i) => `${i % 400} ${i % 397}`)}]]>>`]);
  },
  manyAnnotations: (r) => annotated(times(40_000, () => `<</Subtype/Square/Rect[${r.int(300)} ${r.int(300)} 400 400]/IC[0 1 0]>>`)),
  freeTextLines: (r) => {
    const text = "x\\n".repeat(150_000 + r.int(50_000));
    return annotated(`<</Subtype/FreeText/Rect[0 0 400 400]/DA(/Helv 1 Tf)/Contents(${text})>>`);
  },
  fieldLines: () => {
    const text = "x\\n".repeat(200_000);
    return field(`<</Subtype/Widget/FT/Tx/Ff 4096/Rect[0 0 400 400]/DA(/Helv 1 Tf)/V(${text})>>`);
  },
  listOptions: (r) => {
    const flags = r.int(2) ? 0 : 1 << 17;
    return field(`<</Subtype/Widget/FT/Ch/Ff ${flags}/Rect[0 0 400 400]/V(a)/I[${times(20_000, (i) => i)}]/Opt[${times(50_000, () => "[(a)(b)]")}]>>`);
  },
  formChain: (r) => {
    const depth = 20 + r.int(25);
    const forms = Array.from({ length: depth }, (_, i) =>
      stream(`/Type/XObject/Subtype/Form/BBox[0 0 400 400]/Resources<</XObject<</X ${5 + i + 1} 0 R>>>>`, "/X Do /X Do"),
    );
    forms[depth - 1] = stream("/Type/XObject/Subtype/Form/BBox[0 0 400 400]", "0 0 400 400 re f");
    return pdf({ page: "/Resources<</XObject<</X 5 0 R>>>>", content: "/X Do", extras: forms });
  },
  appearanceChain: (r) => {
    const depth = 20 + r.int(25);
    const forms = Array.from({ length: depth }, (_, i) =>
      stream(`/Type/XObject/Subtype/Form/BBox[0 0 400 400]/Resources<</XObject<</X ${5 + i + 1} 0 R>>>>`, "/X Do /X Do"),
    );
    forms[depth - 1] = stream("/Type/XObject/Subtype/Form/BBox[0 0 400 400]", "0 0 400 400 re f");
    return pdf({ page: "/Annots[<</Subtype/Stamp/Rect[0 0 400 400]/AP<</N 5 0 R>>>>]", extras: forms });
  },
  formLoop: () =>
    pdf({
      page: "/Resources<</XObject<</X 5 0 R>>>>",
      content: "/X Do",
      extras: [stream("/Type/XObject/Subtype/Form/BBox[0 0 400 400]/Resources<</XObject<</X 5 0 R>>>>", "/X Do /X Do")],
    }),
  patternChain: (r) => {
    const depth = 20 + r.int(10);
    const patterns = Array.from({ length: depth }, (_, i) =>
      stream(`/Type/Pattern/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 200 200]/XStep 100/YStep 100/Resources<</Pattern<</P ${5 + i + 1} 0 R>>>>`, "/Pattern cs /P scn 0 0 200 200 re f 0 0 100 100 re f"),
    );
    patterns[depth - 1] = stream("/Type/Pattern/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 1 1]/XStep 1/YStep 1/Resources<<>>", "0 0 1 1 re f");
    return pdf({ page: "/Resources<</Pattern<</P 5 0 R>>>>", content: "/Pattern cs /P scn 0 0 400 400 re f", extras: patterns });
  },
  softMaskChain: (r) => {
    const depth = 20 + r.int(10);
    const forms = [];
    for (let i = 0; i < depth; i++) {
      const next = 5 + i + 1;
      forms.push(stream(`/Type/XObject/Subtype/Form/BBox[0 0 400 400]/Group<</S/Transparency>>/Resources<</ExtGState<</G<</SMask<</S/Luminosity/G ${next} 0 R>>>>>>>>`, "/G gs 0 0 400 400 re f /G gs 0 0 200 200 re f"));
    }
    forms[depth - 1] = stream("/Type/XObject/Subtype/Form/BBox[0 0 400 400]/Group<</S/Transparency>>", "1 g 0 0 400 400 re f");
    return pdf({ page: "/Resources<</ExtGState<</G<</SMask<</S/Luminosity/G 5 0 R>>>>>>>>", content: "/G gs 0 0 400 400 re f", extras: forms });
  },
  type3Chain: (r) => {
    const depth = 20 + r.int(10);
    const objects = [];
    for (let i = 0; i < depth; i++) {
      const font = 5 + 2 * i;
      const next = font + 2;
      objects.push(`<</Type/Font/Subtype/Type3/FontBBox[0 0 1 1]/FontMatrix[1 0 0 1 0 0]/FirstChar 97/LastChar 97/Widths[1]/Encoding<</Differences[97/a]>>/CharProcs<</a ${font + 1} 0 R>>/Resources<</Font<</F ${next} 0 R>>>>>>`);
      objects.push(stream("", i === depth - 1 ? "1 0 d0 0 0 1 1 re f" : "1 0 d0 BT /F 1 Tf (aa) Tj ET"));
    }
    return pdf({ page: "/Resources<</Font<</F 5 0 R>>>>", content: "BT /F 100 Tf (aa) Tj ET", extras: objects });
  },
  stateNesting: () => pdf({ content: "q ".repeat(200_000) + "0 0 10 10 re f" }),
};

export const STRUCTURES = Object.keys(CASES);

/** What each kind trips, as `text`, `objects`, `render` and `doc.structureTruncated()` say. */
const DRAWN = ["render"];
const READ = ["text", "objects", "render"];
export const TRIPS = {
  labelTree: ["pageLabels"],
  labelRanges: ["pageLabels"],
  destTree: ["outline"],
  dictDests: [],
  outlineDiamond: [],
  outlineLoop: [],
  pageKids: ["pages"],
  largePageRepeated: ["pages"],
  fieldParents: [],
  visibilityTree: READ,
  squiggles: DRAWN,
  quads: DRAWN,
  inkStrokes: DRAWN,
  vertices: [],
  repeatedAnnotation: DRAWN,
  manyAnnotations: [],
  freeTextLines: DRAWN,
  fieldLines: DRAWN,
  listOptions: [],
  outlineChain: ["outline"],
  formChain: READ,
  appearanceChain: DRAWN,
  formLoop: [],
  patternChain: DRAWN,
  softMaskChain: [],
  type3Chain: DRAWN,
  stateNesting: [],
};

/** One file, by a seed: the same seed gives the same bytes. */
export function structure(seed) {
  const r = randomFrom(seed);
  const name = STRUCTURES[seed % STRUCTURES.length];
  return { name, bytes: CASES[name](r) };
}
