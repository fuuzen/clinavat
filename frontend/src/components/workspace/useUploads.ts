import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "../../api";
import type { PickedFiles } from "./pickedFiles";
import { isPreconditionFailure, writeWorkspaceFile, type WritePrecondition } from "./transfers";

const parallelFiles = 3;

export interface UploadProgress {
  total: number;
  uploaded: number;
  totalBytes: number;
  sentBytes: number;
  current?: string;
  failures: { path: string; error: string }[];
  /** Existing files the user chose to keep instead of overwriting. */
  kept: number;
  skipped: number;
  running: boolean;
  cancelled: boolean;
}

interface Target {
  file: File;
  path: string;
}

export function useUploads(projectId: string | undefined, onUploaded: () => void) {
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const controller = useRef<AbortController | null>(null);
  const uploaded = useRef(onUploaded);
  useEffect(() => {
    uploaded.current = onUploaded;
  });
  useEffect(() => () => {
    controller.current?.abort();
    controller.current = null;
    setProgress(null);
  }, [projectId]);

  const start = useCallback(async (directory: string, picked: PickedFiles) => {
    if (!projectId || controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    const targets: Target[] = picked.files.map((item) => ({ file: item.file, path: [directory, item.path].filter(Boolean).join("/") }));
    const sent = new Map<Target, number>();
    const state: UploadProgress = {
      total: targets.length, uploaded: 0, totalBytes: targets.reduce((sum, item) => sum + item.file.size, 0), sentBytes: 0,
      failures: [], kept: 0, skipped: picked.skipped, running: true, cancelled: false,
    };
    // Once the project changes, this batch no longer owns the progress display.
    const publish = () => controller.current === abort && setProgress({ ...state, failures: [...state.failures] });
    const run = async (items: Target[], precondition?: WritePrecondition) => {
      const conflicts: Target[] = [];
      let next = 0;
      const worker = async () => {
        while (next < items.length && !abort.signal.aborted) {
          const item = items[next++];
          state.current = item.path;
          publish();
          try {
            await writeWorkspaceFile(projectId, item.path, item.file, {
              precondition, signal: abort.signal,
              onProgress: (bytes) => {
                state.sentBytes += bytes - (sent.get(item) ?? 0);
                sent.set(item, bytes);
                publish();
              },
            });
            state.uploaded++;
          } catch (error) {
            if (precondition === "create" && isPreconditionFailure(error)) conflicts.push(item);
            else if (!abort.signal.aborted) state.failures.push({ path: item.path, error: errorText(error) });
          }
          publish();
        }
      };
      await Promise.all(Array.from({ length: Math.min(parallelFiles, items.length) }, worker));
      return conflicts;
    };
    publish();
    const conflicts = await run(targets, "create");
    if (conflicts.length && !abort.signal.aborted) {
      const names = conflicts.slice(0, 8).map((item) => `  ${item.path}`).join("\n");
      const more = conflicts.length > 8 ? `\n  …等 ${conflicts.length} 个` : "";
      if (window.confirm(`以下文件已存在，是否覆盖？\n\n${names}${more}`)) await run(conflicts);
      else state.kept = conflicts.length;
    }
    if (controller.current !== abort) return;
    state.running = false;
    state.current = undefined;
    state.cancelled = abort.signal.aborted;
    publish();
    controller.current = null;
    if (state.uploaded) uploaded.current();
  }, [projectId]);

  const cancel = useCallback(() => controller.current?.abort(), []);
  const dismiss = useCallback(() => setProgress((current) => (current?.running ? current : null)), []);
  return { progress, start, cancel, dismiss };
}
