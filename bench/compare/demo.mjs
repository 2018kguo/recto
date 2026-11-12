#!/usr/bin/env node
// recto's viewer and pdf.js's side by side, on a page of their own.
//
//   npm run build
//   npm run demo:compare [-- file.pdf]      then open the URL it prints
//
// PORT=8080 picks the port. A PDF named on the command line is added to the samples.
import fs from "node:fs";
import path from "node:path";

import { sampleDocs } from "./samples.mjs";
import { serveCompare } from "./serve.mjs";

const here = import.meta.dirname;
if (!fs.existsSync(path.join(here, "../../js/dist/viewer/index.js"))) {
  console.error("The viewer isn't built yet: run `npm run build` first.");
  process.exit(1);
}
if (!fs.existsSync(path.join(here, "node_modules/pdfjs-dist/package.json"))) {
  console.error("pdf.js isn't installed: run `npm install --prefix bench/compare`.");
  process.exit(1);
}
const docs = sampleDocs();
let first = "";
for (const file of process.argv.slice(2)) {
  const name = `local/${path.basename(file)}`;
  docs.set(name, { label: path.basename(file), bytes: new Uint8Array(fs.readFileSync(file)) });
  first ||= `?doc=${encodeURIComponent(name)}`;
}
const server = await serveCompare({ docs });
console.log(`${server.origin}/compare/${first}`);
