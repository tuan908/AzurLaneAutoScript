import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { defineConfig } from "vitest/config";

// The backend (python gui.py) serves the built app at /dashboard/ and the API at /api/v1.
// In dev, proxy the API and present the backend's own origin, so its cross-site check passes.
const backend = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env["ALAS_BACKEND"] ?? "http://127.0.0.1:22267";

export default defineConfig({
  base: "/dashboard/",
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: backend,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => {
            if (req.getHeader("origin")) req.setHeader("origin", backend);
          });
        },
      },
    },
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
