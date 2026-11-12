#!/usr/bin/env node
// The viewer on a page of its own: open a dropped or chosen PDF, or a generated sample.
//
//   npm run build
//   npm run demo [-- file.pdf]      then open the URL it prints
//
// A PDF named on the command line is served at /doc/<its name> and opened at once.
import fs from "node:fs";
import path from "node:path";

import { reportPdf } from "./generate.mjs";
import { serve } from "./serve.mjs";

const here = import.meta.dirname;
if (!fs.existsSync(path.join(here, "../js/dist/viewer/index.js"))) {
  console.error("The viewer isn't built yet: run `npm run build` first.");
  process.exit(1);
}
const server = await serve({ extraRoots: { demo: path.join(here, "viewer-demo") } });
server.docs.set("sample.pdf", reportPdf({ pages: 60, imageEvery: 4, imageSize: 320, outline: true }));
let open = "";
const file = process.argv[2];
if (file) {
  const name = path.basename(file);
  server.docs.set(name, new Uint8Array(fs.readFileSync(file)));
  open = `?src=${encodeURIComponent(`/doc/${name}`)}`;
}
console.log(`${server.origin}/demo/index.html${open}`);
