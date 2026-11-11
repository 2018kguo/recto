// The PDFs the benchmark, the film and the README's images use. All generated here, written
// directly, deterministic: nothing third-party, nothing to license.
import zlib from "node:zlib";

/** xorshift32: the same numbers every run. */
function random(seed) {
  let s = seed | 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

const COMPANY = "Tern & Alder Freight";
const SECTIONS = ["Network operations", "Fleet and maintenance", "Terminals", "Customers and contracts", "Safety", "Fuel and emissions", "People", "Outlook"];
const REGIONS = ["North", "South", "East", "West", "Central", "Export"];
const SENTENCES = [
  "Volume on the {r} corridor rose {n} percent over the year, driven mainly by contract renewals signed in the second quarter.",
  "On-time arrivals held at {p} percent despite the winter closures, which cost the network {d} operating days in January.",
  "We retired {d} of the oldest tractors and replaced them with units that use about {n} percent less fuel per mile.",
  "Terminal dwell time fell by {n} percent after the {r} yard moved to appointment-based gates in March.",
  "Maintenance spending came in {n} percent under plan, though parts lead times remain longer than we would like.",
  "Claims per thousand shipments dropped to {s}, the lowest figure since we began reporting on this basis.",
  "The {r} region accounted for {p} percent of revenue growth, and we expect that share to narrow next year.",
  "Empty miles remain the largest controllable cost, at {n} percent of the total, and routing changes are in trial.",
  "Staff turnover among drivers fell to {n} percent, helped by shorter rotations and the new pay structure.",
  "Fuel surcharges recovered roughly {p} percent of the increase in diesel prices during the third quarter.",
  "Rail transfers through the {r} interchange carried {d} thousand containers, up from the year before.",
  "Average load factor improved to {p} percent as dispatch began pooling smaller shipments across depots.",
  "Two new customers in cold-chain distribution added {n} percent to contracted volume from the fourth quarter.",
  "Capital expenditure was weighted toward yard equipment, with {d} new cranes commissioned before the peak season.",
];

/** Words broken into lines of about this many characters, by width of a Helvetica average. */
function lines(next, count) {
  const fill = (template) =>
    template
      .replace("{r}", REGIONS[Math.floor(next() * REGIONS.length)].toLowerCase())
      .replace("{n}", String(2 + Math.floor(next() * 18)))
      .replace("{p}", String(61 + Math.floor(next() * 37)))
      .replace("{d}", String(3 + Math.floor(next() * 40)))
      .replace("{s}", (1 + next() * 3).toFixed(1));
  const out = [];
  let line = "";
  // Round the list from a random place, so a paragraph doesn't say one thing twice.
  let at = Math.floor(next() * SENTENCES.length);
  while (out.length < count) {
    for (const word of fill(SENTENCES[at++ % SENTENCES.length]).split(" ")) {
      if (line.length + word.length > 92) {
        out.push(line.trimEnd());
        line = "";
      }
      line += `${word} `;
    }
  }
  return out.slice(0, count);
}
const escaped = (text) => text.replace(/[\\()]/gu, "\\$&");

/** Assembles objects into a file. `objects[i]` is object i + 1: a string, or { dict, data }. */
export function assemble(objects, root) {
  const chunks = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let at = chunks[0].length;
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(at);
    const parts =
      typeof object === "string"
        ? [Buffer.from(`${i + 1} 0 obj\n${object}\nendobj\n`, "latin1")]
        : [
            Buffer.from(`${i + 1} 0 obj\n<<${object.dict} /Length ${object.data.length}>>\nstream\n`, "latin1"),
            object.data,
            Buffer.from("\nendstream\nendobj\n", "latin1"),
          ];
    for (const part of parts) {
      chunks.push(part);
      at += part.length;
    }
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`];
  for (const offset of offsets) xref.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  xref.push(`trailer\n<</Size ${objects.length + 1} /Root ${root} 0 R>>\nstartxref\n${at}\n%%EOF\n`);
  chunks.push(Buffer.from(xref.join(""), "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}

export const flate = (text) => ({ dict: " /Filter /FlateDecode", data: zlib.deflateSync(Buffer.from(text, "latin1")) });

/** A generated landscape: sky, a low sun, ridges, a little grain, so it compresses like a photo. */
function photo(seed, width, height) {
  const next = random(seed);
  const phases = Array.from({ length: 9 }, () => next() * 6.28);
  const sunX = 0.2 + next() * 0.6;
  const sunY = 0.25 + next() * 0.15;
  const warm = next() * 0.25;
  const ridge = (x, k) =>
    0.42 + k * 0.17 + 0.07 * Math.sin(x * (3 + k * 2) + phases[k * 3]) + 0.035 * Math.sin(x * (9 + k * 5) + phases[k * 3 + 1]) + 0.012 * Math.sin(x * (31 + k * 9) + phases[k * 3 + 2]);
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0, i = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      const u = x / width;
      let r = 150 + 90 * v + 60 * warm;
      let g = 186 + 30 * v;
      let b = 226 - 50 * v;
      const glow = Math.max(0, 1 - Math.hypot((u - sunX) * 1.8, v - sunY) * 3.2);
      r += 90 * glow;
      g += 60 * glow;
      b += 10 * glow;
      for (let k = 0; k < 3; k++) {
        if (v > ridge(u * 6.28, k)) {
          const shade = 1 - k * 0.3;
          r = 92 * shade;
          g = 118 * shade;
          b = 128 * shade;
        }
      }
      const grain = (next() - 0.5) * 7;
      rgb[i++] = Math.min(255, Math.max(0, r + grain));
      rgb[i++] = Math.min(255, Math.max(0, g + grain));
      rgb[i++] = Math.min(255, Math.max(0, b + grain));
    }
  }
  return { dict: ` /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, data: zlib.deflateSync(rgb) };
}

const INK = "0.11 0.14 0.19";
const ACCENT = "0.16 0.47 0.84";
const SECOND = "0.92 0.41 0.20";
const MUTED = "0.42 0.44 0.47";

function paragraph(next, x, y, count) {
  let out = `${INK} rg BT /Body 10 Tf 14 TL ${x} ${y} Td\n`;
  for (const line of lines(next, count)) out += `(${escaped(line)}) Tj T*\n`;
  return `${out}ET\n`;
}

function table(next, x, y, title) {
  const widths = [130, 85, 85, 85, 119];
  const row = 18;
  const width = widths.reduce((a, b) => a + b);
  let out = `BT /Bold 10 Tf ${INK} rg ${x} ${y + 8} Td (${escaped(title)}) Tj ET\n`;
  out += `0.93 0.95 0.98 rg ${x} ${y - row + 3} ${width} ${row} re f\n`;
  const cell = (text, at, rowY, font = "Body", color = INK) => `BT /${font} 9.5 Tf ${color} rg ${at + 6} ${rowY} Td (${text}) Tj ET\n`;
  let at = x;
  ["Region", "Q1", "Q2", "Q3", "Change on year"].forEach((head, i) => {
    out += cell(head, at, y - 10, "Bold");
    at += widths[i];
  });
  REGIONS.forEach((name, r) => {
    const rowY = y - 10 - row * (r + 1);
    at = x;
    out += cell(name, at, rowY);
    at += widths[0];
    for (let c = 1; c < 4; c++) {
      out += cell((120 + next() * 880).toFixed(1), at, rowY);
      at += widths[c];
    }
    const change = (next() * 16 - 4).toFixed(1);
    out += cell(`${change.startsWith("-") ? "" : "+"}${change}%`, at, rowY);
    out += `0.85 0.87 0.9 RG 0.5 w ${x} ${rowY - 5} m ${x + width} ${rowY - 5} l S\n`;
  });
  return out;
}

function chart(next, x, y, width, height, title) {
  let out = `BT /Bold 10 Tf ${INK} rg ${x} ${y + height + 22} Td (${escaped(title)}) Tj ET\n`;
  out += `0.88 0.89 0.91 RG 0.5 w\n`;
  for (let i = 0; i <= 4; i++) {
    const lineY = y + (height * i) / 4;
    out += `${x + 22} ${lineY} m ${x + width} ${lineY} l S\n`;
    out += `BT /Body 7.5 Tf ${MUTED} rg ${x} ${lineY - 2.5} Td (${i * 25}) Tj ET\n`;
  }
  const months = "JFMAMJJASOND";
  const bars = months.length;
  const step = (width - 26) / bars;
  for (let i = 0; i < bars; i++) {
    const h = height * (0.3 + next() * 0.62);
    out += `${ACCENT} rg ${(x + 26 + i * step + 2.5).toFixed(1)} ${y} ${(step - 5).toFixed(1)} ${h.toFixed(1)} re f\n`;
    out += `BT /Body 7.5 Tf ${MUTED} rg ${(x + 26 + i * step + step / 2 - 2).toFixed(1)} ${y - 11} Td (${months[i]}) Tj ET\n`;
  }
  out += `${SECOND} RG 1.6 w\n`;
  for (let i = 0; i < bars; i++) {
    const px = x + 26 + i * step + step / 2;
    const py = y + height * (0.25 + next() * 0.65);
    out += `${px.toFixed(1)} ${py.toFixed(1)} ${i === 0 ? "m" : "l"}\n`;
  }
  return `${out}S 0 G 0 g\n`;
}

function coverContent() {
  let content = "q 504 0 0 300 54 400 cm /Im Do Q\n";
  content += `BT /Bold 30 Tf ${INK} rg 54 340 Td (Annual Operations Report) Tj ET\n`;
  content += `BT /Body 15 Tf ${MUTED} rg 54 314 Td (${escaped(COMPANY)}, fiscal year 2025) Tj ET\n`;
  content += `${ACCENT} rg 54 296 60 3 re f\n`;
  return content;
}

/**
 * A report: a cover, then pages of a heading, paragraphs, a table, a chart and a captioned picture
 * on every `imageEvery`th page. Letter-size, standard fonts, not embedded. A fictional company.
 */
export function reportPdf({ pages, seed = 7, imageEvery = 1, imageSize = 480 }) {
  const next = random(seed);
  const objects = [];
  const add = (object) => objects.push(object) && objects.length;
  add("<</Type /Catalog /Pages 2 0 R>>");
  add(""); // the page tree, once the kids are known
  const body = add("<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>");
  const bold = add("<</Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding>>");
  const kids = [];
  for (let page = 0; page < pages; page++) {
    const section = SECTIONS[(page - 1 + SECTIONS.length) % SECTIONS.length];
    let image = "";
    let content;
    if (page === 0) {
      const object = add(photo(seed, imageSize * 2, Math.round(imageSize * 1.2)));
      image = ` /XObject <</Im ${object} 0 R>>`;
      content = coverContent();
    } else {
      content = `BT /Bold 8.5 Tf ${ACCENT} rg 54 748 Td (${escaped(COMPANY.toUpperCase())}) Tj ET\n`;
      content += `BT /Bold 17 Tf ${INK} rg 54 722 Td (${page}. ${escaped(section)}) Tj ET\n`;
      content += paragraph(next, 54, 698, 7);
      content += table(next, 54, 582, `${section}: thousand tonne-miles by region`);
      const hasImage = page % imageEvery === 0;
      if (hasImage) {
        const object = add(photo(seed + page, imageSize, Math.round(imageSize * 0.75)));
        image = ` /XObject <</Im ${object} 0 R>>`;
        content += chart(next, 54, 300, 300, 112, "Monthly volume against plan, percent of peak");
        content += "q 170 0 0 128 384 300 cm /Im Do Q\n";
        content += `BT /Body 7.5 Tf ${MUTED} rg 384 288 Td (The ${REGIONS[page % REGIONS.length].toLowerCase()} terminal at first light.) Tj ET\n`;
      } else {
        content += chart(next, 54, 300, 504, 112, "Monthly volume against plan, percent of peak");
      }
      content += paragraph(next, 54, 262, 13);
      content += `0.85 0.87 0.9 RG 0.5 w 54 62 m 558 62 l S\n`;
      content += `BT /Body 8 Tf ${MUTED} rg 54 48 Td (Fictional sample document) Tj 470 0 Td (${page + 1}) Tj ET\n`;
    }
    const stream = add(flate(content));
    kids.push(
      add(
        `<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${stream} 0 R /Resources <</Font <</Body ${body} 0 R /Bold ${bold} 0 R>>${image}>>>>`,
      ),
    );
  }
  objects[1] = `<</Type /Pages /Count ${pages} /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}]>>`;
  return assemble(objects, 1);
}

/** A short CJK document: a predefined CMap and a font the file doesn't embed. */
export function cjkPdf() {
  const next = random(11);
  const line = () => {
    let hex = "";
    for (let i = 0; i < 28; i++) hex += (0x4e00 + Math.floor(next() * 0x1000)).toString(16).padStart(4, "0");
    return `<${hex}> Tj T*\n`;
  };
  let content = "BT /F1 14 Tf 20 TL 54 730 Td\n";
  for (let i = 0; i < 30; i++) content += line();
  content += "ET\n";
  return assemble(
    [
      "<</Type /Catalog /Pages 2 0 R>>",
      "<</Type /Pages /Count 1 /Kids [3 0 R]>>",
      "<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>>",
      flate(content),
      "<</Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R]>>",
      "<</Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo <</Registry (Adobe) /Ordering (GB1) /Supplement 2>> /FontDescriptor 7 0 R /DW 1000>>",
      "<</Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80>>",
    ],
    1,
  );
}

/** One page of `paths` small filled shapes: slow to draw, so aborting it means something. */
export function heavyPagePdf({ paths }) {
  const next = random(23);
  let content = "";
  for (let i = 0; i < paths; i++) {
    const x = next() * 600;
    const y = next() * 780;
    content += `${next().toFixed(2)} ${next().toFixed(2)} ${next().toFixed(2)} rg ${x.toFixed(1)} ${y.toFixed(1)} m ${(x + 9).toFixed(1)} ${(y + 3).toFixed(1)} l ${(x + 4).toFixed(1)} ${(y + 8).toFixed(1)} l h f\n`;
  }
  return assemble(
    [
      "<</Type /Catalog /Pages 2 0 R>>",
      "<</Type /Pages /Count 1 /Kids [3 0 R]>>",
      "<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <<>>>>",
      flate(content),
    ],
    1,
  );
}
