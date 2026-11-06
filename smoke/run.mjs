#!/usr/bin/env node
// The package as a stranger gets it: `npm pack`, install the tarball in an empty directory
// outside the repo, run the README's snippets verbatim, then bundle a Web Worker with Vite
// (dev server and production build) and drive it in a real browser.
//
//   npm run smoke
//   RECTO_SMOKE_DIR=/some/empty/dir RECTO_SMOKE_BROWSERS=chromium,firefox,webkit npm run smoke
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const VITE = process.env.RECTO_SMOKE_VITE ?? "8.3.6";
const PLAYWRIGHT = "1.64.1";
const TYPESCRIPT = "5.9.3";
const browsers = (process.env.RECTO_SMOKE_BROWSERS ?? "chromium").split(",");
const dir = process.env.RECTO_SMOKE_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "recto-smoke-"));
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const run = (command, args, cwd = dir) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const step = (name) => console.log(`\n== ${name}`);

step("pack");
if (!fs.existsSync(path.join(root, "js/wasm/recto.wasm"))) {
  run("npm", ["run", "build"], root);
} else {
  run("npm", ["run", "build:ts"], path.join(root, "js"));
}
run("npx", ["publint"], path.join(root, "js"));
const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dir], path.join(root, "js")))[0];
const shipped = packed.files.map((f) => f.path);
console.log(`${packed.filename}: ${packed.size} bytes packed, ${packed.unpackedSize} unpacked, ${shipped.length} files`);
for (const name of ["wasm/recto.wasm", "wasm/recto.gen.mjs", "wasm/pins.mjs", "wasm/fonts.bin", "wasm/cjk-fallback.ttf", "wasm/cmaps.brotli", "wasm/THIRD_PARTY_NOTICES", "dist/index.js", "dist/index.d.ts", "LICENSE", "README.md"]) {
  assert.ok(shipped.includes(name), `the tarball has ${name}`);
}
assert.ok(!shipped.some((f) => /^(src|test)\//u.test(f)), "the tarball has no source or tests");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "js/package.json"), "utf8"));
assert.equal(manifest.dependencies, undefined, "zero runtime dependencies");
assert.ok(!Object.keys(manifest.scripts).some((s) => /install/u.test(s)), "no install scripts");

step(`install in ${dir}`);
fs.writeFileSync(
  path.join(dir, "package.json"),
  JSON.stringify({
    type: "module",
    private: true,
    dependencies: {
      "@2018kguo/recto": `file:./${packed.filename}`,
      vite: VITE,
      playwright: PLAYWRIGHT,
      typescript: TYPESCRIPT,
    },
  }),
);
run("npm", ["install", "--no-audit", "--no-fund"]);
const resolved = run("node", ["--input-type=module", "-e", 'console.log(import.meta.resolve("@2018kguo/recto"))']).trim();
assert.ok(fs.realpathSync(new URL(resolved)).startsWith(fs.realpathSync(dir)), `resolved outside the install: ${resolved}`);

/** Two pages of Helvetica, which the file does not embed: blank if fonts.bin went missing. */
function samplePdf() {
  const page = (id, text) => {
    const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
    return [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents ${id + 1} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ];
  };
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    ...page(3, "Hello from recto"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...page(6, "The second page"),
  ];
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
  return out;
}
const sample = samplePdf();
const cjk = fs.readFileSync(path.join(root, "js/test/fixtures/cjk-predefined-cmap.pdf"));

// The README's code blocks, under a heading, by the file each says it is.
function readmeBlocks(heading) {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const start = readme.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, heading);
  const end = readme.slice(start + heading.length + 2).search(/^#{1,3} /mu);
  const section = readme.slice(start, end < 0 ? undefined : start + heading.length + 2 + end);
  return [...section.matchAll(/```js\n(.*?)```/gsu)].map(([, code], i) => ({
    name: /^\/\/ (\S+\.js)\n/u.exec(code)?.[1] ?? `snippet${i}.js`,
    code,
  }));
}

step("the types, as a strict TypeScript consumer sees them");
fs.writeFileSync(
  path.join(dir, "consumer.ts"),
  `import { createPdfEngine, openPdf, PdfError, type PdfErrorCode, type PdfPageText } from "@2018kguo/recto";
await using doc = await openPdf(new Uint8Array(1), { password: "x" });
const count: number = doc.pageCount;
const page: PdfPageText = doc.text(0);
const pixels: Uint8Array = doc.render(0, { width: 1024 }).rgba;
const engine = await createPdfEngine({ assetBase: "/recto/" });
using ranged = await engine.openRanged("https://example.com/a.pdf", { maxBytes: 1 << 20 });
const fetched: number = ranged.stats().bytesFetched;
const failure: unknown = null;
const code: PdfErrorCode | null = failure instanceof PdfError ? failure.code : null;
export { code, count, fetched, page, pixels };
`,
);
fs.writeFileSync(
  path.join(dir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      noEmit: true,
      strict: true,
      target: "ES2023",
      module: "NodeNext",
      lib: ["ES2023", "ESNext.Disposable", "DOM"],
      types: [],
      skipLibCheck: false,
    },
    files: ["consumer.ts"],
  }),
);
run(path.join(dir, "node_modules/.bin/tsc"), ["-p", "."]);

step("the README's Node snippets, verbatim");
const nodeDir = path.join(dir, "node");
fs.mkdirSync(nodeDir);
fs.writeFileSync(path.join(nodeDir, "report.pdf"), sample, "latin1");
const blocks = readmeBlocks("## Use it");
assert.ok(blocks.length >= 3, "the first snippet and the worker_threads pair");
for (const { name, code } of blocks) {
  fs.writeFileSync(path.join(nodeDir, name), code);
}
const first = run("node", [blocks[0].name], nodeDir);
console.log(first.trim());
assert.match(first, /2 Hello from recto/u);
assert.match(first, /1024 1326/u);
const threaded = blocks.find((block) => block.code.includes('new Worker(new URL("./pdf-thread.js"'));
const second = run("node", [threaded.name], nodeDir);
console.log(second.trim());
assert.match(second, /Hello from recto/u);

step("bundle a Web Worker with Vite");
const appDir = path.join(dir, "app");
fs.cpSync(path.join(root, "smoke/app"), appDir, { recursive: true });
fs.mkdirSync(path.join(appDir, "public"));
fs.writeFileSync(path.join(appDir, "public/report.pdf"), sample, "latin1");
for (const { name, code } of readmeBlocks("### In a browser")) {
  fs.writeFileSync(path.join(appDir, name), code);
}
fs.writeFileSync(path.join(appDir, "readme.html"), '<!doctype html><script type="module" src="./main.js"></script>\n');
const vite = path.join(dir, "node_modules/.bin/vite");
run(vite, ["build", "--logLevel", "warn"], appDir);

// Serves files, and a PDF cross-origin with good and bad Range behaviour by path.
const serveFile = (directory) => (req, res) => {
  const file = path.join(directory, new URL(req.url, "http://x").pathname);
  const target = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, "index.html") : file;
  if (!fs.existsSync(target)) {
    res.writeHead(404).end();
    return;
  }
  const type = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" }[path.extname(target)];
  res.writeHead(200, type ? { "Content-Type": type } : {}).end(fs.readFileSync(target));
};
const pdfs = (req, res) => {
  const [, mode, name] = new URL(req.url, "http://x").pathname.split("/");
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Range" };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors).end();
    return;
  }
  const body = name === "cjk.pdf" ? cjk : Buffer.from(sample, "latin1");
  const match = /bytes=(\d+)-(\d+)/u.exec(req.headers.range ?? "");
  if (mode === "ignore" || !match) {
    res.writeHead(200, cors).end(body);
    return;
  }
  const start = Number(match[1]);
  const end = Math.min(Number(match[2]), body.byteLength - 1);
  const part = body.subarray(start, end + 1);
  const headers = { ...cors, "Content-Range": `bytes ${start}-${end}/${body.byteLength}` };
  if (mode !== "noexpose") {
    headers["Access-Control-Expose-Headers"] = "Content-Range";
  }
  res.writeHead(206, headers).end(mode === "short" ? part.subarray(0, part.byteLength >> 1) : part);
};
const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
const pdfServer = await listen(pdfs);
const pdfBase = `http://127.0.0.1:${pdfServer.address().port}`;

const playwright = await import(path.join(dir, "node_modules/playwright/index.mjs"));
run("npx", ["playwright", "install", ...browsers]);

async function checkPages(browserName, label, origin) {
  const browser = await playwright[browserName].launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const logged = [];
    page.on("console", (message) => logged.push(message.text()));

    await page.goto(`${origin}/readme.html`);
    for (let i = 0; i < 300 && !logged.some((line) => line.includes("Hello from recto")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(logged.some((line) => line.includes("Hello from recto")), `README worker logged: ${logged.join(" | ")}`);

    await page.goto(`${origin}/index.html?pdfs=${encodeURIComponent(pdfBase)}`);
    await page.waitForFunction(() => window.smokeResult, null, { timeout: 60_000 });
    const checks = await page.evaluate(() => window.smokeResult);
    assert.deepEqual(errors, [], "no uncaught errors");
    assert.equal(checks.failure, undefined, checks.failure);
    assert.equal(checks.mainThread.code, "wrong-thread");
    assert.match(checks.mainThread.message, /Web Worker/u);
    assert.match(checks.latin.text, /Hello from recto/u);
    assert.deepEqual([checks.latin.width, checks.latin.height], [1024, 1326]);
    assert.ok(checks.latin.ink > 500, `ink ${checks.latin.ink}`);
    assert.equal(checks.closed, "closed");
    assert.deepEqual(checks.cjk.texts, ["中文", "中文", "日本", "한국"]);
    assert.ok(checks.cjk.ink > 100, `CJK ink ${checks.cjk.ink}`);
    assert.equal(checks.ranged.pageCount, 2);
    assert.match(checks.ranged.text, /second page/u);
    assert.equal(checks.ignored.pageCount, 2);
    assert.equal(checks.ignored.requests, 1);
    assert.equal(checks.short, "fetch-failed");
    assert.equal(checks.noExpose.code, "fetch-failed");
    assert.match(checks.noExpose.message, /Content-Range/u);
    assert.equal(checks.missingAsset.code, "missing-asset");
    console.log(`${browserName}, ${label}: ok (${JSON.stringify({ wasmMs: checks.startMs, ink: checks.latin.ink })})`);
  } finally {
    await browser.close();
  }
}

const preview = await listen(serveFile(path.join(appDir, "dist")));
let failed = false;
const devServer = spawn(vite, ["--port", "0", "--strictPort", "false", "--host", "127.0.0.1"], {
  cwd: appDir,
  stdio: ["ignore", "pipe", "inherit"],
});
const devOrigin = await new Promise((resolve, reject) => {
  let seen = "";
  devServer.stdout.on("data", (chunk) => {
    seen += chunk;
    // The address is coloured in a terminal; strip the escapes.
    const match = /http:\/\/127\.0\.0\.1:\d+/u.exec(seen.replace(/\[[0-9;]*m/gu, ""));
    if (match) {
      resolve(match[0]);
    }
  });
  devServer.once("exit", () => reject(new Error(`vite dev exited: ${seen}`)));
});
try {
  for (const browser of browsers) {
    await checkPages(browser, "vite build", `http://127.0.0.1:${preview.address().port}`);
    await checkPages(browser, "vite dev", devOrigin);
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  devServer.removeAllListeners("exit");
  devServer.kill();
  preview.close();
  pdfServer.close();
}
if (failed) {
  process.exit(1);
}
console.log("\nsmoke ok");
