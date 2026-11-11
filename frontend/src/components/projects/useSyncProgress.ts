import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { Project, SyncProgress } from "../../types";

const pollInterval = 2000;

/** Polls first-sync progress of projects still being created, and announces each one that becomes ready. */
export function useSyncProgress(
  projects: Project[] | undefined,
  notify: (content: string, kind?: "error" | "success") => void,
) {
  const [progress, setProgress] = useState<Record<string, SyncProgress>>({});
  const creating = (projects ?? []).filter((project) => project.sync_status === "CREATING").map((project) => project.id).join(",");
  useEffect(() => {
    const ids = creating ? creating.split(",") : [];
    setProgress((current) => Object.fromEntries(Object.entries(current).filter(([id]) => ids.includes(id))));
    if (!ids.length) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const results = await Promise.all(ids.map((id) =>
        api<SyncProgress | null>(`/projects/${id}/sync-progress`).then((result) => [id, result] as const, () => [id, null] as const)));
      if (cancelled) return;
      setProgress((current) => {
        const next = { ...current };
        for (const [id, result] of results) if (result) next[id] = result;
        return next;
      });
      timer = setTimeout(() => void poll(), pollInterval);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [creating]);
  const statuses = useRef<Map<string, string>>(undefined);
  useEffect(() => {
    if (!projects) return;
    const previous = statuses.current;
    statuses.current = new Map(projects.map((project) => [project.id, project.sync_status]));
    // Failures arrive as error events from the server with the reason; only completion is announced here.
    for (const project of projects) {
      if (previous?.get(project.id) === "CREATING" && project.sync_status === "WATCHING")
        notify(`项目「${project.name}」首次同步完成，可以开始工作了`, "success");
    }
  }, [projects, notify]);
  return progress;
}
