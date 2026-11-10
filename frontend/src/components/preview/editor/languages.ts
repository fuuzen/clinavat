import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";

// A curated list rather than @codemirror/language-data: its hundred-odd grammars alone push the production build
// past the memory of a small host. Other files are edited as plain text.
const legacy = (load: () => Promise<StreamParser<unknown>>) => async () => new LanguageSupport(StreamLanguage.define(await load()));
const javascript = (options: { jsx?: boolean; typescript?: boolean }) => async () =>
  (await import("@codemirror/lang-javascript")).javascript(options);

export const editorLanguages = [
  LanguageDescription.of({ name: "JavaScript", extensions: ["js", "mjs", "cjs"], load: javascript({}) }),
  LanguageDescription.of({ name: "JSX", extensions: ["jsx"], load: javascript({ jsx: true }) }),
  LanguageDescription.of({ name: "TypeScript", extensions: ["ts", "mts", "cts"], load: javascript({ typescript: true }) }),
  LanguageDescription.of({ name: "TSX", extensions: ["tsx"], load: javascript({ jsx: true, typescript: true }) }),
  LanguageDescription.of({ name: "JSON", extensions: ["json", "jsonc", "json5", "ipynb", "map"], load: async () => (await import("@codemirror/lang-json")).json() }),
  LanguageDescription.of({ name: "Python", extensions: ["py", "pyi", "pyw"], load: async () => (await import("@codemirror/lang-python")).python() }),
  LanguageDescription.of({ name: "Markdown", extensions: ["md", "markdown", "mdx"], load: async () => (await import("@codemirror/lang-markdown")).markdown() }),
  LanguageDescription.of({ name: "HTML", extensions: ["html", "htm", "vue", "svelte"], load: async () => (await import("@codemirror/lang-html")).html() }),
  LanguageDescription.of({ name: "CSS", extensions: ["css", "scss", "less"], load: async () => (await import("@codemirror/lang-css")).css() }),
  LanguageDescription.of({ name: "XML", extensions: ["xml", "svg", "xsd", "xsl", "plist", "csproj"], load: async () => (await import("@codemirror/lang-xml")).xml() }),
  LanguageDescription.of({ name: "YAML", extensions: ["yml", "yaml"], load: async () => (await import("@codemirror/lang-yaml")).yaml() }),
  LanguageDescription.of({ name: "Rust", extensions: ["rs"], load: async () => (await import("@codemirror/lang-rust")).rust() }),
  LanguageDescription.of({ name: "Go", extensions: ["go"], load: async () => (await import("@codemirror/lang-go")).go() }),
  LanguageDescription.of({ name: "Java", extensions: ["java"], load: async () => (await import("@codemirror/lang-java")).java() }),
  LanguageDescription.of({ name: "C++", extensions: ["c", "h", "cc", "cpp", "cxx", "hpp", "hh"], load: async () => (await import("@codemirror/lang-cpp")).cpp() }),
  LanguageDescription.of({ name: "SQL", extensions: ["sql"], load: async () => (await import("@codemirror/lang-sql")).sql() }),
  LanguageDescription.of({
    name: "Shell", extensions: ["sh", "bash", "zsh"], filename: /^\.(bashrc|zshrc|profile|bash_profile)$/,
    load: legacy(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell),
  }),
  LanguageDescription.of({
    name: "Dockerfile", filename: /^(Dockerfile|Containerfile)(\..+)?$/,
    load: legacy(async () => (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile),
  }),
  LanguageDescription.of({ name: "TOML", extensions: ["toml"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/toml")).toml) }),
  LanguageDescription.of({
    name: "Properties", extensions: ["ini", "cfg", "conf", "properties"], filename: /^\.env(\..+)?$/,
    load: legacy(async () => (await import("@codemirror/legacy-modes/mode/properties")).properties),
  }),
];
