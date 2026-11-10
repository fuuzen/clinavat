import type { FileEntry, GitState } from "../src/types";
import { binarySamples, previewSamples } from "./preview-samples";

const files: Record<string, string> = {
  "README.md": "# 演示项目\n\n这是 Clinavat 在线预览使用的示例仓库，内容均为模拟数据。\n",
  "package.json": JSON.stringify({ name: "demo", version: "1.0.0", scripts: { dev: "vite", typecheck: "tsc -b" } }, null, 2),
  "src/app.ts": "export function createApp(config: AppConfig) {\n  const router = createRouter();\n  router.use(requestLogger(config.logLevel));\n  return { router, config };\n}\n",
  "src/config.ts": "export interface AppConfig {\n  port: number;\n  logLevel: \"debug\" | \"info\" | \"warn\";\n}\n",
  "src/cart/useCart.ts": "import { useReducer } from \"react\";\nimport { cartReducer, initialCart } from \"./reducer\";\n\nexport function useCart() {\n  const [cart, dispatch] = useReducer(cartReducer, initialCart);\n  return { cart, dispatch };\n}\n",
  "src/cart/reducer.ts": "export const initialCart = { items: [], coupon: null };\n\nexport function cartReducer(state, action) {\n  return state;\n}\n",
  ...previewSamples,
};
// A fixed timestamp keeps preview URLs stable across demo reloads.
const demoModified = Date.UTC(2026, 9, 26, 8, 0, 0);
const modified = new Map<string, number>();

const git: GitState = {
  branch: "feature/request-logging",
  status: " M src/app.ts\n?? src/cart/useCart.ts",
  diff: [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,4 +1,5 @@",
    " export function createApp(config: AppConfig) {",
    "   const router = createRouter();",
    "+  router.use(requestLogger(config.logLevel));",
    "   return { router, config };",
    " }",
  ].join("\n"),
};

const normalize = (path: string) => path.replace(/^\.?\/+|\/+$/g, "");

export function listFiles(directory: string): FileEntry[] {
  const prefix = normalize(directory) ? `${normalize(directory)}/` : "";
  const entries = new Map<string, FileEntry>();
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith(prefix)) continue;
    const [name, ...rest] = path.slice(prefix.length).split("/");
    entries.set(name, rest.length
      ? { name, path: prefix + name, type: "directory" }
      : { name, path, type: "file", size: new TextEncoder().encode(content).length });
  }
  return [...entries.values()].sort((left, right) =>
    left.type === right.type ? left.name.localeCompare(right.name) : left.type === "directory" ? -1 : 1);
}

export function readFile(path: string): string | undefined {
  return files[normalize(path)];
}

export function fileMeta(path: string) {
  const content = readFile(path);
  if (content === undefined) return undefined;
  const size = new TextEncoder().encode(content).length;
  const binary = binarySamples.has(normalize(path));
  const mtime = modified.get(normalize(path)) ?? demoModified;
  return { path, size, mtime, etag: `"${size.toString(36)}-${mtime.toString(36)}"`, binary, ...(binary ? {} : { content }) };
}

export function isDirectory(path: string): boolean {
  const prefix = `${normalize(path)}/`;
  return Object.keys(files).some((name) => name.startsWith(prefix));
}

// Uploaded binaries are kept as decoded text, so the demo previews them only approximately.
export function writeFile(path: string, bytes: Uint8Array) {
  const key = normalize(path);
  const text = new TextDecoder().decode(bytes);
  files[key] = text;
  if (bytes.includes(0) || text.includes("\uFFFD")) binarySamples.add(key);
  else binarySamples.delete(key);
  modified.set(key, Date.now());
  return fileMeta(key)!;
}

export function completePaths(query: string) {
  const directories = new Set(Object.keys(files).flatMap((path) =>
    path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"))));
  return [
    ...[...directories].map((path) => ({ path, type: "directory" as const })),
    ...Object.keys(files).map((path) => ({ path, type: "file" as const })),
  ].filter((entry) => entry.path.toLowerCase().includes(query.toLowerCase())).slice(0, 20);
}

export function gitState(): GitState {
  return git;
}

export function remoteDirectories(path: string): FileEntry[] {
  const base = path.replace(/\/+$/, "") || "";
  return ["projects", "workspace", "repos"].map((name) => ({ name, path: `${base}/${name}`, type: "directory" }));
}
