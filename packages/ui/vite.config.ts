import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // three.js is large and there is nothing to split it from: the page is one screen.
    chunkSizeWarningLimit: 2500,
  },
  server: {
    // `npm run dev -w @vertskim/ui` next to a running `vertskim ui --no-open`.
    proxy: { "/api": "http://127.0.0.1:4517" },
  },
});
