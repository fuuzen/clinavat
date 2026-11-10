import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
// Set by the Tauri CLI when a phone or emulator loads the dev server over the network.
const devHost = process.env.TAURI_DEV_HOST;

// The packaged default Hub comes from the build environment, so no deployment address lives in the source.
function defaultHub(env: Record<string, string>) {
  const value = env.CLINAVAT_CLIENT_HUB_URL?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`CLINAVAT_CLIENT_HUB_URL 不是有效地址：${value}`);
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("CLINAVAT_CLIENT_HUB_URL 必须是 http(s) 地址，不能包含账号、查询参数或片段");
  }
  return { url: url.href, name: env.CLINAVAT_CLIENT_HUB_NAME?.trim() || url.host };
}

export default defineConfig(({ mode }) => {
  // An empty prefix reads the CLINAVAT_CLIENT_* variables from client/.env* files and the shell.
  const env = loadEnv(mode, root, "");
  return {
    plugins: [react()],
    define: {
      __CLINAVAT_DEFAULT_HUB__: JSON.stringify(defaultHub(env)),
      __CLINAVAT_CLIENT_VERSION__: JSON.stringify(version),
    },
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      host: devHost || false,
      hmr: devHost ? { protocol: "ws", host: devHost, port: 1421 } : undefined,
      watch: { ignored: ["**/src-tauri/**"] },
    },
  };
});
