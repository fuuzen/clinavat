import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { ApiError, errorText, fetchSessionById, post } from "../api";
import type { Notice } from "../components/AppNotices";
import type { ArchivedSessionItem, Overview, Project, Session } from "../types";
import { useWorkspaceSelection } from "../useWorkspaceSelection";

interface Options {
  overview: Overview | null;
  setOverview: Dispatch<SetStateAction<Overview | null>>;
  sendRequestRef: MutableRefObject<number>;
  onNavigate: () => void;
  refresh: () => Promise<void>;
  notify: (content: string, kind?: Notice["kind"]) => void;
}

function sortSessionsByUpdated(sessions: Session[]): Session[] {
  return [...sessions].sort((left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? ""));
}

/**
 * Resolves the currently selected project/session from active overview sessions or an on-demand
 * archived/child session lookup, and keeps selection + counts consistent across archive/restore/delete.
 */
export function useSelectedSession({
  overview,
  setOverview,
  sendRequestRef,
  onNavigate,
  refresh,
  notify,
}: Options) {
  const { projectId, setProjectId, sessionId, setSessionId } = useWorkspaceSelection();
  const selectedSessionRef = useRef(sessionId);
  selectedSessionRef.current = sessionId;
  const selectedProjectRef = useRef(projectId);
  selectedProjectRef.current = projectId;
  const [openedArchivedSession, setOpenedArchivedSession] = useState<Session | null>(null);
  const openAbortRef = useRef<AbortController | null>(null);
  const overviewRef = useRef(overview);
  overviewRef.current = overview;

  const changeSelection = useCallback((nextProjectId: string, nextSessionId = "") => {
    sendRequestRef.current += 1;
    selectedProjectRef.current = nextProjectId;
    selectedSessionRef.current = nextSessionId;
    setProjectId(nextProjectId);
    setSessionId(nextSessionId);
  }, [sendRequestRef, setProjectId, setSessionId]);

  const activeSession = overview?.sessions.find((item) => item.id === sessionId);
  const archivedMatch = openedArchivedSession?.id === sessionId ? openedArchivedSession : undefined;
  const session = activeSession ?? archivedMatch;
  const resolvedProjectId = session?.project_id || projectId;
  const project = overview?.projects.find((item) => item.id === resolvedProjectId);

  // Sync archived session by ID whenever selection is missing from active overview.sessions
  // (page reload, SSE overview refresh after auto-archive, or direct link).
  useEffect(() => {
    if (!overview || !sessionId) {
      setOpenedArchivedSession(null);
      return;
    }
    if (activeSession) {
      setOpenedArchivedSession(null);
      return;
    }
    if (openedArchivedSession?.id === sessionId) return;

    const controller = new AbortController();
    void fetchSessionById(sessionId, controller.signal)
      .then(({ session: fetched }) => {
        if (controller.signal.aborted) return;
        setOpenedArchivedSession(fetched);
        if (fetched.project_id && fetched.project_id !== projectId) {
          setProjectId(fetched.project_id);
        }
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 404) {
          setOpenedArchivedSession(null);
          changeSelection(projectId, "");
        }
      });
    return () => controller.abort();
  }, [overview, sessionId, activeSession, openedArchivedSession?.id, projectId, setProjectId, changeSelection]);

  useEffect(() => () => openAbortRef.current?.abort(), []);

  const select = useCallback((nextProject: Project, nextSession?: Session) => {
    openAbortRef.current?.abort();
    onNavigate();
    if (nextSession?.archived_at) setOpenedArchivedSession(nextSession);
    else setOpenedArchivedSession(null);
    changeSelection(nextProject.id, nextSession?.id);
  }, [onNavigate, changeSelection]);

  const openSessionObject = useCallback((target: Session & Partial<ArchivedSessionItem>) => {
    const current = overviewRef.current;
    if (!current) return;
    const owner = current.projects.find((item) => item.id === target.project_id)
      ?? (target.root_project_id ? current.projects.find((item) => item.id === target.root_project_id) : undefined);
    const inActiveList = current.sessions.some((item) => item.id === target.id);
    onNavigate();
    setOpenedArchivedSession(target.archived_at || !inActiveList ? target : null);
    changeSelection(owner?.id ?? target.project_id, target.id);
    if (!owner) void refresh().catch(() => {});
  }, [onNavigate, changeSelection, refresh]);

  const openSessionById = useCallback((targetId: string) => {
    const current = overviewRef.current;
    if (!current || !targetId) return;
    const active = current.sessions.find((item) => item.id === targetId);
    if (active) {
      openAbortRef.current?.abort();
      openSessionObject(active);
      return;
    }
    if (openedArchivedSession?.id === targetId) {
      openAbortRef.current?.abort();
      openSessionObject(openedArchivedSession);
      return;
    }
    openAbortRef.current?.abort();
    const controller = new AbortController();
    openAbortRef.current = controller;
    void fetchSessionById(targetId, controller.signal)
      .then(({ session: fetched }) => {
        if (controller.signal.aborted) return;
        openSessionObject(fetched);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        notify(errorText(cause));
      });
  }, [openedArchivedSession, openSessionObject, notify]);

  const openSession = useCallback((target: Session | ArchivedSessionItem | string) => {
    if (typeof target === "string") {
      openSessionById(target);
    } else {
      openAbortRef.current?.abort();
      openSessionObject(target);
    }
  }, [openSessionById, openSessionObject]);

  const archiveSession = useCallback(async (target: Session, archived: boolean): Promise<boolean> => {
    try {
      const updated = await post<Session>(`/sessions/${target.id}/${archived ? "archive" : "unarchive"}`);
      setOverview((current) => {
        if (!current) return current;
        if (archived) {
          const existed = current.sessions.some((item) => item.id === updated.id);
          return {
            ...current,
            sessions: current.sessions.filter((item) => item.id !== updated.id),
            archivedSessionsCount: (current.archivedSessionsCount ?? 0) + (existed ? 1 : 0),
          };
        }
        const existed = current.sessions.some((item) => item.id === updated.id);
        return {
          ...current,
          sessions: sortSessionsByUpdated([updated, ...current.sessions.filter((item) => item.id !== updated.id)]),
          archivedSessionsCount: Math.max(0, (current.archivedSessionsCount ?? 0) - (existed ? 0 : 1)),
        };
      });
      if (archived) {
        if (target.id === sessionId) changeSelection(projectId);
        setOpenedArchivedSession((current) => (current?.id === target.id ? null : current));
      } else {
        setOpenedArchivedSession((current) => (current?.id === updated.id ? null : current));
      }
      notify(
        archived
          ? `已归档「${target.title}」，可在「工作台设置 → 已归档对话」中查看或恢复`
          : `已恢复「${target.title}」`,
        "success",
      );
      return true;
    } catch (cause) {
      notify(errorText(cause));
      return false;
    }
  }, [setOverview, sessionId, projectId, changeSelection, notify]);

  const handleSessionDeleted = useCallback((deletedId: string) => {
    if (deletedId === sessionId) changeSelection(projectId);
    setOpenedArchivedSession((current) => (current?.id === deletedId ? null : current));
    setOverview((current) => current ? {
      ...current,
      sessions: current.sessions.filter((item) => item.id !== deletedId),
      archivedSessionsCount: Math.max(0, (current.archivedSessionsCount ?? 0) - 1),
    } : current);
    notify("已删除", "success");
  }, [sessionId, projectId, changeSelection, setOverview, notify]);

  const clearOpenedArchived = useCallback(() => {
    openAbortRef.current?.abort();
    setOpenedArchivedSession(null);
  }, []);

  return {
    projectId,
    sessionId,
    setSessionId,
    selectedProjectRef,
    selectedSessionRef,
    changeSelection,
    project,
    session,
    select,
    openSession,
    openSessionById,
    archiveSession,
    handleSessionDeleted,
    clearOpenedArchived,
  };
}

/**
 * Resolves a linked session (such as a fork source or child agent's master) from active sessions first,
 * falling back to `GET /api/sessions/:id` so archived origin sessions remain discoverable and clickable.
 */
export function useLinkedSession(targetId: string | null | undefined, sessions: Session[]) {
  const active = targetId ? sessions.find((item) => item.id === targetId) : undefined;
  const [resolved, setResolved] = useState<{ id: string; session?: Session; missing: boolean } | null>(null);

  useEffect(() => {
    if (!targetId || active) return;
    if (resolved?.id === targetId) return;
    const controller = new AbortController();
    void fetchSessionById(targetId, controller.signal)
      .then(({ session }) => {
        if (!controller.signal.aborted) setResolved({ id: targetId, session, missing: false });
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 404) {
          setResolved({ id: targetId, missing: true });
        }
      });
    return () => controller.abort();
  }, [targetId, active, resolved?.id]);

  if (!targetId) return { session: undefined, missing: false };
  if (active) return { session: active, missing: false };
  if (resolved?.id === targetId) return { session: resolved.session, missing: resolved.missing };
  return { session: undefined, missing: false };
}
