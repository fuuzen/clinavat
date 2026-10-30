import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText, post } from "../../../api";

export interface CodexGoal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

interface GoalResponse { goal: CodexGoal | null }
interface GoalView {
  goal: CodexGoal | null;
  loaded: boolean;
  loading: boolean;
  pending: boolean;
  error: string;
  visible: boolean;
  editing: boolean;
  draft?: string;
}
interface GoalEvent { sessionId?: string; goal?: CodexGoal | null }
type GoalAction = "create" | "pause" | "resume" | "edit";
const emptyView: GoalView = { goal: null, loaded: false, loading: false, pending: false, error: "", visible: false, editing: false };

export function useCodexGoal(props: {
  sessionId?: string;
  enabled: boolean;
  connected: boolean;
  executing: boolean;
  onNotice: (message: string, kind?: "error" | "success") => void;
}) {
  const views = useRef(new Map<string, GoalView>());
  const versions = useRef(new Map<string, number>());
  const pending = useRef(new Set<string>());
  const mounted = useRef(true);
  const [, render] = useState(0);
  const currentId = props.enabled ? props.sessionId : undefined;
  const current = useRef(currentId);
  current.current = currentId;
  const notify = useRef(props.onNotice);
  notify.current = props.onNotice;

  const update = useCallback((id: string, fields: Partial<GoalView>) => {
    views.current.set(id, { ...(views.current.get(id) ?? emptyView), ...fields });
    if (mounted.current) render(value => value + 1);
  }, []);
  const invalidate = useCallback((id: string) => {
    const version = (versions.current.get(id) ?? 0) + 1;
    versions.current.set(id, version);
    return version;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async (id: string): Promise<boolean> => {
    if (pending.current.has(id)) return false;
    const version = invalidate(id);
    update(id, { loading: true, error: "" });
    try {
      const result = await api<GoalResponse>(`/sessions/${id}/goal`);
      if (versions.current.get(id) === version) update(id, { goal: result.goal, loaded: true, loading: false });
      return true;
    } catch (cause) {
      if (versions.current.get(id) === version) update(id, { error: errorText(cause), loading: false });
      return false;
    }
  }, [invalidate, update]);

  useEffect(() => {
    if (currentId && props.connected) void refresh(currentId);
  }, [currentId, props.connected, refresh]);
  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<GoalEvent>).detail;
      if (!detail?.sessionId) return;
      if (Object.hasOwn(detail, "goal")) {
        invalidate(detail.sessionId);
        update(detail.sessionId, { goal: detail.goal ?? null, loaded: true, loading: false, error: "" });
      } else if (detail.sessionId === current.current && !refreshTimer) {
        const id = detail.sessionId;
        refreshTimer = setTimeout(() => { refreshTimer = undefined; if (current.current === id) void refresh(id); }, 200);
      }
    };
    window.addEventListener("clinavat:goal", receive);
    return () => { window.removeEventListener("clinavat:goal", receive); if (refreshTimer) clearTimeout(refreshTimer); };
  }, [invalidate, refresh, update]);

  function requireSession(): string | undefined {
    if (!props.enabled) { notify.current("Goal 仅适用于 Codex 对话。"); return; }
    if (!currentId) { notify.current("请先发送一条消息建立 Codex 对话，再设置 Goal。"); return; }
    return currentId;
  }

  async function mutate(action: GoalAction, objective?: string): Promise<boolean> {
    const id = requireSession();
    if (!id) return false;
    const fail = (message: string) => { update(id, { error: message, visible: true }); notify.current(message); return false; };
    if (!props.connected) return fail("连接已断开，恢复连接后再管理 Goal。");
    if (pending.current.has(id)) { notify.current("当前 Goal 操作正在处理中，请稍候。"); return false; }
    const text = objective?.trim();
    if ((action === "create" || action === "edit") && !text) return fail("目标内容不能为空。");
    if (text && text.length > 4000) return fail("目标内容不能超过 4000 个字符。");
    const view = views.current.get(id);
    if (action !== "create" && view?.loaded && !view.goal) return fail("当前还没有 Goal，使用 /goal 目标内容 创建。");
    if (action === "create" && view?.goal) return fail("当前已有 Goal，使用 /goal edit 修改目标。");
    if (action === "pause" && view?.goal?.status === "paused") return fail("Goal 已暂停，可使用 /goal resume 继续。");
    if (action === "resume" && view?.goal?.status === "active" && props.executing) return fail("Goal 已在执行中。");
    pending.current.add(id);
    const version = invalidate(id);
    update(id, { pending: true, loading: false, visible: true, error: "" });
    try {
      const result = await post<GoalResponse>(`/sessions/${id}/goal`, { action, ...(text !== undefined ? { objective: text } : {}) });
      if (versions.current.get(id) === version) update(id, { goal: result.goal, loaded: true, loading: false });
      if (action === "create" || action === "edit") update(id, { editing: false, draft: undefined });
      if (current.current === id) notify.current(action === "pause" ? "Goal 已暂停。" : action === "resume" ? "Goal 已继续。" : action === "edit" ? "Goal 已保存。" : "Goal 已创建。", "success");
      return true;
    } catch (cause) {
      const message = errorText(cause);
      update(id, { error: message });
      if (current.current === id) notify.current(message);
      return false;
    } finally {
      pending.current.delete(id);
      update(id, { pending: false });
    }
  }

  async function show(): Promise<boolean> {
    const id = requireSession();
    if (!id) return false;
    update(id, { visible: true });
    if (!props.connected) { update(id, { error: "连接已断开，恢复连接后将同步 Goal 状态。" }); return true; }
    await refresh(id);
    return true;
  }

  async function edit(): Promise<boolean> {
    const id = requireSession();
    if (!id) return false;
    update(id, { visible: true });
    if (!views.current.get(id)?.loaded && (!props.connected || !await refresh(id))) {
      notify.current("暂时无法读取 Goal，请恢复连接或重试。");
      return false;
    }
    const view = views.current.get(id)!;
    if (!view.goal) { notify.current("当前还没有 Goal，使用 /goal 目标内容 创建。"); return false; }
    if (view.pending) { notify.current("当前 Goal 操作正在处理中，请稍候。"); return false; }
    update(id, { editing: true, draft: view.draft ?? view.goal.objective, error: "" });
    return true;
  }

  async function handleCommand(arguments_: string): Promise<boolean> {
    const value = arguments_.trim();
    if (!value) return show();
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(value)!;
    const action = match[1]!.toLowerCase();
    const rest = (match[2] ?? "").trim();
    if (action === "edit") return rest ? mutate("edit", rest) : edit();
    if (action === "pause" || action === "resume") {
      if (rest) { notify.current(`/goal ${action} 不接受附加参数。`); return false; }
      return mutate(action);
    }
    return mutate("create", value);
  }

  const view = currentId ? views.current.get(currentId) ?? emptyView : emptyView;
  return {
    ...view,
    connected: props.connected,
    executing: props.executing,
    visible: !!currentId && (view.visible || !!view.goal),
    handleCommand,
    refresh: () => currentId ? refresh(currentId) : Promise.resolve(false),
    pause: () => mutate("pause"),
    resume: () => mutate("resume"),
    edit,
    save: () => mutate(view.goal ? "edit" : "create", view.draft ?? ""),
    beginCreate: () => { if (currentId) update(currentId, { editing: true, draft: view.draft ?? "", error: "" }); },
    setDraft: (draft: string) => { if (currentId) update(currentId, { draft }); },
    cancelEdit: () => { if (currentId && !view.pending) update(currentId, { editing: false, error: "" }); },
    dismiss: () => { if (currentId && !view.pending) update(currentId, { visible: false, editing: false, error: "" }); },
  };
}

export type CodexGoalControl = ReturnType<typeof useCodexGoal>;
