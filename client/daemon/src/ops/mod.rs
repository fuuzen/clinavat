pub mod fs_browse;
pub mod fs_common;
pub mod fs_mutate;
pub mod fs_read;
pub mod fs_staging;
pub mod fs_write;
pub mod git;
pub mod patch;
pub mod proc;
pub mod search;
pub mod sync;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

use crate::ops::fs_staging::WriteStagingStore;
use crate::ops::proc::{BackgroundTaskStore, PtyStore};
use crate::path_guard::{ClientPlatform, PathGuardError};

/// Inbound frame delivered from Hub to a bidirectional daemon stream (`pty.open`, `sync.push_batch`).
#[derive(Debug)]
pub enum StreamInbound {
    Data(Bytes),
    Eof(Bytes),
}

/// Active stream registration tracked by `RpcRouter`.
pub struct ActiveStream {
    pub cancel: CancellationToken,
    pub inbound_tx: Option<mpsc::UnboundedSender<StreamInbound>>,
    pub pending_bytes: Arc<AtomicUsize>,
    pub max_pending_bytes: usize,
}

/// Safe per-response JSON payload cap kept well below the 4 MiB Layer-1 frame limit.
pub const SAFE_RPC_RESPONSE_BYTES: usize = 3 * 1024 * 1024;

/// Canonical Hub -> Client RPC error codes aligned with `workspace-adapter.ts::mapClientRpcError`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RpcErrorCode {
    Enoent,
    Eacces,
    Eisdir,
    Enotdir,
    PreconditionFailed,
    Conflict,
    Ebusy,
    SharingViolation,
    LockViolation,
    PayloadTooLarge,
    RpcTimeout,
    InvalidArgument,
    MethodNotFound,
    InternalError,
}

impl RpcErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Enoent => "ENOENT",
            Self::Eacces => "EACCES",
            Self::Eisdir => "EISDIR",
            Self::Enotdir => "ENOTDIR",
            Self::PreconditionFailed => "PRECONDITION_FAILED",
            Self::Conflict => "CONFLICT",
            Self::Ebusy => "EBUSY",
            Self::SharingViolation => "SHARING_VIOLATION",
            Self::LockViolation => "LOCK_VIOLATION",
            Self::PayloadTooLarge => "PAYLOAD_TOO_LARGE",
            Self::RpcTimeout => "RPC_TIMEOUT",
            Self::InvalidArgument => "INVALID_ARGUMENT",
            Self::MethodNotFound => "METHOD_NOT_FOUND",
            Self::InternalError => "INTERNAL_ERROR",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RpcCallError {
    pub code: RpcErrorCode,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcCallError {
    pub fn new(code: RpcErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), data: None }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(RpcErrorCode::InvalidArgument, message)
    }
}

impl From<PathGuardError> for RpcCallError {
    fn from(err: PathGuardError) -> Self {
        match err {
            PathGuardError::InvalidArgument(msg) => Self::new(RpcErrorCode::InvalidArgument, msg),
            PathGuardError::AccessDenied(msg) => Self::new(RpcErrorCode::Eacces, msg),
            PathGuardError::NotFound(msg) => Self::new(RpcErrorCode::Enoent, msg),
            PathGuardError::Io(io_err) => Self::from(io_err),
        }
    }
}

impl From<std::io::Error> for RpcCallError {
    fn from(err: std::io::Error) -> Self {
        use std::io::ErrorKind;
        #[cfg(unix)]
        if err.raw_os_error() == Some(libc::ELOOP) {
            return Self::new(RpcErrorCode::Eacces, "symlink traversal is forbidden");
        }
        let code = match err.kind() {
            ErrorKind::NotFound => RpcErrorCode::Enoent,
            ErrorKind::PermissionDenied => RpcErrorCode::Eacces,
            ErrorKind::AlreadyExists => RpcErrorCode::PreconditionFailed,
            ErrorKind::InvalidInput => RpcErrorCode::InvalidArgument,
            ErrorKind::ResourceBusy => RpcErrorCode::Ebusy,
            ErrorKind::IsADirectory => RpcErrorCode::Eisdir,
            ErrorKind::NotADirectory => RpcErrorCode::Enotdir,
            // Hub mapClientRpcError maps CONFLICT -> HTTP 409 (ENOTEMPTY is unmapped and would become 502).
            ErrorKind::DirectoryNotEmpty => RpcErrorCode::Conflict,
            _ => match err.raw_os_error() {
                Some(32) => RpcErrorCode::SharingViolation,
                Some(33) => RpcErrorCode::LockViolation,
                Some(16) => RpcErrorCode::Ebusy,
                _ => RpcErrorCode::InternalError,
            },
        };
        Self::new(code, err.to_string())
    }
}

/// All 22 Hub -> Client RPC methods defined across `workspace-adapter.ts` and `mirror-sync.ts`.
pub const ALL_CLIENT_RPC_METHODS: &[&str] = &[
    "fs.list_directories",
    "fs.list",
    "fs.stat",
    "fs.read",
    "fs.read_stream",
    "fs.write",
    "fs.edit",
    "fs.apply_patch",
    "fs.delete",
    "fs.mkdir",
    "search.glob",
    "search.grep",
    "git.status",
    "git.worktree",
    "exec.command",
    "exec.manage_task",
    "pty.open",
    "pty.resize",
    "pty.close",
    "sync.scan",
    "sync.pull_batch",
    "sync.push_batch",
];

/// Per-connection operational state cleaned up automatically on transport teardown.
pub struct SessionOpsState {
    pub staging: WriteStagingStore,
    pub tasks: BackgroundTaskStore,
    pub ptys: PtyStore,
}

impl SessionOpsState {
    pub fn new(state_dir: Option<PathBuf>) -> Self {
        Self {
            staging: WriteStagingStore::new(state_dir),
            tasks: BackgroundTaskStore::new(),
            ptys: PtyStore::new(),
        }
    }

    pub fn cleanup_all(&self) {
        self.ptys.cleanup_all();
        self.tasks.cleanup_all();
        self.staging.cleanup_all();
    }
}

#[derive(Clone)]
pub struct OpContext {
    pub id: u32,
    pub stream_id: u32,
    pub device_id: String,
    pub homedir: String,
    pub platform: ClientPlatform,
    pub cancel: CancellationToken,
    pub outbound_tx: mpsc::Sender<Bytes>,
    pub active_streams: Arc<Mutex<HashMap<u32, ActiveStream>>>,
    pub response_sent: watch::Receiver<bool>,
    pub state: Arc<SessionOpsState>,
}

impl OpContext {
    pub fn register_stream(&self, stream_id: u32) -> Result<CancellationToken, RpcCallError> {
        let mut guard = self.active_streams.lock()
            .map_err(|_| RpcCallError::new(RpcErrorCode::InternalError, "active_streams lock poisoned"))?;
        if guard.contains_key(&stream_id) {
            return Err(RpcCallError::new(RpcErrorCode::Conflict, format!("streamId already active: {stream_id}")));
        }
        let token = CancellationToken::new();
        guard.insert(stream_id, ActiveStream {
            cancel: token.clone(),
            inbound_tx: None,
            pending_bytes: Arc::new(AtomicUsize::new(0)),
            max_pending_bytes: 0,
        });
        Ok(token)
    }

    #[allow(clippy::type_complexity)]
    pub fn register_duplex_stream(
        &self, stream_id: u32, max_pending_bytes: usize,
    ) -> Result<(CancellationToken, mpsc::UnboundedReceiver<StreamInbound>, Arc<AtomicUsize>), RpcCallError> {
        let mut guard = self.active_streams.lock()
            .map_err(|_| RpcCallError::new(RpcErrorCode::InternalError, "active_streams lock poisoned"))?;
        if guard.contains_key(&stream_id) {
            return Err(RpcCallError::new(RpcErrorCode::Conflict, format!("streamId already active: {stream_id}")));
        }
        let token = CancellationToken::new();
        let (tx, rx) = mpsc::unbounded_channel();
        let pending = Arc::new(AtomicUsize::new(0));
        guard.insert(stream_id, ActiveStream {
            cancel: token.clone(),
            inbound_tx: Some(tx),
            pending_bytes: Arc::clone(&pending),
            max_pending_bytes,
        });
        Ok((token, rx, pending))
    }

    pub fn unregister_stream(&self, stream_id: u32) {
        if let Ok(mut guard) = self.active_streams.lock() {
            guard.remove(&stream_id);
        }
    }
}

pub async fn dispatch_method(method: &str, params: Option<Value>, ctx: OpContext) -> Result<Value, RpcCallError> {
    if ctx.cancel.is_cancelled() {
        return Err(RpcCallError::new(RpcErrorCode::InternalError, "cancelled"));
    }
    match method {
        "health.ping" => Ok(json!({ "ok": true, "deviceId": ctx.device_id })),
        "fs.list_directories" => fs_browse::handle_list_directories(params, &ctx).await,
        "fs.list" => fs_browse::handle_list_files(params, &ctx).await,
        "fs.stat" => fs_browse::handle_stat(params, &ctx).await,
        "fs.read" => fs_read::handle_read(params, &ctx).await,
        "fs.read_stream" => fs_read::handle_read_stream(params, &ctx).await,
        "fs.write" => fs_write::handle_write(params, &ctx).await,
        "fs.edit" => fs_mutate::handle_edit(params, &ctx).await,
        "fs.mkdir" => fs_mutate::handle_mkdir(params, &ctx).await,
        "fs.delete" => fs_mutate::handle_delete(params, &ctx).await,
        "fs.apply_patch" => patch::handle_apply_patch(params, &ctx).await,
        "search.glob" => search::handle_glob(params, &ctx).await,
        "search.grep" => search::handle_grep(params, &ctx).await,
        "git.status" => git::handle_git_status(params, &ctx).await,
        "git.worktree" => git::handle_git_worktree(params, &ctx).await,
        "exec.command" => proc::handle_exec_command(params, &ctx).await,
        "exec.manage_task" => proc::handle_manage_task(params, &ctx).await,
        "pty.open" => proc::handle_pty_open(params, &ctx).await,
        "pty.resize" => proc::handle_pty_resize(params, &ctx).await,
        "pty.close" => proc::handle_pty_close(params, &ctx).await,
        "sync.scan" => sync::handle_sync_scan(params, &ctx).await,
        "sync.pull_batch" => sync::handle_sync_pull_batch(params, &ctx).await,
        "sync.push_batch" => sync::handle_sync_push_batch(params, &ctx).await,
        other => Err(RpcCallError::new(RpcErrorCode::MethodNotFound, format!("unknown RPC method: {other}"))),
    }
}
