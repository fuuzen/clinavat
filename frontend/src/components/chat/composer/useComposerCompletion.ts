import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { api, errorText } from '../../../api';
import { completionToken, referenceCompletion } from './completion-token';
import type { ComposerCommand } from './commands';

export interface CompletionOption {
  key: string;
  label: string;
  description: string;
  type: 'command' | 'file' | 'directory';
  value: string;
}
interface Props {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  onDraftChange: (value: string) => void;
  projectId?: string;
  commands: ComposerCommand[];
  enabled: boolean;
}
interface PathResult { entries: { path: string; type: 'file' | 'directory' }[]; truncated: boolean }
interface PathState extends PathResult { key: string; loading: boolean; error: string }
const emptyPaths: PathResult = { entries: [], truncated: false };

export function useComposerCompletion(props: Props) {
  const listId = useId();
  const [cursor, setCursor] = useState(0);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pathState, setPathState] = useState<PathState>({ ...emptyPaths, key: '', loading: false, error: '' });
  const pendingCaret = useRef<{ projectId?: string; draft: string; cursor: number } | null>(null);
  const token = useMemo(() => completionToken(props.draft, cursor), [props.draft, cursor]);
  const tokenKey = `${props.projectId}:${token?.kind}:${token?.query}:${cursor}:${props.draft}`;
  const open = props.enabled && focused && !composing && !!token && dismissed !== tokenKey;
  const pathQuery = open && token?.kind === 'path' ? token.query : null;
  const requestKey = pathQuery !== null && props.projectId ? `${props.projectId}:${pathQuery}` : '';
  const paths = requestKey && pathState.key === requestKey ? pathState : emptyPaths;
  const loading = !!requestKey && (pathState.key !== requestKey || pathState.loading);
  const error = requestKey && pathState.key === requestKey ? pathState.error : '';

  useEffect(() => {
    setSelectedIndex(0);
    if (pathQuery === null || !props.projectId) return;
    const controller = new AbortController();
    setPathState({ ...emptyPaths, key: requestKey, loading: true, error: '' });
    const timeout = window.setTimeout(() => {
      void api<PathResult>(`/projects/${props.projectId}/completions?query=${encodeURIComponent(pathQuery)}`, { signal: controller.signal })
        .then(result => {
          if (!controller.signal.aborted) setPathState({ ...result, key: requestKey, loading: false, error: '' });
        })
        .catch(problem => {
          if (!controller.signal.aborted) setPathState({ ...emptyPaths, key: requestKey, loading: false, error: errorText(problem) });
        });
    }, 120);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [pathQuery, props.projectId, requestKey]);

  const options: CompletionOption[] = useMemo(() => token?.kind === 'command'
    ? props.commands.filter(command => command.name.toLowerCase().startsWith(token.query.toLowerCase())).map(command => ({
      key: command.name, label: `/${command.name}`, description: command.description + (command.argumentHint ? ` · ${command.argumentHint}` : ''),
      type: 'command' as const, value: `/${command.name} `,
    }))
    : paths.entries.map(entry => ({ key: entry.path, label: entry.path + (entry.type === 'directory' ? '/' : ''),
      description: entry.type === 'directory' ? '目录 · Tab 继续浏览' : '文件 · 引用到消息', type: entry.type,
      value: referenceCompletion(entry.path, entry.type === 'directory'),
    })), [token?.kind, token?.query, props.commands, paths.entries]);

  useEffect(() => { setSelectedIndex(0); }, [token?.query, token?.kind]);
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const pending = pendingCaret.current;
    pendingCaret.current = null;
    if (pending.projectId !== props.projectId || pending.draft !== props.draft) return;
    props.inputRef.current?.setSelectionRange(pending.cursor, pending.cursor);
    setCursor(pending.cursor);
  }, [props.draft, props.inputRef, props.projectId]);

  function accept(index = selectedIndex) {
    const option = options[Math.min(index, options.length - 1)];
    if (!token || !option) return;
    const value = props.draft.slice(0, token.start) + option.value + props.draft.slice(token.end);
    const caret = token.start + option.value.length - (option.type === 'directory' && option.value.endsWith('"') ? 1 : 0);
    pendingCaret.current = { projectId: props.projectId, draft: value, cursor: caret };
    props.onDraftChange(value);
    setCursor(caret);
    props.inputRef.current?.focus({ preventScroll: true });
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (event.nativeEvent.isComposing || composing || event.keyCode === 229) return true;
    if (!open) return false;
    if (event.key === 'Escape') { event.preventDefault(); setDismissed(tokenKey); return true; }
    if (options.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setSelectedIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
      return true;
    }
    if (!event.shiftKey && options.length && (event.key === 'Tab' || event.key === 'Enter')) {
      event.preventDefault(); accept(); return true;
    }
    // While a path lookup is pending, Enter must not submit a half-completed reference.
    if (loading && ['Enter', 'Tab'].includes(event.key) && !event.shiftKey) { event.preventDefault(); return true; }
    return false;
  }
  function updateCursor(input: HTMLTextAreaElement) {
    if (input.selectionStart !== input.selectionEnd) setFocused(false);
    else { setCursor(input.selectionStart); setFocused(document.activeElement === input); }
  }
  return { listId, open, options, selectedIndex: Math.min(selectedIndex, Math.max(0, options.length - 1)), loading, error, truncated: paths.truncated,
    kind: token?.kind, composing, accept, onKeyDown, updateCursor, setFocused, setComposing,
    activeDescendant: open && options.length ? `${listId}-${Math.min(selectedIndex, options.length - 1)}` : undefined };
}
