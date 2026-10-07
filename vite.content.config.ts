import { defineConfig } from "vite";
import { resolve } from "path";

const dirname = import.meta.dirname;

// Builds the Gmail content script as a single self-contained IIFE with a
// fixed filename, separately from the main app (which needs normal
// hashed/code-split ES module output). Chrome's manifest-declared content
// scripts run as classic scripts, so they can't use ESM import/export.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: resolve(dirname, "src/content/content.ts"),
      name: "CorreoContent",
      formats: ["iife"],
      fileName: () => "content.js",
    },
  },
});
