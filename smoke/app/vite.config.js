import { resolve } from "node:path";

import { defineConfig } from "vite";

// Only the two pages and the service worker. The package itself needs no configuration.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        readme: resolve(import.meta.dirname, "readme.html"),
        sw: resolve(import.meta.dirname, "sw.js"),
      },
      // A service worker is found by a fixed URL.
      output: { entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js") },
    },
  },
});
