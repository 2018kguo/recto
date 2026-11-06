// One pane of the film: one engine opens the document and fills the grid, page by page, with the
// counters measured here. The clock starts before the engine is loaded, so loading it counts.
import { connect } from "/app/client.mjs";

const params = new URLSearchParams(location.search);
const name = params.get("engine");
let began = 0;
const start = () => (began ? performance.now() - began : 0);
const $ = (id) => document.getElementById(id);
$("name").textContent = name;
document.documentElement.style.setProperty("--hue", params.get("hue"));
const clock = () => (start() / 1000).toFixed(1);
let done = false;
const tick = () => {
  if (!done) {
    $("time").textContent = `${clock()} s`;
    requestAnimationFrame(tick);
  }
};
tick();

const go = async () => {
  await new Promise((resolve) => (window.begin = resolve));
  began = performance.now();
  const client = await connect(name);
  const bytes = new Uint8Array(await (await fetch(params.get("doc"))).arrayBuffer());
  const count = await client.open(bytes);
  $("wait").remove();
  $("sub").textContent = `0 of ${count} pages`;
  const scroller = $("scroll");
  for (let i = 0; i < count; i++) {
    await client.text(i);
    $("grid").append(await client.render(i, Number(params.get("width"))));
    // Only what's in view stays, so layout and canvas memory don't grow into either engine's time.
    if ($("grid").children.length > 15) for (let k = 0; k < 3; k++) $("grid").firstChild.remove();
    $("sub").textContent = `${i + 1} of ${count} pages, text and pixels`;
    $("fill").style.width = `${((i + 1) / count) * 100}%`;
    scroller.scrollTop = scroller.scrollHeight;
  }
  done = true;
  const total = start();
  $("time").textContent = `${(total / 1000).toFixed(1)} s`;
  $("sub").textContent = `${count} of ${count} pages. Done.`;
  // The screencast sends a frame only when something changes and can miss the last change, so a
  // few changes nobody can see, to carry the final counters through.
  for (let i = 0; i < 40; i++) {
    $("fill").style.opacity = i % 2 ? "1" : "0.99";
    await new Promise(requestAnimationFrame);
  }
  window.result = { total, pages: count };
};
go().catch((error) => {
  window.result = { failure: String(error) };
});
