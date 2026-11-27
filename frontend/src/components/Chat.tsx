import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Command, LoaderCircle, ShieldCheck } from "lucide-react";
import Welcome from "./Welcome";
import MaintenanceBanner from "./MaintenanceBanner";
import ConversationTurns from "./chat/ConversationTurns";
import ModelPicker from "./chat/ModelPicker";
import SlotPicker from "./chat/SlotPicker";
import { useConversationSlot } from "./chat/useConversationSlot";
import WorkspaceHeader from "./chat/WorkspaceHeader";
import ProjectWelcome from "./chat/ProjectWelcome";
import ClientPermissionDialog from "./chat/ClientPermissionDialog";
import { getComposerWarning } from "./chat/composer-warning";
import ChatComposer, { type ComposerHandle } from "./chat/ChatComposer";
import ControlHub from "./chat/composer/ControlHub";
import RuntimeStrip from "./chat/RuntimeStrip";
import { useSessionRuntime } from "./chat/useSessionRuntime";
import { clearComposerDraft } from "./chat/composer/draftStorage";
import { useComposerDraft } from "./chat/composer/useComposerDraft";
import { maxComposerImages, prepareImage, type ComposerImage } from "./chat/composer/imageAttachments";
import ConversationOutline from "./chat/ConversationOutline";
import BtwPanel from "./chat/native/BtwPanel";
import { parseBtwInput } from "./chat/native/btwTypes";
import { useSessionBtw } from "./chat/native/useSessionBtw";
import GoalPanel from "./chat/native/GoalPanel";
import ArchivedNotice from "./chat/ArchivedNotice";
import ForkOrigin from "./chat/ForkOrigin";
import ActionInbox from "./chat/agents/ActionInbox";
import AgentOrigin from "./chat/agents/AgentOrigin";
import AgentPanel from "./chat/agents/AgentPanel";
import { useCodexGoal } from "./chat/native/useCodexGoal";
import { useAgentBehavior, useChatPermissionMode } from "./chat/native/useAgentBehavior";
import { useChatCommands } from "./chat/native/useChatCommands";
import { isClientHost, isProjectWorkspaceReady } from "./hosts/client-device";
import type {
  AccountSelection,
  Approval,
  AgentSelection,
  AgentBehavior,
  InputMode,
  Message,
  Overview,
  PermissionMode,
  Project,
  QuestionPreference,
  Session,
  SyncProgress,
  ToolEvent,
  Turn,
} from "../types";
import { errorText, isActive } from "../api";
import { engineProfiles } from "../engines";

interface Props {
  overview: Overview;
  project?: Project;
  session?: Session;
  syncProgress?: SyncProgress;
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
  onSend: (content: string, images: ComposerImage[], selection: AgentSelection, permissionMode: PermissionMode, account: AccountSelection, behavior: AgentBehavior, mode?: InputMode) => Promise<boolean>;
  onBehaviorChange: (sessionId: string, value: AgentBehavior) => Promise<void>;
  onQuestionsChange: (sessionId: string, value: QuestionPreference) => Promise<void>;
  onNotice: (message: string, kind?: "error" | "success") => void;
  onDiff: () => void;
  onSlotChange: (sessionId: string, selection: AccountSelection) => Promise<void>;
  onPermissionChange: (sessionId: string, mode: PermissionMode) => Promise<void>;
  onStop: () => void;
  onPause: () => Promise<boolean>;
  onResume: () => Promise<boolean>;
  onRestore: (session: Session) => Promise<void>;
  onFork: (turn: Turn) => void;
  onOpenSession: (session: Session | string) => void;
  controlPending: boolean;
  stopPending: boolean;
  onApproval: (id: string, decision: "allow" | "deny", reason?: string) => Promise<void>;
}

export default function Chat(props: Props) {
  const { project, session, overview } = props;
  const maintenance = !!overview.maintenance?.enabled;
  const { draft, setDraft, draftKey, snapshot, storageError } = useComposerDraft(overview.user.id, project?.id, session?.id);
  const draftVersion = useRef({ key: "", draft: "", revision: 0 });
  if (draftVersion.current.key !== (draftKey ?? "") || draftVersion.current.draft !== draft)
    draftVersion.current = { key: draftKey ?? "", draft, revision: draftVersion.current.revision + 1 };
  // Attached images per draft, so that each conversation keeps its own while the page stays open.
  const [attachments, setAttachments] = useState<Record<string, ComposerImage[]>>({});
  const imageKey = draftKey ?? "";
  const images = attachments[imageKey] ?? [];
  const [selection, setSelection] = useState<AgentSelection>({
    model: session?.model || null,
    reasoningEffort: session?.reasoning_effort || null,
  });
  const [stickToBottom, setStickToBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const sessionRuntime = useSessionRuntime(session?.id, props.streamConnected, props.onNotice);
  const btw = useSessionBtw(session?.id, props.streamConnected, props.onNotice);
  const switching = !!sessionRuntime.runtime.switching;
  const settling = !!sessionRuntime.runtime.settling;
  const controlsBlocked = switching || settling;
  const currentTurn = [...props.turns].reverse().find((turn) => turn.session_id === session?.id && isActive(turn.status));
  const runStatus = controlsBlocked ? "running" : isActive(session?.status) ? session!.status : currentTurn?.status;
  const active = controlsBlocked || props.sending || isActive(session?.status) || !!currentTurn;
  const [sendMode, setSendMode] = useState<InputMode>("steer");
  // Locks the input from the moment a message is submitted until the server accepts it.
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const { slot, slotId, accountSelection, catalogSlot, slotAvailable, slotSaving, changeSlot } = useConversationSlot(overview, project?.id, session, props.onSlotChange);
  const host = overview.hosts.find((item) => item.id === project?.dev_host_id);
  const isClientProject = isClientHost(host);
  const syncReady = isProjectWorkspaceReady(project, host);
  const currentEngine = accountSelection.engine;
  const {
    permissionMode, permissionSaving, pendingUnsafePermission, setPendingUnsafePermission,
    applyPermissionChange, requestPermissionChange,
  } = useChatPermissionMode({
    session, projectId: project?.id, engine: currentEngine,
    personalPermission: overview.agentDefaults?.[currentEngine]?.permissionMode,
    isClientProject, active, onPermissionChange: props.onPermissionChange,
  });
  const { behavior, behaviorSaving, changeBehavior } = useAgentBehavior(session, project?.id, currentEngine, active, props.onBehaviorChange);
  const goal = useCodexGoal({ sessionId: session?.id, enabled: engineProfiles[currentEngine].goal && !session?.archived_at, connected: props.streamConnected, executing: active, onNotice: props.onNotice });
  const commands = useChatCommands({
    engine: currentEngine, session, active, switching, settling, busy: behaviorSaving || permissionSaving || slotSaving,
    behavior, selection, permissionMode, onBehavior: changeBehavior,
    onNew: () => { if (project && !maintenance) props.onSelectProject(project); },
    onStop: props.onStop, onDiff: props.onDiff, onNotice: props.onNotice,
    onPause: props.onPause, onResume: props.onResume, onProjectRefresh: props.onProjectRefresh,
    onBtw: (question) => btw.ask(question, {
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      slotId: accountSelection.slotMode === "manual" ? accountSelection.slotId : undefined,
    }),
    runStatus,
    onGoalCommand: async (arguments_) => {
      const handled = await goal.handleCommand(arguments_);
      if (handled) setStickToBottom(true);
      return handled;
    },
  });
  const occupied = !!slot?.in_use && !slot.in_use_by_you;
  const slotKey = catalogSlot ? `${catalogSlot.id}:${catalogSlot.credential_revision}:${catalogSlot.updated_at}` : "unselected";
  // A refreshed catalog reloads the model list but keeps the selection being made.
  const accountKey = `${slotKey}:${catalogSlot?.model_catalog_at ?? ""}`;
  const selectionAccountKey = accountSelection.slotMode === "auto" ? "auto" : slotKey;
  useEffect(() => {
    setStickToBottom(true);
  }, [session?.id, project?.id]);
  useEffect(() => {
    setSelection({
      model: session?.model || null,
      reasoningEffort: session?.reasoning_effort || null,
    });
  }, [session?.id, project?.id, currentEngine, session?.model, session?.reasoning_effort, selectionAccountKey]);
  useLayoutEffect(() => {
    if (stickToBottom && scrollRef.current)
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "instant" });
  }, [
    props.messages, props.turns, props.streaming, props.tools, props.approvals,
    goal.goal, goal.visible, goal.editing, btw.exchanges, stickToBottom,
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
  async function addImages(files: File[]) {
    const key = imageKey;
    const room = maxComposerImages - (attachments[key]?.length ?? 0);
    if (files.length > room) props.onNotice(`每条消息最多附带 ${maxComposerImages} 张图片`);
    const prepared = await Promise.allSettled(files.slice(0, Math.max(0, room)).map(prepareImage));
    const failure = prepared.find((result) => result.status === "rejected");
    if (failure) props.onNotice(errorText(failure.reason));
    const added = prepared.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (added.length) setAttachments((current) => ({ ...current, [key]: [...(current[key] ?? []), ...added].slice(0, maxComposerImages) }));
  }
  function removeImages(key: string, ids: string[]) {
    setAttachments((current) => ({ ...current, [key]: (current[key] ?? []).filter((image) => !ids.includes(image.id)) }));
  }
  async function send() {
    if (maintenance || (!draft.trim() && !images.length) || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await submit();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }
  async function submit() {
    const version = draftVersion.current.revision;
    const command = await commands.handleCommand(draft);
    if (command !== "message") {
      if (command === "handled") clearComposerDraft(draftKey, snapshot);
      return;
    }
    if (version !== draftVersion.current.revision) return;
    // A running reply accepts messages too; the send mode decides how it takes them.
    const running = active && !!session && !props.sending;
    if (
      (!draft.trim() && !images.length) ||
      (active && !running) ||
      permissionSaving ||
      behaviorSaving ||
      slotSaving ||
      controlsBlocked ||
      !slotAvailable ||
      !syncReady ||
      !props.streamConnected
    )
      return;
    const content = draft;
    const sentImages = images;
    const sentKey = imageKey;
    try {
      const stillSelected = await props.onSend(content, sentImages, selection, permissionMode, accountSelection, behavior, running ? sendMode : undefined);
      removeImages(sentKey, sentImages.map((image) => image.id));
      if (stillSelected) setStickToBottom(true);
    } catch {
      // The send handler reports failures and only clears drafts after server acceptance.
    }
  }
  const isBtwDraft = parseBtwInput(draft).isBtw;
  const composerWarning = getComposerWarning({
    maintenance, active, slotAvailable, accountSelection, occupied, slot, slotId, project, host, syncReady,
  });

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
        onNotice={props.onNotice}
      />
      {overview.maintenance?.enabled && <MaintenanceBanner maintenance={overview.maintenance} />}
      <div className="chat-timeline">
        <div
          className="chat-scroll"
          ref={scrollRef}
          onScroll={() => {
            const element = scrollRef.current;
            if (element)
              setStickToBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 100);
          }}
        >
          {!project ? (
            <Welcome
              overview={overview}
              onNewHost={props.onNewHost}
              onNewProject={props.onNewProject}
              onSelectProject={props.onSelectProject}
              onRefresh={props.onProjectRefresh}
              onNotice={props.onNotice}
            />
          ) : (
            <div className="conversation">
              {props.loading ? (
                <div className="loading-state">
                  <LoaderCircle className="spin" size={22} />
                  <span>正在加载对话…</span>
                </div>
              ) : props.messages.length === 0 && props.turns.length === 0 && !props.streaming ? (
                <ProjectWelcome
                  project={project}
                  host={host}
                  syncProgress={props.syncProgress}
                  maintenance={maintenance}
                  onPickPrompt={(text) => {
                    setDraft(text);
                    composerRef.current?.focus();
                  }}
                />
              ) : (
                <>
                  {session && <ForkOrigin session={session} sessions={overview.sessions} onOpen={props.onOpenSession} />}
                  {session && <AgentOrigin session={session} sessions={overview.sessions} onOpen={props.onOpenSession} />}
                  <ConversationTurns
                    messages={props.messages}
                    turns={props.turns}
                    streaming={props.streaming}
                    tools={props.tools}
                    username={overview.user.username}
                    engine={session?.engine}
                    onFork={session && !maintenance ? props.onFork : undefined}
                  />
                </>
              )}
              <GoalPanel control={goal} />
              <BtwPanel control={btw} readOnly={maintenance || !!session?.archived_at} />
              <ActionInbox
                session={session}
                sessions={overview.sessions}
                approvals={props.approvals}
                connected={props.streamConnected}
                onApproval={props.onApproval}
                onOpenSession={props.onOpenSession}
              />
              {active && runStatus !== "paused" && runStatus !== "pausing" && !props.streaming && !currentTurn && (
                <div className="agent-working">
                  <span className="thinking-dots"><i /><i /><i /></span>
                  <span>智能体正在处理任务</span>
                </div>
              )}
            </div>
          )}
        </div>
        {project && !props.loading && (
          <ConversationOutline
            key={`${project.id}:${session?.id || "new"}`}
            messages={props.messages}
            turns={props.turns}
            scrollRef={scrollRef}
            onNavigate={() => setStickToBottom(false)}
          />
        )}
      </div>
      {project && commands.help}
      {project && session?.archived_at && <ArchivedNotice session={session} onRestore={props.onRestore} readOnly={maintenance} />}
      {project && !session?.archived_at && (
        <ChatComposer
          ref={composerRef}
          projectId={project.id}
          commands={commands.commands}
          onToggleMode={() => {
            if (!maintenance && !active && !permissionSaving && !slotSaving && !behaviorSaving)
              void changeBehavior({ ...behavior, agentMode: behavior.agentMode === "plan" ? "normal" : "plan" });
          }}
          draft={draft}
          onDraftChange={setDraft}
          images={images}
          onAddImages={(files) => void addImages(files)}
          onRemoveImage={(id) => removeImages(imageKey, [id])}
          onSend={() => void send()}
          sendMode={sendMode}
          onSendModeChange={setSendMode}
          status={<>
            <RuntimeStrip runtime={sessionRuntime.runtime}
              onCancelQueued={(id) => void sessionRuntime.cancelQueued(id)} onStopTask={(id) => void sessionRuntime.stopTask(id)} />
            <AgentPanel session={session} sessions={overview.sessions} approvals={props.approvals} connected={props.streamConnected}
              onOpen={props.onOpenSession} onNotice={props.onNotice} />
          </>}
          onStop={props.onStop}
          onPause={() => void props.onPause()}
          onResume={() => void props.onResume()}
          runStatus={runStatus}
          controlPending={props.controlPending || controlsBlocked}
          stopPending={props.stopPending}
          connected={props.streamConnected}
          active={active}
          available={slotAvailable}
          readOnly={maintenance}
          locked={submitting || (!isBtwDraft && props.sending)}
          sendDisabled={maintenance || (!draft.trim() && !images.length) || submitting || !props.streamConnected || (!isBtwDraft && (props.sending || permissionSaving || behaviorSaving || slotSaving || controlsBlocked || !slotAvailable || !syncReady))}
          warning={[composerWarning, storageError].filter(Boolean).join(" ") || undefined}
          showScrollToBottom={!stickToBottom}
          onScrollToBottom={() => setStickToBottom(true)}
        >
          <SlotPicker
            slots={overview.slots}
            slotId={slotId}
            selection={accountSelection}
            engine={session?.engine}
            disabled={maintenance || active || permissionSaving || behaviorSaving}
            saving={slotSaving}
            onChange={(value) => void changeSlot(value)}
          />
          <ControlHub
            key={`${project.id}:${session?.id || "new"}`}
            engine={currentEngine}
            session={session}
            permissionMode={permissionMode}
            permissionDisabled={maintenance || active || slotSaving || behaviorSaving || !slotAvailable}
            permissionSaving={permissionSaving}
            permissionOpenRequest={commands.permissionRequest}
            clientHostWarning={isClientProject}
            onPermissionChange={requestPermissionChange}
            behavior={behavior}
            behaviorDisabled={maintenance || active || slotSaving || permissionSaving || !slotAvailable}
            behaviorSaving={behaviorSaving}
            behaviorOpenRequest={commands.behaviorRequest}
            orchestrationLock={session?.parent_session_id
              ? { scope: "all", reason: "子智能体不能再派生子智能体。" }
              : currentEngine === "codex" && session?.native_session_id
                ? behavior.orchestrationMode === "off"
                  ? { scope: "all", reason: "Codex 对话在发送第一条消息后不能开启编排。" }
                  : { scope: "toggle", reason: "Codex 对话在发送第一条消息后不能关闭编排，但可在协作编排与 Super Agent 之间切换。" }
                : undefined}
            roster={{ profiles: overview.agentProfiles ?? [], session }}
            onRollover={!maintenance && session && (session.native_session_id || props.messages.length > 0) ? () => void commands.rollover() : undefined}
            onBehaviorChange={(value) => void changeBehavior(value)}
            questionDefaults={overview.questionDefaults}
            onQuestionsChange={props.onQuestionsChange}
          />
          <ModelPicker
            openRequest={commands.modelRequest}
            engine={currentEngine}
            projectId={project.id}
            accountKey={accountKey}
            slotId={catalogSlot?.id || ""}
            accountAvailable={catalogSlot?.status === "IDLE" && catalogSlot.engine === currentEngine}
            disabled={maintenance || active || slotSaving || permissionSaving || behaviorSaving || !slotAvailable}
            value={selection}
            preference={overview.agentDefaults?.[currentEngine]}
            onChange={setSelection}
          />
        </ChatComposer>
      )}
      {!project && (
        <footer className="workspace-footer">
          <span><ShieldCheck size={12} />私有工作空间，原生智能体</span>
          <span><Command size={12} /> BUILD WITH INTENTION</span>
        </footer>
      )}
      {pendingUnsafePermission && (
        <ClientPermissionDialog
          mode={pendingUnsafePermission}
          onClose={() => setPendingUnsafePermission(null)}
          onConfirm={() => {
            const target = pendingUnsafePermission;
            setPendingUnsafePermission(null);
            void applyPermissionChange(target);
          }}
        />
      )}
    </main>
  );
}
