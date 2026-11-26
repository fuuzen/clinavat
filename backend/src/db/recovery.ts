import type { Store } from '../database.js';
import type { User } from '../models.js';
import { ensureLocalHost } from '../local-host.js';

/** Reconciles interrupted runs, ephemeral host connections, orphan images, and expired tokens after Hub startup. */
export function runStartupRecovery(store: Store): void {
  // Images of a send that failed or of a discarded queued message. The day of grace keeps those of a send
  // retried across a restart.
  store.run(`DELETE FROM message_images WHERE created_at < datetime('now','-1 day')
    AND id NOT IN (SELECT image.value FROM messages, json_each(messages.images) AS image WHERE messages.images IS NOT NULL)
    AND id NOT IN (SELECT image.value FROM session_input_queue, json_tree(session_input_queue.inputs) AS image
      WHERE image.path LIKE '$[%].images')`);

  const interruptedAt = new Date().toISOString();
  store.run(`UPDATE session_turns SET status='interrupted',completed_at=?,paused_at=NULL,
    duration_ms=CASE WHEN status='paused' AND duration_ms IS NOT NULL THEN duration_ms
      ELSE MAX(0,CAST((julianday(?)-julianday(started_at))*86400000 AS INTEGER)-paused_ms) END
    WHERE status IN ('running','pausing','paused')`, interruptedAt, interruptedAt);
  store.run("UPDATE sessions SET status='interrupted' WHERE status IN ('running','waiting','pausing','paused')");
  // Their reports wait for the user in the master's agent panel; a restart never replays them by itself.
  store.run(`UPDATE agent_tasks SET status='interrupted',finished_at=?,report=COALESCE(report,'服务重新启动，子智能体的执行被中断')
    WHERE status='running'`, interruptedAt);
  store.run(`UPDATE discussions SET status='stopped',finished_at=?,detail='服务重新启动，讨论被中断' WHERE status='running'`, interruptedAt);
  store.run("UPDATE dev_hosts SET status='DISCONNECTED' WHERE status='CONNECTED' AND kind IN ('ssh','client')");
  for (const user of store.all<User>("SELECT * FROM users WHERE role='admin'")) ensureLocalHost(store, user.id);
  store.run("UPDATE approvals SET status='expired', reason='服务重新启动' WHERE status='pending'");
  store.run('DELETE FROM auth_sessions WHERE expires_at < ?', Date.now());
}
