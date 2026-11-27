import { errorText } from "../api";
import type { ArchivedSessionItem, DevHost, Overview, Project, Session } from "../types";
import AppNotices, { type Notice } from "../components/AppNotices";
import { ConfirmDialog, RenameDialog } from "../components/Dialogs";
import HostDialog from "../components/hosts/HostDialog";
import ProjectDialog from "../components/projects/ProjectDialog";
import ProjectMemoryDialog from "../components/projects/ProjectMemoryDialog";
import DiscussionDialog from "../components/chat/agents/DiscussionDialog";
import Settings from "../components/Settings";
import { broadcastWindowEvent } from "./channel";
import type { SettingsTab } from "./types";

export type AppDialog =
  | { type: "host"; host?: DevHost }
  | { type: "project"; host?: DevHost }
  | {
      type: "delete";
      kind: "host" | "project" | "session";
      id: string;
      name: string;
    }
  | { type: "rename"; session: Session }
  | { type: "discussion"; project: Project }
  | { type: "memory"; project: Project }
  | { type: "settings"; tab?: SettingsTab }
  | null;

interface Props {
  overview: Overview;
  dialog: AppDialog;
  notices: Notice[];
  memoryRefreshTick: number;
  onCloseDialog: () => void;
  onDismissNotice: (id: number) => void;
  onRefresh: () => Promise<void>;
  onNotice: (content: string, kind?: Notice["kind"]) => void;
  onSelect: (project: Project, session?: Session) => void;
  onChangeSelection: (projectId: string, sessionId?: string) => void;
  onDeleteConfirm: () => Promise<void>;
  onOpenSession: (session: ArchivedSessionItem) => void;
  onRestoreSession: (session: Session) => Promise<boolean>;
  onSessionDeleted: (sessionId: string) => void;
}

export default function AppOverlays({
  overview,
  dialog,
  notices,
  memoryRefreshTick,
  onCloseDialog,
  onDismissNotice,
  onRefresh,
  onNotice,
  onSelect,
  onChangeSelection,
  onDeleteConfirm,
  onOpenSession,
  onRestoreSession,
  onSessionDeleted,
}: Props) {
  return (
    <>
      {dialog?.type === "host" && (
        <HostDialog
          key={dialog.host?.id || "new-host"}
          overview={overview}
          initialHost={dialog.host}
          onClose={onCloseDialog}
          onCreated={async () => {
            await onRefresh();
            broadcastWindowEvent({ type: "overview-changed", reason: "hosts" });
            if (dialog.host) {
              onNotice(
                dialog.host.kind === "client"
                  ? "客户端设备名称已更新"
                  : "连接配置已更新，测试连接后在项目中恢复同步",
                "success",
              );
            }
          }}
        />
      )}
      {dialog?.type === "project" && (
        <ProjectDialog
          overview={overview}
          initialHost={dialog.host}
          onClose={onCloseDialog}
          onCreated={async (created) => {
            onNotice(
              created.sync_status === "CREATING"
                ? `项目「${created.name}」已创建，正在后台进行首次同步`
                : `项目「${created.name}」已创建`,
              "success",
            );
            await onRefresh().catch((cause) => onNotice(errorText(cause)));
            broadcastWindowEvent({ type: "overview-changed", reason: "hosts" });
            onSelect(created);
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
          onClose={onCloseDialog}
          onConfirm={onDeleteConfirm}
        />
      )}
      {dialog?.type === "rename" && (
        <RenameDialog
          session={dialog.session}
          onClose={onCloseDialog}
          onSaved={onRefresh}
        />
      )}
      {dialog?.type === "settings" && (
        <Settings
          overview={overview}
          initialTab={dialog.tab}
          onClose={onCloseDialog}
          onRefresh={async () => {
            await onRefresh();
            broadcastWindowEvent({ type: "overview-changed", reason: "settings" });
          }}
          onNotice={onNotice}
          onOpenSession={onOpenSession}
          onRestoreSession={async (target) => {
            const restored = await onRestoreSession(target);
            if (restored) broadcastWindowEvent({ type: "overview-changed", reason: "archived" });
            return restored;
          }}
          onSessionDeleted={(sessionId) => {
            onSessionDeleted(sessionId);
            broadcastWindowEvent({ type: "overview-changed", reason: "archived" });
          }}
          onChanged={() => broadcastWindowEvent({ type: "overview-changed", reason: "settings" })}
        />
      )}
      {dialog?.type === "discussion" && (
        <DiscussionDialog
          overview={overview}
          project={dialog.project}
          onClose={onCloseDialog}
          onCreated={(sessionId) => {
            onCloseDialog();
            void onRefresh().then(() => onChangeSelection(dialog.project.id, sessionId));
          }}
        />
      )}
      {dialog?.type === "memory" && (
        <ProjectMemoryDialog
          project={dialog.project}
          refreshTick={memoryRefreshTick}
          onClose={onCloseDialog}
          onNotice={onNotice}
          onChanged={() => broadcastWindowEvent({ type: "memory-changed", projectId: dialog.project.id })}
        />
      )}
      <AppNotices notices={notices} onDismiss={onDismissNotice} />
    </>
  );
}
