// The repository's social preview, 1280 x 640: name, pitch, one number, one picture of what it does.
import fs from "node:fs";
import path from "node:path";

import { launch, newPage } from "../../bench/cdp.mjs";
import { DARK, FONT } from "./theme.mjs";

const root = path.join(import.meta.dirname, "../..");
const node = JSON.parse(fs.readFileSync(path.join(root, "bench/results/node.json"), "utf8"));
const page = fs.readFileSync(path.join(root, "docs/anatomy.png")).toString("base64");
const ratio = node.summary.text["pdf.js"].ratio;
const html = `<!doctype html><meta charset=utf-8><style>
*{box-sizing:border-box}body{margin:0;width:1280px;height:640px;background:${DARK.surface};color:${DARK.text};font-family:${FONT};overflow:hidden;position:relative}
.left{position:absolute;left:80px;top:96px;width:640px}
h1{font-size:112px;font-weight:700;letter-spacing:-.03em;margin:0 0 20px}
p{font-size:34px;line-height:1.28;color:${DARK.secondary};margin:0}
.n{margin-top:52px;font-size:40px;font-weight:650;letter-spacing:-.01em}.n i{font-style:normal;color:${DARK.recto}}
.s{margin-top:8px;font-size:22px;color:${DARK.secondary}}
img{position:absolute;right:64px;top:64px;width:424px;border-radius:10px;box-shadow:0 12px 50px #0009;transform:rotate(1.5deg)}
</style><div class="left"><h1>recto</h1><p>A PDF engine for JavaScript: text with positions, page objects and rendering, in Rust compiled to WebAssembly.</p><div class="n"><i>${ratio.toFixed(1)}×</i> faster text than pdf.js</div><div class="s">Measured in Node on 60 public PDFs</div></div><img src="data:image/png;base64,${page}">`;
const browser = await launch({ width: 1280, height: 640 });
const tab = await newPage(browser, { width: 1280, height: 640 });
await tab.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 640, deviceScaleFactor: 1, mobile: false });
await tab.send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` });
await new Promise((resolve) => setTimeout(resolve, 800));
const { data } = await tab.send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(root, "docs/social.png"), Buffer.from(data, "base64"));
await tab.close();
await browser.close();
console.log(`docs/social.png: ${(fs.statSync(path.join(root, "docs/social.png")).size / 1024).toFixed(0)} KB`);
process.exit(0);
