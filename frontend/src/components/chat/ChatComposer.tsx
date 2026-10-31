import {
  useId,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { AlertCircle, ArrowDown, ArrowUp, LoaderCircle, MessageSquare, Minus, Pause, Play, ShieldCheck, Square } from "lucide-react";
import CompletionMenu from "./composer/CompletionMenu";
import { useComposerCompletion } from "./composer/useComposerCompletion";
import type { ComposerCommand } from "./composer/commands";
import "../../styles/completions.css";

const noCommands: ComposerCommand[] = [];

export interface ComposerHandle {
  focus: () => void;
}

interface Props {
  ref?: Ref<ComposerHandle>;
  projectId?: string;
  commands?: ComposerCommand[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  runStatus?: string;
  controlPending: boolean;
  stopPending: boolean;
  connected: boolean;
  onToggleMode?: () => void;
  active: boolean;
  available: boolean;
  sendDisabled: boolean;
  warning?: string;
  showScrollToBottom: boolean;
  onScrollToBottom: () => void;
  children: ReactNode;
}

function resizeInput(input: HTMLTextAreaElement) {
  if (!input.clientWidth) return;
  input.style.height = "0px";
  input.style.height = `${input.scrollHeight}px`;
}

export default function ChatComposer(props: Props) {
  const contentId = useId();
  const [minimized, setMinimized] = useState(false);
  const [collapsing, setCollapsing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const minimizeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLButtonElement>(null);
  const focusAfterExpand = useRef<"input" | "minimize" | null>(null);
  const hasDraft = !!props.draft.trim();
  const resumable = props.runStatus === "paused" || props.runStatus === "pausing";
  const pauseLabel = resumable ? "继续任务" : "暂停任务";
  const controlDisabled = props.controlPending || props.stopPending || !props.connected || !props.runStatus;
  const completion = useComposerCompletion({
    inputRef, draft: props.draft, onDraftChange: props.onDraftChange, projectId: props.projectId,
    commands: props.commands ?? noCommands, enabled: !minimized && props.available,
  });

  function focusInput() {
    const input = inputRef.current;
    if (input && !input.disabled) input.focus({ preventScroll: true });
    else minimizeRef.current?.focus({ preventScroll: true });
  }

  function expand(focusDraft = true) {
    if (!minimized) {
      if (focusDraft) focusInput();
      return;
    }
    setCollapsing(false);
    focusAfterExpand.current = focusDraft ? "input" : "minimize";
    setMinimized(false);
  }

  useImperativeHandle(props.ref, () => ({ focus: () => expand() }));

  useEffect(() => {
    if (!collapsing) return;
    const timeout = window.setTimeout(() => setCollapsing(false), 240);
    return () => window.clearTimeout(timeout);
  }, [collapsing]);

  useLayoutEffect(() => {
    if (minimized) restoreRef.current?.focus({ preventScroll: true });
    else if (focusAfterExpand.current) {
      if (focusAfterExpand.current === "input") focusInput();
      else minimizeRef.current?.focus({ preventScroll: true });
      focusAfterExpand.current = null;
    }
  }, [minimized]);

  useLayoutEffect(() => {
    if (!minimized && inputRef.current) resizeInput(inputRef.current);
  }, [props.draft, minimized]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    let width = input.clientWidth;
    const resize = () => resizeInput(input);
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      resize();
    });
    observer.observe(input);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
  }, []);

  function keydown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || completion.composing || event.keyCode === 229) return;
    if (event.key === "Tab" && event.shiftKey && props.onToggleMode) {
      event.preventDefault();
      props.onToggleMode();
      return;
    }
    if (completion.onKeyDown(event)) return;
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      props.onSend();
    }
  }

  const stopButton = (
    <button className="send-button stop-button" type="button" disabled={props.stopPending} onClick={props.onStop} title="停止任务" aria-label="停止任务">
      <span className="send-button-symbol"><Square size={13} fill="currentColor" aria-hidden="true" /></span>
    </button>
  );
  const pauseButton = (
    <button className="send-button pause-button" type="button" disabled={controlDisabled}
      onClick={resumable ? props.onResume : props.onPause} title={pauseLabel} aria-label={pauseLabel}>
      <span className="send-button-symbol">{resumable ? <Play size={15} fill="currentColor" aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}</span>
    </button>
  );
  const latestButton = (
    <button className="scroll-bottom" type="button" onClick={props.onScrollToBottom} aria-label="最新消息" title="最新消息">
      <ArrowDown size={15} aria-hidden="true" />
    </button>
  );

  return (
    <div className={`composer-area${minimized ? " composer-area-minimized" : ""}`}>
      <div
        className="composer-pane"
        hidden={minimized && !collapsing}
        inert={minimized}
        aria-hidden={minimized}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && minimized) setCollapsing(false);
        }}
      >
        {props.showScrollToBottom && !minimized && latestButton}
        {props.warning && <div className="composer-warning"><ShieldCheck size={14} aria-hidden="true" />{props.warning}</div>}
        <div className={`composer${props.active ? " composer-active" : ""}`}>
          <div id={contentId} className="composer-body">
            {completion.open && <CompletionMenu
              id={completion.listId}
              kind={completion.kind}
              options={completion.options}
              selectedIndex={completion.selectedIndex}
              loading={completion.loading}
              error={completion.error}
              truncated={completion.truncated}
              onSelect={completion.accept}
            />}
            <button
              ref={minimizeRef}
              className="composer-minimize"
              type="button"
              title="最小化输入框"
              aria-label="最小化输入框"
              aria-expanded="true"
              aria-controls={contentId}
              onClick={() => {
                setCollapsing(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
                setMinimized(true);
              }}
            >
              <Minus size={15} aria-hidden="true" />
            </button>
            <textarea
              ref={inputRef}
              value={props.draft}
              onChange={(event) => { props.onDraftChange(event.target.value); completion.updateCursor(event.target); }}
              onSelect={(event) => completion.updateCursor(event.currentTarget)}
              onFocus={(event) => completion.updateCursor(event.currentTarget)}
              onBlur={() => completion.setFocused(false)}
              onCompositionStart={() => completion.setComposing(true)}
              onCompositionEnd={(event) => { completion.setComposing(false); completion.updateCursor(event.currentTarget); }}
              onKeyDown={keydown}
              placeholder={props.available ? "描述任务… 输入 / 查看指令，@ 引用文件" : "等待可用账号…"}
              disabled={!props.available}
              rows={1}
              aria-label="对话消息"
              aria-description="Enter 发送，Shift + Enter 换行；/ 查看指令，@ 引用文件，Tab 补全"
              aria-autocomplete="list"
              aria-controls={completion.open ? completion.listId : undefined}
              aria-haspopup="listbox"
              aria-activedescendant={completion.activeDescendant}
            />
            <div className="composer-toolbar">
              {props.children}
              {props.active ? <>{pauseButton}{stopButton}</> : (
                <button className="send-button" type="button" disabled={props.sendDisabled} onClick={props.onSend} title="发送消息" aria-label="发送消息">
                  <span className="send-button-symbol"><ArrowUp size={18} aria-hidden="true" /></span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {minimized && <div className="composer-floating-controls">
        {props.showScrollToBottom && latestButton}
        <div className="composer-dock">
          <button
            ref={restoreRef}
            className="composer-restore"
            data-has-draft={hasDraft || undefined}
            type="button"
            // Touch keyboards open after the layout settles and can cover the expanded composer.
            onClick={() => expand(!window.matchMedia("(pointer: coarse)").matches)}
            aria-label={`${hasDraft ? "展开输入框，继续编辑草稿" : "展开输入框"}${props.warning ? `。${props.warning}` : ""}`}
            aria-expanded="false"
            aria-controls={contentId}
            title={props.warning || (hasDraft ? "草稿已保留，点击继续编辑" : "展开输入框")}
          >
            {resumable ? <Pause size={20} aria-hidden="true" /> : props.active ? <LoaderCircle className="spin" size={20} aria-hidden="true" /> : <MessageSquare size={20} aria-hidden="true" />}
            {props.warning && <AlertCircle size={13} className="composer-dock-warning" aria-hidden="true" />}
          </button>
          {props.active && <>{pauseButton}{stopButton}</>}
        </div>
      </div>}
    </div>
  );
}
