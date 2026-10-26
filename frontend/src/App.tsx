import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, LoaderCircle, X } from "lucide-react";
import { api, ApiError, errorText, post } from "./api";
import type {
  AgentSelection,
  Approval,
  DevHost,
  Overview,
  Project,
  Session,
  ToolEvent,
} from "./types";
import { useWorkspaceEvents } from "./useWorkspaceEvents";
import { useConversationHistory } from "./useConversationHistory";
import { HostDialog, ProjectDialog } from "./components/ResourceDialogs";
import { hostConnectionMessage, type HostConnection } from "./components/hosts/host-connection";
import Auth, { Brand } from "./components/Auth";
import Sidebar from "./components/Sidebar";
import Chat from "./components/Chat";
import Inspector from "./components/Inspector";
import Settings from "./components/Settings";
import {
  ConfirmDialog,
  RenameDialog,
  SessionDialog,
} from "./components/Dialogs";

type Dialog =
  | { type: "host"; host?: DevHost }
  | { type: "project"; host?: DevHost }
  | { type: "session"; project: Project }
  | {
      type: "delete";
      kind: "host" | "project" | "session";
      id: string;
      name: string;
    }
  | { type: "rename"; session: Session }
  | { type: "settings" }
  | null;
interface Notice {
  id: number;
  content: string;
  kind: "error" | "success";
}

export default function App() {
  const [auth, setAuth] = useState<{
    needsSetup: boolean;
    registrationEnabled: boolean;
  } | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [initialError, setInitialError] = useState("");
  const [projectId, setProjectId] = useState(
    () => localStorage.getItem("cc-pool-project") || "",
  );
  const [sessionId, setSessionId] = useState(
    () => localStorage.getItem("cc-pool-session") || "",
  );
  const [streaming, setStreaming] = useState("");
  const [tools, setTools] = useState<ToolEvent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(
    () => window.innerWidth >= 1280,
  );
  const [streamConnected, setStreamConnected] = useState(false);
  const [inspectorRefresh, setInspectorRefresh] = useState(0);
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
    localStorage.setItem("cc-pool-project", projectId);
    localStorage.setItem("cc-pool-session", sessionId);
  }, [projectId, sessionId]);
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
    setSending,
    setInspectorRefresh,
  });
  function changeSelection(nextProjectId: string, nextSessionId = "") {
    sendRequestRef.current += 1;
    setSending(false);
    selectedProjectRef.current = nextProjectId;
    selectedSessionRef.current = nextSessionId;
    setProjectId(nextProjectId);
    setSessionId(nextSessionId);
  }
  function select(nextProject: Project, nextSession?: Session) {
    changeSelection(nextProject.id, nextSession?.id);
  }
  async function send(
    content: string,
    engine: "claude" | "codex",
    selection: AgentSelection,
  ) {
    if (!project) return false;
    const request = ++sendRequestRef.current;
    const originProjectId = project.id;
    const originSessionId = selectedSessionRef.current;
    setSending(true);
    setStreaming("");
    setTools([]);
    try {
      let target = session;
      if (!target) {
        target = await post<Session>("/sessions", {
          projectId: project.id,
          engine,
          ...selection,
          title: content.slice(0, 40),
        });
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
      await post(`/sessions/${target.id}/messages`, { content, ...selection });
      await Promise.all([refresh(), reloadMessages(target.id)]);
      return request === sendRequestRef.current;
    } catch (cause) {
      notify(errorText(cause));
      if (request !== sendRequestRef.current) return false;
      throw cause;
    } finally {
      if (request === sendRequestRef.current) setSending(false);
    }
  }
  async function stop() {
    if (!session) return;
    const request = sendRequestRef.current;
    try {
      await post(`/sessions/${session.id}/stop`);
      if (request === sendRequestRef.current && selectedSessionRef.current === session.id)
        setSending(false);
      await Promise.all([refresh(), reloadMessages(session.id)]);
      notify("已发送停止请求", "success");
    } catch (cause) {
      notify(errorText(cause));
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
      setDialog(null);
      resetHistory();
      setStreaming("");
      setTools([]);
      sendRequestRef.current += 1;
      setSending(false);
    };
    window.addEventListener("cc-pool:unauthorized", signedOut);
    return () => window.removeEventListener("cc-pool:unauthorized", signedOut);
  }, [resetHistory]);
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
  return (
    <div className={`app-shell ${inspectorOpen ? "with-inspector" : ""}`}>
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
        onNewSession={(selected) =>
          setDialog({ type: "session", project: selected })
        }
        onConnect={(host) => void connect(host)}
        onDelete={(kind, id, name) =>
          setDialog({ type: "delete", kind, id, name })
        }
        onRename={(selected) =>
          setDialog({ type: "rename", session: selected })
        }
        onSettings={() => setDialog({ type: "settings" })}
        onLogout={() => void logout()}
      />
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
        onSend={send}
        onStop={() => void stop()}
        onApproval={decide}
      />
      {inspectorOpen && (
        <Inspector
          project={project}
          refresh={inspectorRefresh}
          onClose={() => setInspectorOpen(false)}
          onRefresh={() =>
            void refresh().catch((cause) => notify(errorText(cause)))
          }
        />
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
      {dialog?.type === "session" && (
        <SessionDialog
          overview={overview}
          project={dialog.project}
          onClose={closeDialog}
          onCreated={(created) => {
            changeSelection(created.project_id, created.id);
            void refresh().catch((cause) => notify(errorText(cause)));
          }}
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
      {dialog?.type === "settings" && (
        <Settings
          overview={overview}
          onClose={closeDialog}
          onRefresh={refresh}
        />
      )}
      <div className="notices" aria-live="polite">
        {notices.map((notice) => (
          <div key={notice.id} className={`notice notice-${notice.kind}`}>
            {notice.kind === "error" ? (
              <AlertCircle size={17} />
            ) : (
              <Check size={17} />
            )}
            <span>{notice.content}</span>
            <button
              className="icon-button"
              onClick={() =>
                setNotices((current) =>
                  current.filter((item) => item.id !== notice.id),
                )
              }
              aria-label="关闭通知"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
