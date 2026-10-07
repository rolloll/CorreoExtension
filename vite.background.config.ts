import { defineConfig } from "vite";
import { resolve } from "path";

const dirname = import.meta.dirname;

// Same rationale as vite.content.config.ts: the MV3 service worker needs a
// single self-contained script at a fixed path, separate from the main
// app's hashed/code-split build.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: resolve(dirname, "src/background.ts"),
      name: "CorreoBackground",
      formats: ["iife"],
      fileName: () => "background.js",
    },
  },
});
