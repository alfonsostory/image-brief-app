import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// These two headers make the page cross-origin isolated, which lets the in-browser transcriber run multi-threaded
// WebAssembly. Set the same headers wherever the built app is hosted, or transcription falls back to one thread.
const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, open: true, headers: isolation },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ["@huggingface/transformers"] },
});
