import { resolve } from "node:path";

import { defineConfig } from "vite";

// Only the two pages. The package itself needs no configuration.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        readme: resolve(import.meta.dirname, "readme.html"),
      },
    },
  },
});
