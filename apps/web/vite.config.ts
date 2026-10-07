import { webLicensePlugin } from "../../scripts/licenses.mjs";
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const apiProxy: ProxyOptions = {
  target: "http://127.0.0.1:4111",
  changeOrigin: true,
  configure(proxy) {
    proxy.on('proxyReq', (forwarded, request) => {
      // Only normalize our own development UI origin; preserve hostile origins
      // so the backend's CSRF and local-host checks still reject them.
      if (['http://127.0.0.1:4173', 'http://localhost:4173'].includes(request.headers.origin)) {
        forwarded.setHeader('origin', 'http://127.0.0.1:4111');
      }
    });
  },
};

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), webLicensePlugin()],
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": apiProxy,
      "/app": apiProxy,
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
