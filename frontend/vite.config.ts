import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { msw } from "msw/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "..", "");
  const target = env.VITE_API_PROXY_TARGET;
  return {
    base: env.VITE_BASE || "/",
    plugins: mode === "demo" ? [react(), msw({ mode: "worker-only" })] : [react()],
    server: {
      port: Number(env.VITE_PORT || 5173),
      proxy: target ? { "/api": { target, ws: true } } : undefined,
    },
  };
});
