#!/usr/bin/env node
// Writes small PDFs for what the API has to get right about a page's shape and its annotations:
// rotation, user units, crop and media boxes, inheritance, widget appearances, page labels. Run the
// scorecard on the directory to set recto beside the references.
//
//   node bench/api-cases.mjs <directory>
import fs from "node:fs";
import path from "node:path";

const directory = process.argv[2];
if (!directory) {
  console.error("usage: api-cases.mjs <directory>");
  process.exit(2);
}
fs.mkdirSync(directory, { recursive: true });

/** Marks that show which way up a page is: a red corner at the origin, a blue bar along the top. */
const MARKS = "1 0 0 rg 0 0 40 40 re f 0 0 1 rg 0 160 300 20 re f 0 1 0 rg 100 60 50 50 re f";

function pdf({ page = "/MediaBox [0 0 300 200]", content = MARKS, pages = "", catalog = "", objects = [], extraPages = 0 }) {
  const kids = ["3 0 R", ...Array.from({ length: extraPages }, (_, i) => `${5 + objects.length + i} 0 R`)];
  const all = [
    `<</Type /Catalog /Pages 2 0 R ${catalog}>>`,
    `<</Type /Pages /Count ${kids.length} /Kids [${kids.join(" ")}] ${pages}>>`,
    `<</Type /Page /Parent 2 0 R /Contents 4 0 R ${page}>>`,
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    ...objects,
    ...Array.from({ length: extraPages }, () => `<</Type /Page /Parent 2 0 R /MediaBox [0 0 300 200]>>`),
  ];
  let out = "%PDF-1.7\n";
  const offsets = [];
  all.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${all.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<</Size ${all.length + 1} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const FORM = "<</Type /XObject /Subtype /Form /BBox [0 0 100 30] /Length 34>>\nstream\n1 0 0 rg 0 0 100 30 re f          \nendstream";
const HELV = "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>";
const widget = (rest) => `/Resources <</Font <</Helv 5 0 R>>>> /Annots [<</Type /Annot /Subtype /Widget /Rect [50 50 250 90] /F 4 ${rest}>>]`;

const cases = {
  "rotate-90": { page: "/MediaBox [0 0 300 200] /Rotate 90" },
  "rotate-180": { page: "/MediaBox [0 0 300 200] /Rotate 180" },
  "rotate-270": { page: "/MediaBox [0 0 300 200] /Rotate 270" },
  "rotate-minus-90": { page: "/MediaBox [0 0 300 200] /Rotate -90" },
  "rotate-450": { page: "/MediaBox [0 0 300 200] /Rotate 450" },
  "rotate-45": { page: "/MediaBox [0 0 300 200] /Rotate 45" },
  "rotate-inherited": { page: "", pages: "/MediaBox [0 0 300 200] /Rotate 90" },
  "user-unit-2": { page: "/MediaBox [0 0 300 200] /UserUnit 2" },
  "media-offset": { page: "/MediaBox [-50 -50 250 150]" },
  "media-reversed": { page: "/MediaBox [300 200 0 0]" },
  "media-inherited": { page: "", pages: "/MediaBox [0 0 300 200]" },
  "crop-inside": { page: "/MediaBox [0 0 300 200] /CropBox [20 20 220 150]" },
  "crop-outside": { page: "/MediaBox [0 0 300 200] /CropBox [-50 -50 150 400]" },
  "crop-disjoint": { page: "/MediaBox [0 0 300 200] /CropBox [400 400 500 500]" },
  "crop-inherited": { page: "/MediaBox [0 0 300 200]", pages: "/CropBox [20 20 220 150]" },
  "crop-rotated": { page: "/MediaBox [0 0 300 200] /CropBox [20 20 220 150] /Rotate 90" },
  "widget-appearance": { page: widget("/FT /Tx /AP <</N 6 0 R>>"), objects: [HELV, FORM], content: "" , pages: "/MediaBox [0 0 300 200]" },
  "widget-value-no-appearance": { page: widget("/FT /Tx /V (Filled in) /DA (/Helv 14 Tf 0 g)"), objects: [HELV], content: "", pages: "/MediaBox [0 0 300 200]" },
  "widget-value-need-appearances": { page: widget("/FT /Tx /V (Filled in) /DA (/Helv 14 Tf 0 g)"), objects: [HELV], content: "", pages: "/MediaBox [0 0 300 200]", catalog: "/AcroForm <</NeedAppearances true /Fields []>>" },
  "widget-stale-need-appearances": { page: widget("/FT /Tx /V (New value) /DA (/Helv 14 Tf 0 g) /AP <</N 6 0 R>>"), objects: [HELV, FORM], content: "", pages: "/MediaBox [0 0 300 200]", catalog: "/AcroForm <</NeedAppearances true /Fields []>>" },
  "widget-combo-export": { page: widget("/FT /Ch /Ff 131072 /V (e) /Opt [[(e) (Shown text)]] /DA (/Helv 14 Tf 0 g)"), objects: [HELV], content: "", pages: "/MediaBox [0 0 300 200]" },
  "widget-list-box": { page: widget("/FT /Ch /V (b) /Opt [(First) (Second) (Third)] /DA (/Helv 10 Tf 0 g)"), objects: [HELV], content: "", pages: "/MediaBox [0 0 300 200]" },
  "widget-checkbox-on": { page: widget("/FT /Btn /AS /Yes /AP <</N <</Yes 6 0 R /Off 7 0 R>>>>"), objects: [HELV, FORM, FORM.replace("1 0 0 rg", "0 0 1 rg")], content: "", pages: "/MediaBox [0 0 300 200]" },
  "widget-checkbox-off": { page: widget("/FT /Btn /AS /Off /AP <</N <</Yes 6 0 R>>>>"), objects: [HELV, FORM], content: "", pages: "/MediaBox [0 0 300 200]" },
  "widget-hidden": { page: widget("/F 2 /FT /Tx /AP <</N 6 0 R>>"), objects: [HELV, FORM], content: "", pages: "/MediaBox [0 0 300 200]" },
  "annotation-rotated-page": { page: `/Rotate 90 /Annots [<</Type /Annot /Subtype /Stamp /Rect [50 50 250 90] /AP <</N 5 0 R>>>>]`, objects: [FORM], content: "", pages: "/MediaBox [0 0 300 200]" },
  "annotation-no-rotate-flag": { page: `/Rotate 90 /Annots [<</Type /Annot /Subtype /Stamp /F 16 /Rect [50 50 250 90] /AP <</N 5 0 R>>>>]`, objects: [FORM], content: "", pages: "/MediaBox [0 0 300 200]" },
  "page-labels": { catalog: "/PageLabels <</Nums [0 <</S /r>> 1 <</P (A-) /S /D /St 5>>]>>", extraPages: 2 },
};
for (const [name, options] of Object.entries(cases)) fs.writeFileSync(path.join(directory, `${name}.pdf`), pdf(options));
console.log(`${Object.keys(cases).length} files in ${directory}`);
