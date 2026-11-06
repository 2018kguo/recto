// A small DevTools Protocol client over one Chromium process: Playwright's own API can't read a
// dedicated worker's heap, or start a browser under a task policy.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";

/**
 * Keeps the whole browser stopped for all but 1/`slowdown` of the time, by SIGSTOP and SIGCONT on
 * its process tree (what cpulimit does). Every thread slows alike, and timers and frames still run
 * at about their usual pace. Two other ways of slowing it were wrong: DevTools CPU throttling
 * reaches only a page's main thread ("Operation is only supported for pages, not workers"), so it
 * slows one engine's renderer and not another's; macOS background QoS (taskpolicy) makes every
 * timer and frame take 200 ms, which charges pdf.js, the engine that yields, 20× for it.
 */
function throttle(proc, slowdown) {
  const RUN_MS = 2;
  let pids = [proc.pid];
  let alive = true;
  const signal = (name) => {
    for (const pid of pids) {
      try {
        process.kill(pid, name);
      } catch {
        // It exited since the last look at the tree.
      }
    }
  };
  const look = () => {
    execFile("ps", ["-A", "-o", "pid=,ppid="], (error, stdout) => {
      if (error || !alive) return;
      const children = new Map();
      for (const line of stdout.trim().split("\n")) {
        const [pid, parent] = line.trim().split(/\s+/u).map(Number);
        children.set(parent, [...(children.get(parent) ?? []), pid]);
      }
      const tree = [proc.pid];
      for (const pid of tree) tree.push(...(children.get(pid) ?? []));
      pids = tree;
      setTimeout(look, 50).unref();
    });
  };
  const run = () => {
    if (!alive) return;
    signal("SIGCONT");
    setTimeout(() => {
      if (!alive) return;
      signal("SIGSTOP");
      setTimeout(run, RUN_MS * (slowdown - 1)).unref();
    }, RUN_MS).unref();
  };
  look();
  run();
  return () => {
    alive = false;
  };
}

export async function launch({ width = 1280, height = 800, slowdown = 1 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "recto-chromium-"));
  const proc = spawn(
    chromium.executablePath(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "--no-first-run",
      "--enable-precise-memory-info",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-gpu-watchdog",
      "--disable-hang-monitor",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  process.once("exit", () => proc.kill("SIGKILL"));
  const url = await new Promise((resolve, reject) => {
    let seen = "";
    proc.stderr.on("data", (chunk) => {
      seen += chunk;
      const match = /ws:\/\/[^\s]+/u.exec(seen);
      if (match) resolve(match[0]);
    });
    proc.once("exit", () => reject(new Error(`chromium exited: ${seen}`)));
  });
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const stopThrottle = slowdown > 1 ? throttle(proc, slowdown) : () => {};
  let next = 1;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message}`));
      else resolve(message.result);
    } else {
      for (const listener of listeners) listener(message);
    }
  };
  // Nothing a benchmark asks takes this long; a browser that stopped answering must not hang it.
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`DevTools: no answer to ${method} after 10 minutes`));
      }, 600_000);
      timer.unref();
      pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  return {
    send,
    on: (listener) => listeners.add(listener),
    off: (listener) => listeners.delete(listener),
    async close() {
      stopThrottle();
      proc.removeAllListeners("exit");
      proc.kill("SIGKILL");
      ws.close();
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/** A fresh isolated page: no cache, no storage, and its workers reachable as `workers`. */
export async function newPage(browser, { width = 1280, height = 800 } = {}) {
  const { browserContextId } = await browser.send("Target.createBrowserContext");
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId, width, height });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const logs = [];
  const workers = [];
  const listener = async (message) => {
    if (message.method === "Target.attachedToTarget") {
      const child = message.params.sessionId;
      if (message.params.targetInfo.type === "worker") {
        workers.push(child);
        await browser.send("Runtime.enable", {}, child).catch(() => {});
      }
      await browser.send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => {});
    } else if (message.method === "Runtime.exceptionThrown") {
      logs.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    } else if (message.method === "Runtime.consoleAPICalled") {
      logs.push(message.params.args.map((a) => a.value ?? a.description).join(" "));
    }
  };
  browser.on(listener);
  await browser.send("Page.enable", {}, sessionId);
  await browser.send("Runtime.enable", {}, sessionId);
  await browser.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
  return {
    sessionId,
    logs,
    workers,
    send: (method, params) => browser.send(method, params, sessionId),
    goto: (url) => browser.send("Page.navigate", { url }, sessionId),
    async evaluate(expression, { session = sessionId } = {}) {
      const { result, exceptionDetails } = await browser.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        session,
      );
      if (exceptionDetails) {
        throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      }
      return result.value;
    },
    async close() {
      browser.off(listener);
      await browser.send("Target.closeTarget", { targetId });
      await browser.send("Target.disposeBrowserContext", { browserContextId });
    },
  };
}
