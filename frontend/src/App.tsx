import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, LoaderCircle } from "lucide-react";
import { api, ApiError, errorText, post } from "./api";
import { loadSiteSettings, useSiteSettings } from "./site/store";
import type {
  AgentSelection,
  AgentBehavior,
  Approval,
  DevHost,
  Overview,
  PermissionMode,
  Project,
  Session,
  ToolEvent,
} from "./types";
import { useWorkspaceEvents } from "./useWorkspaceEvents";
import { useWorkspaceSelection } from "./useWorkspaceSelection";
import { useConversationHistory } from "./useConversationHistory";
import { useSessionBehavior, useSessionPermissions, useSessionSlot } from "./useSessionPermissions";
import { useSessionRunControl } from "./useSessionRunControl";
import { usePendingSends } from "./components/chat/usePendingSends";
import { clearComposerDraft, getComposerDraftKey, moveComposerDraft, readComposerDraft } from "./components/chat/composer/draftStorage";
import { HostDialog, ProjectDialog } from "./components/ResourceDialogs";
import { hostConnectionMessage, type HostConnection } from "./components/hosts/host-connection";
import Auth from "./components/Auth";
import Brand from "./components/Brand";
import Sidebar from "./components/Sidebar";
import Chat from "./components/Chat";
import Inspector from "./components/Inspector";
import Settings from "./components/Settings";
import AppNotices, { type Notice } from "./components/AppNotices";
import { ConfirmDialog, RenameDialog } from "./components/Dialogs";

const AdminPanel = lazy(() => import("./components/admin/AdminPanel"));

type Dialog =
  | { type: "host"; host?: DevHost }
  | { type: "project"; host?: DevHost }
  | {
      type: "delete";
      kind: "host" | "project" | "session";
      id: string;
      name: string;
    }
  | { type: "rename"; session: Session }
  | { type: "settings" }
  | null;

export default function App() {
  const siteSettings = useSiteSettings();
  const [auth, setAuth] = useState<{
    needsSetup: boolean;
    registrationEnabled: boolean;
  } | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [initialError, setInitialError] = useState("");
  const { projectId, setProjectId, sessionId, setSessionId } = useWorkspaceSelection();
  const [streaming, setStreaming] = useState("");
  const [tools, setTools] = useState<ToolEvent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const { sending, beginSend, clearPendingSends } = usePendingSends(projectId, sessionId);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminVisited, setAdminVisited] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(
    () => window.innerWidth >= 1280,
  );
  const [streamConnected, setStreamConnected] = useState(false);
  const [inspectorRefresh, setInspectorRefresh] = useState(0);
  const [inspectorRequest, setInspectorRequest] = useState<{ tab: "changes"; id: number }>();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const selectedSessionRef = useRef(sessionId);
  selectedSessionRef.current = sessionId;
  const selectedProjectRef = useRef(projectId);
  selectedProjectRef.current = projectId;
  const sendRequestRef = useRef(0);
  const { messages, turns, reloadMessages, receiveTurn, resetHistory } =
    useConversationHistory(selectedSessionRef);
  const project = overview?.projects.find((item) => item.id === projectId);
  const session = overview?.sessions.find(
    (item) => item.id === sessionId && item.project_id === projectId,
  );
  const notify = useCallback(
    (content: string, kind: Notice["kind"] = "error") => {
      const id = Date.now() + Math.random();
      setNotices((current) => [...current.slice(-3), { id, content, kind }]);
      window.setTimeout(
        () => setNotices((current) => current.filter((item) => item.id !== id)),
        7000,
      );
    },
    [],
  );
  const refresh = useCallback(async () => {
    setOverview(await api<Overview>("/overview"));
  }, []);
  const changePermission = useSessionPermissions(setOverview, notify);
  const changeSlot = useSessionSlot(setOverview, notify);
  const changeBehavior = useSessionBehavior(setOverview, notify);
  const runControl = useSessionRunControl(session, selectedSessionRef, setOverview, refresh, reloadMessages, notify);
  const refreshApprovals = useCallback(async () => {
    try {
      setApprovals(await api<Approval[]>("/approvals"));
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 401))
        notify(errorText(cause));
    }
  }, [notify]);
  async function initialize() {
    setInitializing(true);
    setInitialError("");
    try {
      // Branding availability must not prevent authentication or workspace access.
      void loadSiteSettings().catch(() => undefined);
      const status = await api<{
        needsSetup: boolean;
        registrationEnabled: boolean;
      }>("/auth/status");
      setAuth(status);
      if (!status.needsSetup) {
        try {
          await refresh();
        } catch (cause) {
          if (!(cause instanceof ApiError && cause.status === 401)) throw cause;
        }
      }
    } catch (cause) {
      setInitialError(errorText(cause));
    } finally {
      setInitializing(false);
    }
  }
  useEffect(() => {
    void initialize();
  }, []);
  useEffect(() => {
    const reload = () => { if (document.visibilityState === "visible") void loadSiteSettings().catch(() => undefined); };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", reload);
    return () => {
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", reload);
    };
  }, []);
  useEffect(() => {
    resetHistory();
    setStreaming("");
    setTools([]);
    setLoadingMessages(false);
    if (!sessionId || !overview) return;
    let disposed = false;
    setLoadingMessages(true);
    void reloadMessages(sessionId)
      .catch((cause) => {
        if (!disposed) notify(errorText(cause));
      })
      .finally(() => {
        if (!disposed) setLoadingMessages(false);
      });
    return () => {
      disposed = true;
    };
  }, [sessionId, !!overview, reloadMessages, resetHistory, notify]);
  useWorkspaceEvents({
    userId: overview?.user.id,
    selectedSessionRef,
    refresh,
    refreshApprovals,
    reloadMessages,
    receiveTurn,
    notify,
    setStreamConnected,
    setStreaming,
    setTools,
    setInspectorRefresh,
  });
  function changeSelection(nextProjectId: string, nextSessionId = "") {
    sendRequestRef.current += 1;
    selectedProjectRef.current = nextProjectId;
    selectedSessionRef.current = nextSessionId;
    setProjectId(nextProjectId);
    setSessionId(nextSessionId);
  }
  function select(nextProject: Project, nextSession?: Session) {
    setAdminOpen(false);
    changeSelection(nextProject.id, nextSession?.id);
  }
  async function send(
    content: string,
    engine: "claude" | "codex",
    selection: AgentSelection,
    permissionMode: PermissionMode,
    slotId: string,
    behavior: AgentBehavior,
  ) {
    if (!project || !overview) return false;
    const pending = beginSend(project.id, selectedSessionRef.current);
    if (!pending) return false;
    const request = ++sendRequestRef.current;
    const originProjectId = project.id;
    const originSessionId = selectedSessionRef.current;
    const originDraftKey = getComposerDraftKey(overview.user.id, originProjectId, originSessionId);
    const submittedDraft = readComposerDraft(originDraftKey);
    setStreaming("");
    setTools([]);
    try {
      let target = session;
      if (!target) {
        target = await post<Session>("/sessions", {
          projectId: project.id,
          engine, slotId,
          ...selection,
          permissionMode,
          ...behavior,
          title: content.slice(0, 40),
        });
        moveComposerDraft(
          originDraftKey,
          getComposerDraftKey(overview.user.id, originProjectId, target.id),
          request === sendRequestRef.current ? undefined : submittedDraft,
        );
        pending.useSession(target.id);
        setOverview((previous) =>
          previous
            ? { ...previous, sessions: [target!, ...previous.sessions] }
            : previous,
        );
        if (
          request === sendRequestRef.current &&
          selectedProjectRef.current === originProjectId &&
          selectedSessionRef.current === originSessionId
        ) {
          selectedSessionRef.current = target.id;
          setSessionId(target.id);
        }
      }
      await post(`/sessions/${target.id}/messages`, { content, ...selection, permissionMode, slotId, ...behavior });
      clearComposerDraft(originDraftKey, submittedDraft);
      clearComposerDraft(getComposerDraftKey(overview.user.id, originProjectId, target.id), submittedDraft);
      await Promise.all([refresh(), reloadMessages(target.id)]);
      return request === sendRequestRef.current;
    } catch (cause) {
      notify(errorText(cause));
      if (request !== sendRequestRef.current) return false;
      throw cause;
    } finally {
      pending.finish();
    }
  }
  async function decide(
    id: string,
    decision: "allow" | "deny",
    reason?: string,
  ) {
    try {
      await post(`/approvals/${id}`, { decision, reason });
      await refreshApprovals();
    } catch (cause) {
      notify(errorText(cause));
    }
  }
  async function connect(host: DevHost) {
    notify(`正在连接 ${host.name}…`, "success");
    try {
      const result = await post<HostConnection>(
        `/hosts/${host.id}/connect`,
      );
      await refresh();
      notify(hostConnectionMessage(host.name, result), "success");
    } catch (cause) {
      notify(errorText(cause));
      await refresh().catch(() => {});
    }
  }
  async function remove() {
    if (dialog?.type !== "delete") return;
    const endpoint =
      dialog.kind === "host"
        ? "hosts"
        : dialog.kind === "project"
          ? "projects"
          : "sessions";
    await api(`/${endpoint}/${dialog.id}`, { method: "DELETE" });
    if (dialog.id === projectId) {
      changeSelection("");
    }
    else if (dialog.id === sessionId) changeSelection(projectId);
    await refresh();
    notify("已删除", "success");
  }
  async function logout() {
    try {
      await post("/auth/logout");
      setOverview(null);
      setAdminOpen(false);
      setAdminVisited(false);
      clearPendingSends();
      resetHistory();
      setStreaming("");
      setTools([]);
      changeSelection("");
      setDialog(null);
    } catch (cause) {
      notify(errorText(cause));
    }
  }
  const closeDialog = useCallback(() => setDialog(null), []);
  useEffect(() => {
    const signedOut = () => {
      setOverview(null);
      setAdminOpen(false);
      setAdminVisited(false);
      setDialog(null);
      resetHistory();
      setStreaming("");
      setTools([]);
      sendRequestRef.current += 1;
      clearPendingSends();
    };
    window.addEventListener("clinavat:unauthorized", signedOut);
    return () => window.removeEventListener("clinavat:unauthorized", signedOut);
  }, [resetHistory, clearPendingSends]);
  const createProject = (host?: DevHost) => {
    if (!overview?.hosts.length) setDialog({ type: "host" });
    else setDialog({ type: "project", host });
  };
  if (initializing)
    return (
      <div className="app-loading">
        <Brand />
        <LoaderCircle size={23} className="spin" />
        <span>正在准备你的工作台…</span>
      </div>
    );
  if (initialError)
    return (
      <div className="app-loading">
        <Brand />
        <AlertCircle size={27} />
        <p>{initialError}</p>
        <button
          className="button button-primary"
          onClick={() => void initialize()}
        >
          重新连接服务
        </button>
      </div>
    );
  if (!overview)
    return (
      <Auth
        settings={siteSettings}
        needsSetup={auth?.needsSetup || false}
        registrationEnabled={auth?.registrationEnabled || false}
        onAuthenticated={async () => {
          await refresh();
          setAuth((current) =>
            current ? { ...current, needsSetup: false } : current,
          );
        }}
      />
    );
  const showAdmin = adminOpen && overview.user.role === "admin";
  return (
    <div className={`app-shell ${inspectorOpen && !showAdmin ? "with-inspector" : ""}`}>
      <Sidebar
        overview={overview}
        selectedProject={project}
        selectedSession={session}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onSelect={select}
        onNewHost={() => setDialog({ type: "host" })}
        onEditHost={(host) => setDialog({ type: "host", host })}
        onNewProject={createProject}
        onConnect={(host) => void connect(host)}
        onDelete={(kind, id, name) =>
          setDialog({ type: "delete", kind, id, name })
        }
        onRename={(selected) =>
          setDialog({ type: "rename", session: selected })
        }
        onSettings={() => setDialog({ type: "settings" })}
        adminOpen={showAdmin}
        onAdmin={() => {
          if (overview.user.role !== "admin") return;
          setAdminVisited(true);
          setAdminOpen((current) => !current);
          setSidebarOpen(false);
        }}
        onLogout={() => void logout()}
      />
      <div className="workbench-view" hidden={showAdmin}>
        <Chat
          overview={overview}
          project={project}
          session={session}
          messages={messages}
          turns={turns}
          streaming={streaming}
          tools={tools}
          approvals={approvals}
          loading={loadingMessages}
          sending={sending}
          inspectorOpen={inspectorOpen}
          streamConnected={streamConnected}
          onSidebar={() => setSidebarOpen(true)}
          onInspector={() => setInspectorOpen(!inspectorOpen)}
          onNewHost={() => setDialog({ type: "host" })}
          onNewProject={() => createProject()}
          onSelectProject={(selected) => select(selected)}
          onProjectRefresh={refresh}
          onSend={send}
          onPermissionChange={changePermission}
          onBehaviorChange={changeBehavior}
          onNotice={notify}
          onDiff={() => { setInspectorRequest({ tab: "changes", id: Date.now() }); setInspectorOpen(true); }}
          onSlotChange={changeSlot}
          onPause={runControl.pause}
          onResume={runControl.resume}
          controlPending={runControl.controlPending}
          stopPending={runControl.stopPending}
          onStop={() => void runControl.stop()}
          onApproval={decide}
        />
        {inspectorOpen && (
          <Inspector
            project={project}
            refresh={inspectorRefresh}
            tabRequest={inspectorRequest}
            onClose={() => setInspectorOpen(false)}
            onRefresh={() =>
              void refresh().catch((cause) => notify(errorText(cause)))
            }
          />
        )}
      </div>
      {adminVisited && overview.user.role === "admin" && (
        <div className="admin-view" hidden={!showAdmin}>
          <Suspense fallback={<div className="loading-state">正在打开管理面板…</div>}>
          <AdminPanel
            overview={overview}
            onRefresh={refresh}
            onSidebar={() => setSidebarOpen(true)}
            onOpenProject={select}
            onNewProject={() => createProject()}
            onNewHost={() => setDialog({ type: "host" })}
            onEditHost={(host) => setDialog({ type: "host", host })}
            onConnect={connect}
          />
          </Suspense>
        </div>
      )}
      {dialog?.type === "host" && (
        <HostDialog
          key={dialog.host?.id || "new-host"}
          overview={overview}
          initialHost={dialog.host}
          onClose={closeDialog}
          onCreated={async () => {
            await refresh();
            if (dialog.host) notify("连接配置已更新，测试连接后在项目中恢复同步", "success");
          }}
        />
      )}
      {dialog?.type === "project" && (
        <ProjectDialog
          overview={overview}
          initialHost={dialog.host}
          onClose={closeDialog}
          onCreated={refresh}
        />
      )}
      {dialog?.type === "delete" && (
        <ConfirmDialog
          name={dialog.name}
          kind={
            dialog.kind === "host"
              ? "开发机"
              : dialog.kind === "project"
                ? "项目"
                : "对话"
          }
          onClose={closeDialog}
          onConfirm={remove}
        />
      )}
      {dialog?.type === "rename" && (
        <RenameDialog
          session={dialog.session}
          onClose={closeDialog}
          onSaved={refresh}
        />
      )}
      {dialog?.type === "settings" && <Settings overview={overview} onClose={closeDialog} />}
      <AppNotices notices={notices} onDismiss={(id) => setNotices((current) => current.filter((notice) => notice.id !== id))} />
    </div>
  );
}
