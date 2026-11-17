import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Tauri expects a fixed dev port (see devUrl in desktop/tauri.conf.json).
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/dist/**"] },
  },
  // xterm loads with the first terminal (#353): pre-bundle it at start, so
  // the dev server does not find it on that first import and reload the page.
  optimizeDeps: {
    include: ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-search"],
  },
  build: {
    // WebKitGTK (Linux), WKWebView (macOS) and WebView2 (Windows).
    target: ["safari15", "chrome105"],
    sourcemap: false,
  },
});
