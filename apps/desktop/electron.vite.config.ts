import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    plugins: [
      react(),
      {
        name: "mikoshi-csp",
        transformIndexHtml: {
          order: "pre",
          handler(html, context) {
            const development = Boolean(context.server);
            const policy = [
              "default-src 'self'",
              "script-src 'self'" + (development ? " 'unsafe-inline'" : ""),
              // xterm.js generates runtime style rules for terminal dimensions.
              "style-src 'self' 'unsafe-inline'",
              "connect-src 'self'" +
                (development ? " ws://localhost:* ws://127.0.0.1:*" : ""),
              "img-src 'self'",
              "object-src 'none'",
              "base-uri 'none'",
              "form-action 'none'",
            ].join("; ");
            return html.replace("%MIKOSHI_CSP%", policy);
          },
        },
      },
    ],
  },
});
