import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

// Token colors use the read-only highlighter's CSS variables, so editing and previewing look alike under every preset.
const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.modifier, tags.self, tags.tagName], color: "var(--shiki-token-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.escape, tags.character, tags.inserted], color: "var(--shiki-token-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit, tags.constant(tags.variableName), tags.typeName, tags.className, tags.namespace], color: "var(--shiki-token-constant)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: "var(--shiki-token-function)" },
  { tag: tags.heading, color: "var(--shiki-token-function)", fontWeight: "600" },
  { tag: [tags.definition(tags.variableName), tags.attributeName, tags.labelName, tags.special(tags.variableName)], color: "var(--shiki-token-parameter)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment, tags.meta, tags.processingInstruction], color: "var(--shiki-token-comment)", fontStyle: "italic" },
  { tag: [tags.punctuation, tags.bracket, tags.angleBracket, tags.separator, tags.operator], color: "var(--shiki-token-punctuation)" },
  { tag: [tags.link, tags.url], color: "var(--shiki-token-link)", textDecoration: "underline" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.invalid, tags.deleted], color: "var(--danger)" },
]);

const translucent = (color: string, percent: number) => `color-mix(in srgb, var(${color}) ${percent}%, transparent)`;

export function editorTheme(dark: boolean) {
  return [
    EditorView.theme({
      "&": { height: "100%", color: "var(--text-secondary)", backgroundColor: "transparent", fontSize: "12px" },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.75" },
      ".cm-content": { caretColor: "var(--accent)", padding: "12px 0 16px" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: translucent("--accent", 26),
      },
      ".cm-gutters": { backgroundColor: "var(--panel)", color: translucent("--muted", 80), border: "none", borderRight: "1px solid var(--line)" },
      ".cm-activeLine": { backgroundColor: translucent("--hover", 55) },
      ".cm-activeLineGutter": { backgroundColor: "var(--hover)", color: "var(--text-secondary)" },
      ".cm-foldPlaceholder": { backgroundColor: "var(--surface)", border: "1px solid var(--line)", color: "var(--muted)" },
      "&.cm-focused .cm-matchingBracket": { backgroundColor: translucent("--accent", 20), outline: "1px solid " + translucent("--accent", 45) },
      "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: translucent("--danger", 25) },
      ".cm-selectionMatch": { backgroundColor: translucent("--info", 20) },
      ".cm-searchMatch": { backgroundColor: translucent("--warning", 26), outline: "1px solid " + translucent("--warning", 50) },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: translucent("--accent", 38) },
      ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--text)" },
      ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
      ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },
      ".cm-panel.cm-search": { padding: "6px 10px", fontSize: "12px" },
      ".cm-panel.cm-search label": { fontSize: "12px", color: "var(--text-secondary)" },
      ".cm-textfield": { backgroundColor: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: "5px", color: "var(--text)", fontSize: "12px" },
      ".cm-button": { backgroundImage: "none", backgroundColor: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: "5px", color: "var(--text-secondary)", fontSize: "12px" },
      ".cm-tooltip": { backgroundColor: "var(--panel)", border: "1px solid var(--line-strong)", borderRadius: "6px", color: "var(--text)" },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent-dim)", color: "var(--text)" },
      ".cm-specialChar": { color: "var(--danger)" },
    }, { dark }),
    syntaxHighlighting(highlightStyle),
  ];
}

// CodeMirror's own panel and status texts, for the phrases the default setup shows.
export const editorPhrases = EditorState.phrases.of({
  Find: "查找",
  Replace: "替换",
  next: "下一个",
  previous: "上一个",
  all: "全部",
  "match case": "区分大小写",
  regexp: "正则表达式",
  "by word": "全字匹配",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  "current match": "当前匹配",
  "on line": "位于第",
  "replaced match on line $": "已替换第 $ 行的匹配",
  "replaced $ matches": "已替换 $ 处匹配",
  "Go to line": "跳转到行",
  go: "跳转",
  "Folded lines": "已折叠的行",
  "Unfolded lines": "已展开的行",
  "Fold line": "折叠",
  "Unfold line": "展开",
  "folded code": "已折叠的代码",
  unfold: "展开",
  "Control character": "控制字符",
});
