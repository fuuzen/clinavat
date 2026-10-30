import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "../../api";
import type { DevHost, Overview, Project, User } from "../../types";

export interface AdminResourceView {
  user: User;
  hosts: DevHost[];
  projects: Project[];
  sessionCounts: Record<string, number>;
}

interface ResourceViewState {
  userId: string;
  resources: AdminResourceView | null;
  loading: boolean;
  error: string;
}

export function useResourceView(overview: Overview, userId: string, onRefresh: () => Promise<void>) {
  const currentUser = userId === overview.user.id;
  const selectedUserRef = useRef(userId);
  selectedUserRef.current = userId;
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<ResourceViewState>({ userId, resources: null, loading: !currentUser, error: "" });
  const currentResources = useMemo<AdminResourceView>(() => {
    const projectIds = new Set(overview.projects.map((project) => project.id));
    const sessionCounts: Record<string, number> = {};
    for (const session of overview.sessions) {
      if (projectIds.has(session.project_id)) sessionCounts[session.project_id] = (sessionCounts[session.project_id] || 0) + 1;
    }
    return { user: overview.user, hosts: overview.hosts, projects: overview.projects, sessionCounts };
  }, [overview.user, overview.hosts, overview.projects, overview.sessions]);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ userId, resources: null, loading: true, error: "" });
    const active = () => !controller.signal.aborted && request === requestRef.current && selectedUserRef.current === userId;
    try {
      if (currentUser) {
        await onRefresh();
        if (active()) setState({ userId, resources: null, loading: false, error: "" });
      } else {
        const resources = await api<AdminResourceView>(`/admin/resources?userId=${encodeURIComponent(userId)}`, { signal: controller.signal });
        if (resources.user.id !== userId) throw new Error("资源所属用户与当前视图不一致，请刷新重试。");
        if (active()) setState({ userId, resources, loading: false, error: "" });
      }
    } catch (cause) {
      if (active()) setState({ userId, resources: null, loading: false, error: errorText(cause) });
    }
  }, [currentUser, onRefresh, userId]);

  useEffect(() => {
    if (currentUser) {
      requestRef.current++;
      controllerRef.current?.abort();
      setState({ userId, resources: null, loading: false, error: "" });
    } else {
      void refresh();
    }
    return () => {
      requestRef.current++;
      controllerRef.current?.abort();
    };
  }, [currentUser, refresh, userId]);

  const selected = state.userId === userId;
  return {
    resources: currentUser ? currentResources : selected ? state.resources : null,
    loading: selected ? state.loading : !currentUser,
    error: selected ? state.error : "",
    refresh,
  };
}
