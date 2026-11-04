import { Clock3, Square, TerminalSquare, X } from "lucide-react";
import type { SessionRuntime } from "../../types";

interface Props {
  runtime: SessionRuntime;
  onCancelQueued: (id: string) => void;
  onStopTask: (id: string) => void;
}

/** Messages waiting for the running reply, and background tasks that will continue the conversation when they end. */
export default function RuntimeStrip({ runtime, onCancelQueued, onStopTask }: Props) {
  if (!runtime.queue.length && !runtime.tasks.length) return null;
  return (
    <div className="runtime-strip" aria-label="运行队列">
      {runtime.queue.map((item, index) => (
        <div key={item.id} className="runtime-item">
          <Clock3 size={13} aria-hidden="true" />
          <span className="runtime-item-label">排队 {index + 1}</span>
          <span className="runtime-item-text" title={item.content}>{item.content}</span>
          <button type="button" onClick={() => onCancelQueued(item.id)} title="取消发送" aria-label={`取消排队消息 ${index + 1}`}>
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
      {runtime.tasks.map((task) => (
        <div key={task.id} className="runtime-item">
          <TerminalSquare size={13} aria-hidden="true" />
          <span className="runtime-item-label">后台任务</span>
          <span className="runtime-item-text" title={task.description}>{task.description || task.id}</span>
          <button type="button" onClick={() => onStopTask(task.id)} title="停止后台任务" aria-label={`停止后台任务 ${task.description || task.id}`}>
            <Square size={11} fill="currentColor" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
