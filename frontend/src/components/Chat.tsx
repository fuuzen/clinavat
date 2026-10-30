import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Code2,
  Command,
  FileSearch,
  GitBranch,
  LoaderCircle,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import Welcome from "./Welcome";
import { ApprovalCard } from "./ToolCards";
import ConversationTurns from "./chat/ConversationTurns";
import ModelPicker from "./chat/ModelPicker";
import SlotPicker from "./chat/SlotPicker";
import { useConversationSlot } from "./chat/useConversationSlot";
import PermissionPicker from "./chat/PermissionPicker";
import WorkspaceHeader from "./chat/WorkspaceHeader";
import ChatComposer, { type ComposerHandle } from "./chat/ChatComposer";
import { clearComposerDraft } from "./chat/composer/draftStorage";
import { useComposerDraft } from "./chat/composer/useComposerDraft";
import ConversationOutline from "./chat/ConversationOutline";
import BehaviorPicker from "./chat/native/BehaviorPicker";
import QuestionPanel from "./chat/native/QuestionPanel";
import GoalPanel from "./chat/native/GoalPanel";
import { useCodexGoal } from "./chat/native/useCodexGoal";
import { useAgentBehavior } from "./chat/native/useAgentBehavior";
import { useChatCommands } from "./chat/native/useChatCommands";
import type {
  Approval,
  AgentSelection,
  AgentBehavior,
  Message,
  Overview,
  PermissionMode,
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
  onProjectRefresh: () => Promise<void>;
  onSend: (content: string, engine: "claude" | "codex", selection: AgentSelection, permissionMode: PermissionMode, slotId: string, behavior: AgentBehavior) => Promise<boolean>;
  onBehaviorChange: (sessionId: string, value: AgentBehavior) => Promise<void>;
  onNotice: (message: string, kind?: "error" | "success") => void;
  onDiff: () => void;
  onSlotChange: (sessionId: string, slotId: string) => Promise<void>;
  onPermissionChange: (sessionId: string, mode: PermissionMode) => Promise<void>;
  onStop: () => void;
  onPause: () => Promise<boolean>;
  onResume: () => Promise<boolean>;
  controlPending: boolean;
  stopPending: boolean;
  onApproval: (
    id: string,
    decision: "allow" | "deny",
    reason?: string,
  ) => Promise<void>;
}

export default function Chat(props: Props) {
  const { project, session, overview } = props;
  const { draft, setDraft, draftKey, snapshot, storageError } = useComposerDraft(overview.user.id, project?.id, session?.id);
  const draftVersion = useRef({ key: "", draft: "", revision: 0 });
  if (draftVersion.current.key !== (draftKey ?? "") || draftVersion.current.draft !== draft)
    draftVersion.current = { key: draftKey ?? "", draft, revision: draftVersion.current.revision + 1 };
  const [selection, setSelection] = useState<AgentSelection>({
    model: session?.model || null,
    reasoningEffort: session?.reasoning_effort || null,
  });
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(session?.permission_mode || "manual");
  const [permissionSaving, setPermissionSaving] = useState(false);
  const permissionRequestRef = useRef(0);
  const [stickToBottom, setStickToBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const currentTurn = [...props.turns].reverse().find((turn) => turn.session_id === session?.id && isActive(turn.status));
  const runStatus = isActive(session?.status) ? session!.status : currentTurn?.status;
  const active = props.sending || isActive(session?.status) ||
    !!currentTurn;
  const { slot, slotId, slotSaving, changeSlot } = useConversationSlot(overview, project?.id, session, props.onSlotChange);
  const syncReady = project?.sync_status === "WATCHING" || project?.sync_status === "LOCAL";
  const host = overview.hosts.find(
    (item) => item.id === project?.dev_host_id,
  );
  const currentEngine = session?.engine || slot?.engine || "claude";
  const { behavior, behaviorSaving, changeBehavior } = useAgentBehavior(session, project?.id, currentEngine, active, props.onBehaviorChange);
  const goal = useCodexGoal({ sessionId: session?.id, enabled: currentEngine === "codex", connected: props.streamConnected, executing: active, onNotice: props.onNotice });
  const commands = useChatCommands({
    engine: currentEngine, session, active, busy: behaviorSaving || permissionSaving || slotSaving,
    behavior, selection, permissionMode, onBehavior: changeBehavior,
    onNew: () => { if (project) props.onSelectProject(project); },
    onStop: props.onStop, onDiff: props.onDiff, onNotice: props.onNotice,
    onPause: props.onPause, onResume: props.onResume, runStatus,
    onGoalCommand: async arguments_ => {
      const handled = await goal.handleCommand(arguments_);
      if (handled) setStickToBottom(true);
      return handled;
    },
  });
  const occupied = !!slot?.in_use && !slot.in_use_by_you;
  const slotAvailable = slot?.status === "IDLE" && slot.engine === currentEngine && !occupied;
  const accountKey = slot ? `${slot.id}:${slot.credential_revision}:${slot.updated_at}` : "unselected";
  useEffect(() => {
    setStickToBottom(true);
  }, [session?.id, project?.id]);
  useEffect(() => {
    setSelection({
      model: session?.model || null,
      reasoningEffort: session?.reasoning_effort || null,
    });
  }, [session?.id, project?.id, currentEngine, session?.model, session?.reasoning_effort, accountKey]);
  useEffect(() => {
    permissionRequestRef.current += 1;
    setPermissionMode(session?.permission_mode || "manual");
    setPermissionSaving(false);
  }, [session?.id, project?.id, session?.permission_mode]);
  useEffect(() => {
    if (currentEngine === "codex") setPermissionMode((mode) => mode === "accept-edits" ? "manual" : mode);
  }, [currentEngine]);
  useLayoutEffect(() => {
    if (stickToBottom && scrollRef.current)
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "instant" });
  }, [
    props.messages,
    props.turns,
    props.streaming,
    props.tools,
    props.approvals,
    goal.goal,
    goal.visible,
    goal.editing,
    stickToBottom,
  ]);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom) scroll.scrollTo({ top: scroll.scrollHeight, behavior: "instant" });
    });
    observer.observe(scroll);
    const conversation = scroll.querySelector(".conversation");
    if (conversation) observer.observe(conversation);
    return () => observer.disconnect();
  }, [stickToBottom, session?.id, project?.id, props.loading]);
  async function send() {
    if (!draft.trim()) return;
    const version = draftVersion.current.revision;
    const command = await commands.handleCommand(draft);
    if (command !== "message") {
      if (command === "handled") clearComposerDraft(draftKey, snapshot);
      return;
    }
    if (version !== draftVersion.current.revision) return;
    if (
      !draft.trim() ||
      active ||
      permissionSaving ||
      behaviorSaving ||
      slotSaving ||
      !slotAvailable ||
      !syncReady ||
      !props.streamConnected
    )
      return;
    const content = draft;
    try {
      const stillSelected = await props.onSend(content, currentEngine, selection, permissionMode, slotId, behavior);
      if (stillSelected) setStickToBottom(true);
    } catch {
      // The send handler reports failures and only clears drafts after server acceptance.
    }
  }
  async function changePermission(mode: PermissionMode) {
    if (active || permissionSaving) return;
    const previous = permissionMode;
    const request = ++permissionRequestRef.current;
    setPermissionMode(mode);
    if (!session) return;
    setPermissionSaving(true);
    try {
      await props.onPermissionChange(session.id, mode);
    } catch {
      if (request === permissionRequestRef.current) setPermissionMode(previous);
    } finally {
      if (request === permissionRequestRef.current) setPermissionSaving(false);
    }
  }
  const composerWarning = !slotAvailable
    ? occupied
      ? "此槽位正由其他用户使用，释放后可继续；也可选择其他已获授权的账号。"
      : slot
        ? `此槽位${statusLabel(slot.status)}，请选择其他可用账号或联系管理员。`
        : slotId
          ? "此对话原选槽位已不可访问，请选择同引擎的其他授权槽位。"
          : "请选择已获授权的账号槽位；没有可用账号时请联系管理员。"
    : !syncReady
      ? project?.execution_mode === "local"
        ? "本机项目目录不可用。恢复目录及其访问权限后，请在工作区点击「检查目录」。"
        : "项目同步尚未就绪。请在工作区点击「立即同步」恢复后发送任务。"
      : undefined;
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
      <WorkspaceHeader
        overview={overview}
        project={project}
        session={session}
        active={active}
        inspectorOpen={props.inspectorOpen}
        streamConnected={props.streamConnected}
        onSidebar={props.onSidebar}
        onInspector={props.onInspector}
        onProjectRefresh={props.onProjectRefresh}
      />
      <div className="chat-timeline">
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
                        composerRef.current?.focus();
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
            <GoalPanel control={goal} />
            <QuestionPanel sessionId={session?.id} connected={props.streamConnected} />
            {active && runStatus !== "paused" && runStatus !== "pausing" && !props.streaming && !currentTurn && (
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
      {project && !props.loading && <ConversationOutline key={`${project.id}:${session?.id || "new"}`} messages={props.messages} turns={props.turns} scrollRef={scrollRef} onNavigate={() => setStickToBottom(false)} />}
      </div>
      {project && commands.help}
      {project && (
        <ChatComposer
          ref={composerRef}
          projectId={project.id}
          commands={commands.commands}
          onToggleMode={() => {
            if (!active && !permissionSaving && !slotSaving && !behaviorSaving)
              void changeBehavior({ ...behavior, agentMode: behavior.agentMode === "plan" ? "normal" : "plan" });
          }}
          draft={draft}
          onDraftChange={setDraft}
          onSend={() => void send()}
          onStop={props.onStop}
          onPause={() => void props.onPause()}
          onResume={() => void props.onResume()}
          runStatus={runStatus}
          controlPending={props.controlPending}
          stopPending={props.stopPending}
          connected={props.streamConnected}
          active={active}
          available={slotAvailable}
          sendDisabled={!draft.trim() || permissionSaving || behaviorSaving || slotSaving || !slotAvailable || !syncReady || !props.streamConnected}
          warning={[composerWarning, storageError].filter(Boolean).join(" ") || undefined}
          showScrollToBottom={!stickToBottom}
          onScrollToBottom={() => setStickToBottom(true)}
        >
          <SlotPicker
            slots={overview.slots}
            slotId={slotId}
            engine={session?.engine}
            disabled={active || permissionSaving || behaviorSaving}
            saving={slotSaving}
            onChange={(id) => void changeSlot(id)}
          />
          <PermissionPicker
            openRequest={commands.permissionRequest}
            key={`${project.id}:${session?.id || "new"}`}
            engine={currentEngine}
            value={permissionMode}
            disabled={active || slotSaving || behaviorSaving || !slotAvailable}
            saving={permissionSaving}
            onChange={(mode) => void changePermission(mode)}
          />
          <BehaviorPicker engine={currentEngine} value={behavior} disabled={active || slotSaving || permissionSaving || !slotAvailable} saving={behaviorSaving} onChange={(value) => void changeBehavior(value)} openRequest={commands.behaviorRequest} />
          <ModelPicker
            openRequest={commands.modelRequest}
            engine={currentEngine}
            projectId={project.id}
            accountKey={accountKey}
            slotId={slotId}
            sessionId={session?.id}
            accountAvailable={slot?.status === "IDLE" && slot.engine === currentEngine}
            disabled={active || slotSaving || permissionSaving || behaviorSaving || !slotAvailable}
            value={selection}
            onChange={setSelection}
          />
        </ChatComposer>
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
