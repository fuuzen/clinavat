import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, normalize, sep } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { msw } from "msw/vite";

// pdf.js loads CJK character maps, standard fonts and image decoders at runtime; ship them same-origin under pdfjs/.
function pdfjsAssets(base: string): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const folders = ["cmaps", "standard_fonts", "wasm", "iccs"];
  return {
    name: "clinavat-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use(`${base}pdfjs`, (request, response, next) => {
        const relative = normalize(decodeURIComponent((request.url ?? "").split("?")[0])).replace(/^[/\\]+/, "");
        const target = join(root, relative);
        if (!folders.includes(relative.split(sep)[0]) || !target.startsWith(root + sep)) return next();
        try {
          if (!statSync(target).isFile()) return next();
        } catch {
          return next();
        }
        response.setHeader("Content-Type", target.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
        createReadStream(target).pipe(response);
      });
    },
    generateBundle() {
      for (const folder of folders) {
        // QuickJS only powers PDF form scripting, which the previewer never enables.
        for (const name of readdirSync(join(root, folder)).filter((file) => !file.startsWith("quickjs"))) {
          this.emitFile({ type: "asset", fileName: `pdfjs/${folder}/${name}`, source: readFileSync(join(root, folder, name)) });
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "..", "");
  const target = env.VITE_API_PROXY_TARGET;
  const base = env.VITE_BASE || "/";
  return {
    base,
    plugins: mode === "demo" ? [react(), pdfjsAssets(base), msw({ mode: "worker-only" })] : [react(), pdfjsAssets(base)],
    server: {
      port: Number(env.VITE_PORT || 5173),
      proxy: target ? { "/api": { target, ws: true } } : undefined,
    },
  };
});
