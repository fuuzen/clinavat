import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { Compartment, EditorState, type Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { resolveTheme, useTheme } from "../../../theme";
import { fileName } from "../fileKinds";
import { editorPhrases, editorTheme } from "./editorTheme";
import { editorLanguages } from "./languages";

export interface EditorHandle {
  value: () => string;
}

interface Props {
  /** Read once when the editor mounts; remount it to load other content. */
  initial: string;
  /** The last saved content; the editor is dirty while its text differs from it. */
  baseline: string;
  path: string;
  wrap: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSave: () => void;
  ref?: Ref<EditorHandle>;
}

export default function TextEditor({ initial, baseline, path, wrap, onDirtyChange, onSave, ref }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [initialDoc] = useState(initial);
  const [compartments] = useState(() => ({ language: new Compartment(), wrap: new Compartment(), theme: new Compartment() }));
  const baselineText = useRef<Text | null>(null);
  const reportedDirty = useRef(false);
  const callbacks = useRef({ onDirtyChange, onSave });
  useEffect(() => {
    callbacks.current = { onDirtyChange, onSave };
  });
  const { preferences } = useTheme();
  const dark = resolveTheme(preferences).mode === "dark";
  const reportDirty = useRef((doc: Text) => {
    const dirty = !!baselineText.current && !doc.eq(baselineText.current);
    if (dirty === reportedDirty.current) return;
    reportedDirty.current = dirty;
    callbacks.current.onDirtyChange(dirty);
  });

  useImperativeHandle(ref, () => ({ value: () => view.current?.state.doc.toString() ?? "" }), []);

  // Runs once per mount; later wrap and theme changes go through their compartments below.
  useEffect(() => {
    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab, { key: "Mod-s", preventDefault: true, run: () => (callbacks.current.onSave(), true) }]),
        // Splitting on any line break would silently turn a CRLF file into LF on save.
        initialDoc.includes("\r\n") ? EditorState.lineSeparator.of("\r\n") : [],
        editorPhrases,
        compartments.language.of([]),
        compartments.wrap.of(wrap ? EditorView.lineWrapping : []),
        compartments.theme.of(editorTheme(dark)),
        EditorView.updateListener.of((update) => update.docChanged && reportDirty.current(update.state.doc)),
      ],
    });
    const editor = new EditorView({ state, parent: host.current! });
    view.current = editor;
    editor.focus();
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [initialDoc, compartments]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    baselineText.current = editor.state.toText(baseline);
    reportDirty.current(editor.state.doc);
  }, [baseline]);

  useEffect(() => {
    let cancelled = false;
    void LanguageDescription.matchFilename(editorLanguages, fileName(path))?.load().then((support: LanguageSupport) => {
      if (!cancelled) view.current?.dispatch({ effects: compartments.language.reconfigure(support) });
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path, compartments]);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap, compartments]);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.theme.reconfigure(editorTheme(dark)) });
  }, [dark, compartments]);

  return <div className="text-editor" ref={host} />;
}
