import type { RefObject } from "react";
import { errorText, post } from "../../api";
import type { AccountSelection, AgentBehavior, AgentSelection, InputMode, PermissionMode, Project, Session } from "../../types";
import { clearComposerDraft, getComposerDraftKey, moveComposerDraft, readComposerDraft } from "./composer/draftStorage";
import type { usePendingSends } from "./usePendingSends";

interface MessageSenderOptions {
  project?: Project;
  session?: Session;
  userId?: string;
  beginSend: ReturnType<typeof usePendingSends>["beginSend"];
  request: RefObject<number>;
  selectedProject: RefObject<string>;
  selectedSession: RefObject<string>;
  selectSession: (id: string) => void;
  receiveSession: (session: Session) => void;
  clearOutput: () => void;
  refresh: () => Promise<void>;
  reloadMessages: (sessionId: string) => Promise<void>;
  notify: (message: string) => void;
}

export function createMessageSender(options: MessageSenderOptions) {
  return async function send(content: string, selection: AgentSelection, permissionMode: PermissionMode,
    account: AccountSelection, behavior: AgentBehavior, mode?: InputMode): Promise<boolean> {
    const { project, session, userId } = options;
    if (!project || !userId) return false;
    const pending = options.beginSend(project.id, options.selectedSession.current);
    if (!pending) return false;
    const request = ++options.request.current;
    const originProjectId = project.id;
    const originSessionId = options.selectedSession.current;
    const originDraftKey = getComposerDraftKey(userId, originProjectId, originSessionId);
    const submittedDraft = readComposerDraft(originDraftKey);
    // Messages for a running reply keep its live output on screen.
    if (!mode) options.clearOutput();
    try {
      let target = session;
      if (!target) {
        target = await post<Session>("/sessions", {
          projectId: project.id, engine: account.engine, slotMode: account.slotMode,
          ...(account.slotMode === "manual" ? { slotId: account.slotId } : {}),
          ...selection, permissionMode, ...behavior, title: content.slice(0, 40),
        });
        moveComposerDraft(originDraftKey, getComposerDraftKey(userId, originProjectId, target.id),
          request === options.request.current ? undefined : submittedDraft);
        pending.useSession(target.id);
        options.receiveSession(target);
        if (request === options.request.current && options.selectedProject.current === originProjectId
          && options.selectedSession.current === originSessionId) {
          options.selectedSession.current = target.id;
          options.selectSession(target.id);
        }
      }
      await post(`/sessions/${target.id}/messages`, {
        content, ...selection, permissionMode, ...behavior, ...(mode ? { mode } : {}),
        // The backend owns the actual account in automatic mode; the view may still show the former one.
        ...(target.slot_mode === "manual" ? { slotId: account.slotId ?? target.slot_id } : {}),
      });
      clearComposerDraft(originDraftKey, submittedDraft);
      clearComposerDraft(getComposerDraftKey(userId, originProjectId, target.id), submittedDraft);
      await Promise.all([options.refresh(), options.reloadMessages(target.id)]);
      return request === options.request.current;
    } catch (cause) {
      options.notify(errorText(cause));
      if (request !== options.request.current) return false;
      throw cause;
    } finally { pending.finish(); }
  };
}
