import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // three.js is most of the page; kept apart it is parsed from the browser's code cache
    // after the first visit, and a change to the page's own code leaves it untouched.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // The file icons change only when a new one is added, so they are cached apart from the code too.
          if (/[\\/]src[\\/]icons[\\/]/.test(id)) return "icons";
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](three|three-spritetext)[\\/]/.test(id)) return "three";
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
          return "vendor";
        },
      },
    },
  },
  server: {
    // `npm run dev -w @vertskim/ui` next to a running `vertskim ui --no-open`.
    proxy: { "/api": "http://127.0.0.1:4517" },
  },
});
