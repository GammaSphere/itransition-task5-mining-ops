import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Same proxy as netlify.toml: /gsheets/<id>/gviz/tq -> docs.google.com/spreadsheets/d/<id>/gviz/tq
    proxy: {
      "/gsheets": {
        target: "https://docs.google.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/gsheets/, "/spreadsheets/d"),
      },
    },
  },
  build: { chunkSizeWarningLimit: 1200 },
});
