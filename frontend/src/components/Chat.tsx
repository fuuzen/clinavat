import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Circle,
  Code2,
  Command,
  CornerDownLeft,
  FileSearch,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  Menu,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
} from "lucide-react";
import Welcome from "./Welcome";
import { ApprovalCard } from "./ToolCards";
import ConversationTurns from "./chat/ConversationTurns";
import ModelPicker from "./chat/ModelPicker";
import type {
  Approval,
  AgentSelection,
  DevHost,
  Message,
  Overview,
  Project,
  Session,
  ToolEvent,
  Turn,
} from "../types";
import { isActive, statusLabel } from "../api";

interface Props {
  overview: Overview;
  project?: Project;
  session?: Session;
  messages: Message[];
  turns: Turn[];
  streaming: string;
  tools: ToolEvent[];
  approvals: Approval[];
  loading: boolean;
  sending: boolean;
  inspectorOpen: boolean;
  streamConnected: boolean;
  onSidebar: () => void;
  onInspector: () => void;
  onNewHost: () => void;
  onNewProject: () => void;
  onSelectProject: (project: Project) => void;
  onSend: (content: string, engine: "claude" | "codex", selection: AgentSelection) => Promise<boolean>;
  onStop: () => void;
  onApproval: (
    id: string,
    decision: "allow" | "deny",
    reason?: string,
  ) => Promise<void>;
}

export default function Chat(props: Props) {
  const { project, session, overview } = props;
  const [draft, setDraft] = useState("");
  const [engine, setEngine] = useState<"claude" | "codex">("claude");
  const [selection, setSelection] = useState<AgentSelection>({
    model: session?.model || null,
    reasoningEffort: session?.reasoning_effort || null,
  });
  const [stickToBottom, setStickToBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const active = props.sending || isActive(session?.status) ||
    props.turns.some((turn) => turn.session_id === session?.id && turn.status === "running");
  const slotAvailable = overview.slot?.status === "ASSIGNED";
  const syncReady = project?.sync_status === "WATCHING";
  const host: DevHost | undefined = overview.hosts.find(
    (item) => item.id === project?.dev_host_id,
  );
  const engines = overview.slot?.cli_types || ["claude", "codex"];
  const currentEngine =
    session?.engine ||
    (engines.includes(engine)
      ? engine
      : engines.includes("claude")
        ? "claude"
        : "codex");
  useEffect(() => {
    setDraft("");
    setStickToBottom(true);
  }, [session?.id, project?.id]);
  useEffect(() => {
    setSelection({
      model: session?.model || null,
      reasoningEffort: session?.reasoning_effort || null,
    });
  }, [session?.id, project?.id, currentEngine]);
  useEffect(() => {
    if (stickToBottom && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [
    props.messages,
    props.turns,
    props.streaming,
    props.tools,
    props.approvals,
    stickToBottom,
  ]);
  async function send() {
    if (
      !draft.trim() ||
      active ||
      !slotAvailable ||
      !syncReady ||
      !props.streamConnected
    )
      return;
    const content = draft;
    setDraft("");
    try {
      const stillSelected = await props.onSend(content, currentEngine, selection);
      if (stillSelected) setStickToBottom(true);
    } catch {
      setDraft((previous) => previous || content);
    }
  }
  function keydown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void send();
    }
  }
  const suggestions = [
    {
      icon: FileSearch,
      title: "熟悉这个项目",
      text: "请阅读项目结构，介绍主要模块、技术栈和开发入口。",
    },
    {
      icon: Code2,
      title: "一起实现新功能",
      text: "请先了解项目现状，再和我讨论要实现的新功能。",
    },
    {
      icon: GitBranch,
      title: "审阅当前改动",
      text: "请审阅当前工作区的代码变更，指出潜在问题和改进建议。",
    },
  ];
  return (
    <main className="chat-panel">
      <header className="workspace-header">
        <button
          className="icon-button mobile-only"
          onClick={props.onSidebar}
          aria-label="打开导航"
        >
          <Menu size={19} />
        </button>
        <div className="breadcrumb">
          <span>
            <FolderOpen size={15} />
            {project?.name || "工作台"}
          </span>
          {session && (
            <>
              <span className="breadcrumb-divider">/</span>
              <strong>{session.title}</strong>
            </>
          )}
        </div>
        <div className="header-actions">
          <span
            className={`connection-status ${props.streamConnected ? "connected" : ""}`}
          >
            <span className="status-dot" />
            {props.streamConnected ? "实时连接" : "正在重连"}
          </span>
          <button
            className={`icon-button ${props.inspectorOpen ? "is-active" : ""}`}
            onClick={props.onInspector}
            aria-label={
              props.inspectorOpen ? "关闭工作区检查器" : "打开工作区检查器"
            }
            title="工作区检查器"
          >
            {props.inspectorOpen ? (
              <PanelRightClose size={18} />
            ) : (
              <PanelRightOpen size={18} />
            )}
          </button>
        </div>
      </header>
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={() => {
          const element = scrollRef.current;
          if (element)
            setStickToBottom(
              element.scrollHeight - element.scrollTop - element.clientHeight <
                100,
            );
        }}
      >
        {!project ? (
          <Welcome
            overview={overview}
            onNewHost={props.onNewHost}
            onNewProject={props.onNewProject}
            onSelectProject={props.onSelectProject}
          />
        ) : (
          <div className="conversation">
            {props.loading ? (
              <div className="loading-state">
                <LoaderCircle className="spin" size={22} />
                <span>正在加载对话…</span>
              </div>
            ) : props.messages.length === 0 && props.turns.length === 0 && !props.streaming ? (
              <div className="project-welcome">
                <div className="agent-glyph">
                  <Sparkles size={28} strokeWidth={1.4} />
                </div>
                <div className="eyebrow">LET’S BUILD SOMETHING</div>
                <h1>今天，想做些什么？</h1>
                <p>
                  你正在 <strong>{project.name}</strong> 中工作。
                  <br />
                  描述目标，剩下的我们一起完成。
                </p>
                <div className="prompt-suggestions">
                  {suggestions.map(({ icon: Icon, title, text }) => (
                    <button
                      key={title}
                      onClick={() => {
                        setDraft(text);
                        inputRef.current?.focus();
                      }}
                    >
                      <Icon size={18} />
                      <span>{title}</span>
                      <ArrowUpRight size={14} />
                    </button>
                  ))}
                </div>
                <div className="project-location">
                  <Terminal size={13} />
                  <span>
                    {host?.name} <span>/</span> {project.remote_path}
                  </span>
                </div>
              </div>
            ) : (
              <ConversationTurns
                messages={props.messages}
                turns={props.turns}
                streaming={props.streaming}
                tools={props.tools}
                username={overview.user.username}
                engine={session?.engine}
              />
            )}
            {props.approvals
              .filter(
                (approval) =>
                  approval.session_id === session?.id &&
                  ["pending", "PENDING"].includes(approval.status),
              )
              .map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  onApproval={props.onApproval}
                />
              ))}
            {active && !props.streaming && !props.turns.some((turn) => turn.status === "running") && (
              <div className="agent-working">
                <span className="thinking-dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span>智能体正在处理任务</span>
              </div>
            )}
          </div>
        )}
      </div>
      {project && (
        <div className="composer-area">
          {!stickToBottom && (
            <button
              className="scroll-bottom"
              onClick={() => setStickToBottom(true)}
            >
              <ArrowDown size={15} />
              最新消息
            </button>
          )}
          {!slotAvailable && (
            <div className="composer-warning">
              <ShieldCheck size={14} />
              {overview.slot
                ? `专属账号当前${statusLabel(overview.slot.status)}，请联系管理员恢复。`
                : "当前账号尚未分配槽位，请联系管理员后开始对话。"}
            </div>
          )}
          {slotAvailable && !syncReady && (
            <div className="composer-warning">
              <ShieldCheck size={14} />
              项目同步尚未就绪。请在工作区点击「立即同步」恢复后发送任务。
            </div>
          )}
          <div className={`composer ${active ? "composer-active" : ""}`}>
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={keydown}
              placeholder={
                slotAvailable
                  ? "描述任务、提出问题，或分享一个想法…"
                  : "等待专属账号就绪…"
              }
              disabled={!slotAvailable}
              rows={3}
              aria-label="对话消息"
            />
            <div className="composer-toolbar">
              <ModelPicker
                engine={currentEngine}
                engines={engines}
                engineLocked={!!session}
                projectId={project.id}
                disabled={active || !slotAvailable}
                value={selection}
                onChange={setSelection}
                onEngineChange={setEngine}
              />
              <span className="permission-note">
                <ShieldCheck size={12} />
                操作前审批
              </span>
              {active ? (
                <button
                  className="send-button stop-button"
                  onClick={props.onStop}
                  title="停止生成"
                  aria-label="停止生成"
                >
                  <Square size={13} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="send-button"
                  disabled={
                    !draft.trim() ||
                    !slotAvailable ||
                    !syncReady ||
                    !props.streamConnected
                  }
                  onClick={() => void send()}
                  title="发送消息"
                  aria-label="发送消息"
                >
                  <ArrowUp size={18} />
                </button>
              )}
            </div>
          </div>
          <div className="composer-footer">
            <span>
              <span
                className={`status-dot ${["WATCHING", "READY"].includes(project.sync_status) ? "online" : ""}`}
              />
              {statusLabel(project.sync_status)}
              <Circle size={3} fill="currentColor" />
              {host?.name || "开发机"}
            </span>
            <span>
              <CornerDownLeft size={11} />
              发送 <span className="keyboard-hint">Shift + Enter 换行</span>
            </span>
          </div>
        </div>
      )}
      {!project && (
        <footer className="workspace-footer">
          <span>
            <ShieldCheck size={12} />
            私有工作空间，原生智能体
          </span>
          <span>
            <Command size={12} /> BUILD WITH INTENTION
          </span>
        </footer>
      )}
    </main>
  );
}
