import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { LanguageRegistration } from "shiki/core";
import { extensionOf, fileName } from "./fileKinds";

// Token colors come from CSS variables so highlighting follows every appearance preset.
const theme = createCssVariablesTheme({ name: "clinavat", variablePrefix: "--shiki-" });
// An explicit grammar list keeps the build to languages the previewer maps, instead of every grammar Shiki ships.
const languages: Record<string, () => Promise<{ default: LanguageRegistration[] }>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  fish: () => import("shiki/langs/fish.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  json5: () => import("shiki/langs/json5.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  sass: () => import("shiki/langs/sass.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  erlang: () => import("shiki/langs/erlang.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
  ocaml: () => import("shiki/langs/ocaml.mjs"),
  clojure: () => import("shiki/langs/clojure.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
  nim: () => import("shiki/langs/nim.mjs"),
  terraform: () => import("shiki/langs/terraform.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  prisma: () => import("shiki/langs/prisma.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  cmake: () => import("shiki/langs/cmake.mjs"),
  groovy: () => import("shiki/langs/groovy.mjs"),
  solidity: () => import("shiki/langs/solidity.mjs"),
  dotenv: () => import("shiki/langs/dotenv.mjs"),
};

const extensionLanguages: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx", py: "python", pyi: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", cs: "csharp", php: "php",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", fish: "fish", ps1: "powershell", yml: "yaml", yaml: "yaml",
  json: "json", jsonc: "jsonc", json5: "json5", toml: "toml", ini: "ini", cfg: "ini", conf: "ini", xml: "xml", html: "html",
  htm: "html", vue: "vue", svelte: "svelte", css: "css", scss: "scss", sass: "sass", less: "less", sql: "sql",
  md: "markdown", mdx: "mdx", lua: "lua", dart: "dart", scala: "scala", r: "r", pl: "perl", ex: "elixir", exs: "elixir",
  erl: "erlang", hs: "haskell", ml: "ocaml", clj: "clojure", zig: "zig", nim: "nim", tf: "terraform", hcl: "hcl",
  proto: "proto", graphql: "graphql", gql: "graphql", svg: "xml", diff: "diff", patch: "diff", prisma: "prisma",
  ipynb: "json", dockerfile: "docker", makefile: "make", mk: "make", cmake: "cmake", gradle: "groovy", groovy: "groovy", sol: "solidity",
};
const fileNameLanguages: Record<string, string> = {
  Dockerfile: "docker", Makefile: "make", "CMakeLists.txt": "cmake", ".bashrc": "shellscript", ".zshrc": "shellscript",
  ".gitignore": "shellscript", ".env": "dotenv",
};

export function languageFor(path: string): string | undefined {
  const name = fileName(path);
  const language = fileNameLanguages[name] ?? extensionLanguages[extensionOf(path)] ?? extensionOf(path);
  return language && language in languages ? language : undefined;
}

let highlighter: Promise<HighlighterCore> | undefined;
const loading = new Map<string, Promise<void>>();

async function ready(language: string): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
  const core = await highlighter;
  if (!core.getLoadedLanguages().includes(language)) {
    if (!loading.has(language)) loading.set(language, languages[language]().then(module => core.loadLanguage(module.default)));
    await loading.get(language);
  }
  return core;
}

// Highlighting beyond this size blocks the main thread noticeably; larger files fall back to plain lines.
export const highlightLimit = 400_000;

export async function highlight(code: string, language: string | undefined): Promise<string | undefined> {
  if (!language || code.length > highlightLimit) return undefined;
  if (!languages[language]) return undefined;
  const core = await ready(language);
  return core.codeToHtml(code, { lang: language, theme: "clinavat" });
}
