import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, LoaderCircle } from "lucide-react";
import { api, ApiError, errorText, post } from "./api";
import { loadSiteSettings, useSiteSettings } from "./site/store";
import type { Approval, DevHost, MaintenanceState, Overview, Project, Session, ToolEvent, Turn } from "./types";
import { useWorkspaceEvents } from "./useWorkspaceEvents";
import { useConversationHistory } from "./useConversationHistory";
import { useSelectedSession } from "./hooks/useSelectedSession";
import { useSessionBehavior, useSessionPermissions, useSessionQuestions, useSessionSlot } from "./useSessionPermissions";
import { useSessionRunControl } from "./useSessionRunControl";
import { usePendingSends } from "./components/chat/usePendingSends";
import { createMessageSender } from "./components/chat/send-message";
import { useSyncProgress } from "./components/projects/useSyncProgress";
import { hostConnectionMessage, type HostConnection } from "./components/hosts/host-connection";
import Auth from "./components/Auth";
import Brand from "./components/Brand";
import ClientHubSwitch from "./components/ClientHubSwitch";
import Sidebar from "./components/Sidebar";
import Chat from "./components/Chat";
import Inspector, { type InspectorTabRequest } from "./components/Inspector";
import type { Notice } from "./components/AppNotices";
import AppOverlays, { type AppDialog } from "./windows/AppOverlays";
import { broadcastWindowEvent, subscribeWindowEvents } from "./windows/channel";
import { openDetachedWindow } from "./windows/launcher";
import type { SettingsTab } from "./windows/types";

const AdminPanel = lazy(() => import("./components/admin/AdminPanel"));

export default function App() {
  const siteSettings = useSiteSettings();
  const [auth, setAuth] = useState<{ needsSetup: boolean; registrationEnabled: boolean } | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [initialError, setInitialError] = useState("");
  const [streaming, setStreaming] = useState("");
  const [tools, setTools] = useState<ToolEvent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminVisited, setAdminVisited] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth >= 1280);
  const [streamConnected, setStreamConnected] = useState(false);
  const [inspectorRefresh, setInspectorRefresh] = useState(0);
  const [inspectorRequest, setInspectorRequest] = useState<InspectorTabRequest>();
  const [memoryRefreshTick, setMemoryRefreshTick] = useState(0);
  const [dialog, setDialog] = useState<AppDialog>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const sendRequestRef = useRef(0);
  const forking = useRef(false);
  const overviewRef = useRef<Overview | null>(null);
  overviewRef.current = overview;

  const notify = useCallback((content: string, kind: Notice["kind"] = "error") => {
    const id = Date.now() + Math.random();
    setNotices((current) => [...current.slice(-3), { id, content, kind }]);
    window.setTimeout(() => setNotices((current) => current.filter((item) => item.id !== id)), 7000);
  }, []);
  const refresh = useCallback(async () => {
    setOverview(await api<Overview>("/overview"));
  }, []);
  const closeAdmin = useCallback(() => setAdminOpen(false), []);
  const {
    projectId, sessionId, setSessionId, selectedProjectRef, selectedSessionRef, changeSelection,
    project, session, select, openSession, archiveSession, handleSessionDeleted, clearOpenedArchived,
  } = useSelectedSession({ overview, setOverview, sendRequestRef, onNavigate: closeAdmin, refresh, notify });
  const { sending, beginSend, clearPendingSends } = usePendingSends(projectId, sessionId);
  const { messages, turns, reloadMessages, receiveTurn, resetHistory } = useConversationHistory(selectedSessionRef);
  const receiveMaintenance = useCallback((maintenance: MaintenanceState) => {
    setOverview((current) => (current ? { ...current, maintenance } : current));
  }, []);
  const syncProgress = useSyncProgress(overview?.projects, notify, refresh);
  const changePermission = useSessionPermissions(setOverview, notify);
  const changeSlot = useSessionSlot(setOverview, notify);
  const changeBehavior = useSessionBehavior(setOverview, notify);
  const changeQuestions = useSessionQuestions(setOverview, notify);
  const runControl = useSessionRunControl(session, selectedSessionRef, setOverview, refresh, reloadMessages, notify);
  const refreshApprovals = useCallback(async () => {
    try {
      setApprovals(await api<Approval[]>("/approvals"));
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 401)) notify(errorText(cause));
    }
  }, [notify]);

  const clearSignedInState = useCallback((resetSelection: boolean) => {
    broadcastWindowEvent({ type: "logout" });
    setOverview(null);
    clearOpenedArchived();
    setAdminOpen(false);
    setAdminVisited(false);
    setDialog(null);
    resetHistory();
    setStreaming("");
    setTools([]);
    clearPendingSends();
    if (resetSelection) changeSelection("");
    else sendRequestRef.current += 1;
  }, [clearOpenedArchived, resetHistory, clearPendingSends, changeSelection]);

  async function initialize() {
    setInitializing(true);
    setInitialError("");
    try {
      // Branding availability must not prevent authentication or workspace access.
      void loadSiteSettings().catch(() => undefined);
      const status = await api<{ needsSetup: boolean; registrationEnabled: boolean }>("/auth/status");
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

  useEffect(() => { void initialize(); }, []);
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
      .catch((cause) => { if (!disposed) notify(errorText(cause)); })
      .finally(() => { if (!disposed) setLoadingMessages(false); });
    return () => { disposed = true; };
  }, [sessionId, !!overview, reloadMessages, resetHistory, notify]);

  useWorkspaceEvents({
    userId: overview?.user.id,
    selectedSessionRef,
    refresh,
    refreshApprovals,
    reloadMessages,
    receiveTurn,
    receiveMaintenance,
    notify,
    setStreamConnected,
    setStreaming,
    setTools,
    setInspectorRefresh,
  });

  useEffect(() => subscribeWindowEvents((message) => {
    if (message.type === "overview-changed") void refresh().catch(() => undefined);
    else if (message.type === "file-saved") setInspectorRefresh((value) => value + 1);
    else if (message.type === "memory-changed") setMemoryRefreshTick((value) => value + 1);
    else if (message.type === "open-session") {
      setAdminOpen(false);
      openSession(message.sessionId);
    } else if (message.type === "locate-file") {
      setAdminOpen(false);
      const targetProject = overviewRef.current?.projects.find((item) => item.id === message.projectId);
      if (targetProject && selectedProjectRef.current !== targetProject.id) select(targetProject);
      setInspectorOpen(true);
      setInspectorRequest({ tab: "files", path: message.path, id: Date.now() });
    }
  }), [refresh, openSession, select, selectedProjectRef]);

  useEffect(() => {
    const signedOut = () => clearSignedInState(false);
    window.addEventListener("clinavat:unauthorized", signedOut);
    return () => window.removeEventListener("clinavat:unauthorized", signedOut);
  }, [clearSignedInState]);

  const send = createMessageSender({
    project, session, userId: overview?.user.id, beginSend, request: sendRequestRef,
    selectedProject: selectedProjectRef, selectedSession: selectedSessionRef, selectSession: setSessionId,
    receiveSession: target => setOverview(previous => previous ? { ...previous, sessions: [target, ...previous.sessions] } : previous),
    clearOutput: () => { setStreaming(""); setTools([]); }, refresh, reloadMessages, notify,
  });

  async function decide(id: string, decision: "allow" | "deny", reason?: string) {
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
      const result = await post<HostConnection>(`/hosts/${host.id}/connect`);
      await refresh();
      notify(hostConnectionMessage(host.name, result), result.pendingApproval ? undefined : "success");
    } catch (cause) {
      notify(errorText(cause));
      await refresh().catch(() => {});
    }
  }

  async function remove() {
    if (dialog?.type !== "delete") return;
    const endpoint = dialog.kind === "host" ? "hosts" : dialog.kind === "project" ? "projects" : "sessions";
    await api(`/${endpoint}/${dialog.id}`, { method: "DELETE" });
    if (dialog.id === projectId) changeSelection("");
    else if (dialog.id === sessionId) changeSelection(projectId);
    await refresh();
    broadcastWindowEvent({ type: "overview-changed", reason: "hosts" });
    notify("已删除", "success");
  }

  async function fork(turn: Turn) {
    if (!project || !session || forking.current) return;
    forking.current = true;
    try {
      const created = await post<Session>(`/sessions/${session.id}/fork`, { turnId: turn.id });
      setOverview((current) => current
        ? { ...current, sessions: [created, ...current.sessions.filter((item) => item.id !== created.id)] } : current);
      select(project, created);
      notify("已创建分支，发送消息后从这一轮继续", "success");
    } catch (cause) {
      notify(errorText(cause));
    } finally {
      forking.current = false;
    }
  }

  async function logout() {
    try {
      await post("/auth/logout");
      clearSignedInState(true);
    } catch (cause) {
      notify(errorText(cause));
    }
  }

  const closeDialog = useCallback(() => setDialog(null), []);
  const openSettings = useCallback((tab?: SettingsTab) => {
    openDetachedWindow(tab ? { kind: "settings", tab } : { kind: "settings" }, {
      onFallback: () => setDialog({ type: "settings", tab }),
    });
  }, []);
  const openMemory = useCallback((target: Project) => {
    openDetachedWindow({ kind: "memory", projectId: target.id, projectName: target.name }, {
      onFallback: () => setDialog({ type: "memory", project: target }),
    });
  }, []);
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
        <button className="button button-primary" onClick={() => void initialize()}>重新连接服务</button>
        <ClientHubSwitch />
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
          setAuth((current) => (current ? { ...current, needsSetup: false } : current));
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
        syncProgress={syncProgress}
        onNewHost={() => setDialog({ type: "host" })}
        onEditHost={(host) => setDialog({ type: "host", host })}
        onNewProject={createProject}
        onConnect={(host) => void connect(host)}
        onRefresh={refresh}
        onNotice={notify}
        onDelete={(kind, id, name) => setDialog({ type: "delete", kind, id, name })}
        onRename={(selected) => setDialog({ type: "rename", session: selected })}
        onArchive={(selected, archived) => void archiveSession(selected, archived)}
        onDiscuss={(target) => setDialog({ type: "discussion", project: target })}
        onMemory={openMemory}
        onSettings={() => openSettings()}
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
          syncProgress={project && syncProgress[project.id]}
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
          onQuestionsChange={changeQuestions}
          onNotice={notify}
          onDiff={() => { setInspectorRequest({ tab: "changes", id: Date.now() }); setInspectorOpen(true); }}
          onSlotChange={changeSlot}
          onPause={runControl.pause}
          onResume={runControl.resume}
          onRestore={(target) => archiveSession(target, false).then(() => undefined)}
          onFork={(turn) => void fork(turn)}
          onOpenSession={openSession}
          controlPending={runControl.controlPending}
          stopPending={runControl.stopPending}
          onStop={() => void runControl.stop()}
          onApproval={decide}
        />
        {inspectorOpen && (
          <Inspector
            project={project}
            host={overview.hosts.find((item) => item.id === project?.dev_host_id)}
            refresh={inspectorRefresh}
            tabRequest={inspectorRequest}
            onClose={() => setInspectorOpen(false)}
            onRefresh={() => void refresh().catch((cause) => notify(errorText(cause)))}
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
      <AppOverlays
        overview={overview}
        dialog={dialog}
        notices={notices}
        memoryRefreshTick={memoryRefreshTick}
        onCloseDialog={closeDialog}
        onDismissNotice={(id) => setNotices((current) => current.filter((notice) => notice.id !== id))}
        onRefresh={refresh}
        onNotice={notify}
        onSelect={select}
        onChangeSelection={changeSelection}
        onDeleteConfirm={remove}
        onOpenSession={openSession}
        onRestoreSession={(target) => archiveSession(target, false)}
        onSessionDeleted={handleSessionDeleted}
      />
    </div>
  );
}
