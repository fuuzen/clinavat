use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::ops::fs_common::now_ms;
use crate::ops::proc::process_tree::ProcessTree;
use crate::ops::{RpcCallError, RpcErrorCode};

pub const MAX_CAPTURE_BYTES: usize = 256 * 1024;
const MAX_TRACKED_TASKS_TOTAL: usize = 64;
const MAX_TRACKED_TASKS_PER_SESSION: usize = 16;

/// Rolling bounded byte buffer that drains command output without unbounded RAM growth.
#[derive(Debug, Default)]
pub struct BoundedOutput {
    buf: VecDeque<u8>,
    pub total_bytes: u64,
    pub truncated: bool,
}

impl BoundedOutput {
    pub fn push(&mut self, chunk: &[u8]) {
        self.total_bytes = self.total_bytes.saturating_add(chunk.len() as u64);
        if chunk.len() >= MAX_CAPTURE_BYTES {
            self.buf.clear();
            self.buf.extend(&chunk[chunk.len() - MAX_CAPTURE_BYTES..]);
            self.truncated = true;
            return;
        }
        let overflow = (self.buf.len() + chunk.len()).saturating_sub(MAX_CAPTURE_BYTES);
        if overflow > 0 {
            self.buf.drain(..overflow);
            self.truncated = true;
        }
        self.buf.extend(chunk);
    }

    pub fn to_lossy_string(&self) -> String {
        let (a, b) = self.buf.as_slices();
        let mut raw = Vec::with_capacity(a.len() + b.len());
        raw.extend_from_slice(a);
        raw.extend_from_slice(b);
        String::from_utf8_lossy(&raw).into_owned()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Running,
    Exited,
    Killed,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Exited => "exited",
            Self::Killed => "killed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct TaskCompletion {
    pub status: TaskStatus,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub finished_at: Option<u64>,
}

pub struct ManagedTask {
    pub task_id: String,
    pub session_id: String,
    pub command: String,
    pub cwd: PathBuf,
    pub started_at: u64,
    pub tree: Arc<ProcessTree>,
    pub stdout: Arc<Mutex<BoundedOutput>>,
    pub stderr: Arc<Mutex<BoundedOutput>>,
    pub stdin_tx: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    pub completion: Mutex<TaskCompletion>,
}

impl ManagedTask {
    fn snapshot_completion(&self) -> TaskCompletion {
        self.completion.lock().map(|g| g.clone()).unwrap_or(TaskCompletion {
            status: TaskStatus::Running,
            exit_code: None,
            signal: None,
            finished_at: None,
        })
    }

    pub fn summary_json(&self) -> Value {
        let comp = self.snapshot_completion();
        let stdout_bytes = self.stdout.lock().map(|g| g.total_bytes).unwrap_or(0);
        let stderr_bytes = self.stderr.lock().map(|g| g.total_bytes).unwrap_or(0);
        json!({
            "taskId": self.task_id,
            "sessionId": self.session_id,
            "command": self.command,
            "cwd": self.cwd.to_string_lossy(),
            "status": comp.status.as_str(),
            "running": comp.status == TaskStatus::Running,
            "exitCode": comp.exit_code,
            "signal": comp.signal,
            "pid": self.tree.pid(),
            "startedAt": self.started_at,
            "finishedAt": comp.finished_at,
            "stdoutBytes": stdout_bytes,
            "stderrBytes": stderr_bytes,
        })
    }

    pub fn detail_json(&self) -> Value {
        let comp = self.snapshot_completion();
        let (stdout, out_trunc) = self.stdout.lock().map(|g| (g.to_lossy_string(), g.truncated)).unwrap_or_default();
        let (stderr, err_trunc) = self.stderr.lock().map(|g| (g.to_lossy_string(), g.truncated)).unwrap_or_default();
        json!({
            "taskId": self.task_id,
            "sessionId": self.session_id,
            "status": comp.status.as_str(),
            "running": comp.status == TaskStatus::Running,
            "exitCode": comp.exit_code,
            "signal": comp.signal,
            "pid": self.tree.pid(),
            "stdout": stdout,
            "stderr": stderr,
            "truncated": out_trunc || err_trunc,
            "startedAt": self.started_at,
            "finishedAt": comp.finished_at,
        })
    }

    pub fn mark_exited(&self, exit_code: i32, signal: Option<i32>) {
        if let Ok(mut tx) = self.stdin_tx.lock() { *tx = None; }
        if let Ok(mut comp) = self.completion.lock() {
            if comp.status == TaskStatus::Running {
                comp.status = TaskStatus::Exited;
            }
            comp.exit_code = Some(exit_code);
            comp.signal = signal;
            comp.finished_at = Some(now_ms());
        }
    }

    pub fn mark_killed(&self) {
        if let Ok(mut tx) = self.stdin_tx.lock() { *tx = None; }
        // Only terminate while un-reaped; already-exited tasks keep `Exited` status and never get signaled (`H3`).
        let already_done = self
            .completion
            .lock()
            .map(|c| c.status != TaskStatus::Running)
            .unwrap_or(false);
        if already_done {
            return;
        }
        self.tree.terminate();
        if let Ok(mut comp) = self.completion.lock() {
            if comp.status == TaskStatus::Running {
                comp.status = TaskStatus::Killed;
                comp.finished_at = Some(now_ms());
            }
        }
    }
}

#[derive(Default)]
struct TaskStoreInner {
    tasks: HashMap<String, Arc<ManagedTask>>,
    reserved: HashSet<String>,
}

/// RAII reservation that holds a custom `taskId` before spawning a child process (`L2`).
pub struct TaskIdReservation {
    task_id: String,
    inner: Arc<Mutex<TaskStoreInner>>,
    committed: bool,
}

impl TaskIdReservation {
    pub fn task_id(&self) -> &str {
        &self.task_id
    }
}

impl Drop for TaskIdReservation {
    fn drop(&mut self) {
        if !self.committed {
            if let Ok(mut guard) = self.inner.lock() {
                guard.reserved.remove(&self.task_id);
            }
        }
    }
}

/// Session-scoped background task store with per-session quota isolation (`L1`) and uniform `ENOENT` (`L4`).
#[derive(Default)]
pub struct BackgroundTaskStore {
    inner: Arc<Mutex<TaskStoreInner>>,
}

impl BackgroundTaskStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Atomically reserves a custom `task_id` before spawning so duplicate IDs fail with `CONFLICT` first.
    pub fn reserve(&self, task_id: String) -> Result<TaskIdReservation, RpcCallError> {
        let mut guard = self.inner.lock()
            .map_err(|_| RpcCallError::new(RpcErrorCode::InternalError, "task store lock poisoned"))?;
        if guard.tasks.contains_key(&task_id) || guard.reserved.contains(&task_id) {
            return Err(RpcCallError::new(
                RpcErrorCode::Conflict,
                format!("background task already exists: {task_id}"),
            ));
        }
        guard.reserved.insert(task_id.clone());
        Ok(TaskIdReservation { task_id, inner: Arc::clone(&self.inner), committed: false })
    }

    pub fn insert(&self, task: Arc<ManagedTask>, reservation: Option<&mut TaskIdReservation>) -> Result<(), RpcCallError> {
        let mut guard = self.inner.lock()
            .map_err(|_| RpcCallError::new(RpcErrorCode::InternalError, "task store lock poisoned"))?;
        let reserved_here = reservation.as_ref().is_some_and(|r| r.task_id == task.task_id);
        if guard.tasks.contains_key(&task.task_id) || (!reserved_here && guard.reserved.contains(&task.task_id)) {
            return Err(RpcCallError::new(
                RpcErrorCode::Conflict,
                format!("background task already exists: {}", task.task_id),
            ));
        }
        // Per-session quota check first: evict oldest finished task in the same session before rejecting (`L1`).
        let session_count = guard.tasks.values().filter(|t| t.session_id == task.session_id).count();
        if session_count >= MAX_TRACKED_TASKS_PER_SESSION {
            let evict = guard
                .tasks
                .iter()
                .filter(|(_, t)| {
                    t.session_id == task.session_id && t.snapshot_completion().status != TaskStatus::Running
                })
                .min_by_key(|(_, t)| t.started_at)
                .map(|(k, _)| k.clone());
            match evict {
                Some(k) => { guard.tasks.remove(&k); }
                None => return Err(RpcCallError::new(RpcErrorCode::Conflict, "session background task quota reached")),
            }
        }
        if guard.tasks.len() >= MAX_TRACKED_TASKS_TOTAL {
            let evict = guard
                .tasks
                .iter()
                .filter(|(_, t)| t.snapshot_completion().status != TaskStatus::Running)
                .min_by_key(|(_, t)| t.started_at)
                .map(|(k, _)| k.clone());
            match evict {
                Some(k) => { guard.tasks.remove(&k); }
                None => return Err(RpcCallError::new(RpcErrorCode::Conflict, "maximum concurrent background tasks reached")),
            }
        }
        if let Some(res) = reservation {
            guard.reserved.remove(&res.task_id);
            res.committed = true;
        }
        guard.tasks.insert(task.task_id.clone(), task);
        Ok(())
    }

    pub fn list_for_session(&self, session_id: &str) -> Vec<Value> {
        let Ok(guard) = self.inner.lock() else { return Vec::new() };
        let mut items: Vec<(u64, Value)> = guard
            .tasks
            .values()
            .filter(|t| t.session_id == session_id)
            .map(|t| (t.started_at, t.summary_json()))
            .collect();
        items.sort_by_key(|(ts, _)| *ts);
        items.into_iter().map(|(_, v)| v).collect()
    }

    /// Uniformly returns `ENOENT` for unknown and cross-session task IDs to avoid leaking existence (`L4`).
    pub fn get_for_session(&self, session_id: &str, task_id: &str) -> Result<Arc<ManagedTask>, RpcCallError> {
        let guard = self.inner.lock()
            .map_err(|_| RpcCallError::new(RpcErrorCode::InternalError, "task store lock poisoned"))?;
        match guard.tasks.get(task_id) {
            Some(task) if task.session_id == session_id => Ok(Arc::clone(task)),
            _ => Err(RpcCallError::new(RpcErrorCode::Enoent, format!("background task not found: {task_id}"))),
        }
    }

    pub fn cleanup_all(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.reserved.clear();
            for (_, task) in guard.tasks.drain() {
                task.mark_killed();
            }
        }
    }
}

impl Drop for BackgroundTaskStore {
    fn drop(&mut self) {
        self.cleanup_all();
    }
}
