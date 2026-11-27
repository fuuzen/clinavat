use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::framing::{encode_stream_data, encode_stream_eof};
use crate::ops::proc::{resolve_exec_cwd, validate_env};
use crate::ops::{OpContext, RpcCallError, RpcErrorCode, StreamInbound};
use crate::path_guard::ClientPlatform;

const MAX_ACTIVE_PTYS: usize = 32;
const MAX_PTY_INBOUND_PENDING_BYTES: usize = 4 * 1024 * 1024;
const PTY_READ_CHUNK_BYTES: usize = 32 * 1024;

struct PtySession {
    stream_id: u32,
    pid: Option<u32>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    stdin_tx: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    cancel: CancellationToken,
    reaped: AtomicBool,
    terminated: AtomicBool,
}

impl PtySession {
    fn resize(&self, cols: u16, rows: u16) -> Result<(), RpcCallError> {
        let guard = self.master.lock()
            .map_err(|_| RpcCallError::new(RpcErrorCode::InternalError, "pty master lock poisoned"))?;
        let Some(master) = guard.as_ref() else {
            return Err(RpcCallError::new(RpcErrorCode::Conflict, "PTY session is already closed"));
        };
        master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| RpcCallError::new(RpcErrorCode::InternalError, format!("pty resize failed: {e}")))
    }

    fn send_stdin(&self) -> Option<mpsc::Sender<Vec<u8>>> {
        self.stdin_tx.lock().ok().and_then(|g| g.clone())
    }

    /// Drops writer channel, killer, and `MasterPty` so ConPTY `HPCON` closes and reader thread hits EOF (`H4`).
    fn release_handles(&self) {
        if let Ok(mut tx) = self.stdin_tx.lock() { drop(tx.take()); }
        if let Ok(mut killer) = self.killer.lock() { drop(killer.take()); }
        if let Ok(mut master) = self.master.lock() { drop(master.take()); }
    }

    fn mark_reaped_and_release(&self) {
        self.reaped.store(true, Ordering::SeqCst);
        self.release_handles();
    }

    fn terminate(&self) {
        self.cancel.cancel();
        if !self.terminated.swap(true, Ordering::SeqCst) && !self.reaped.load(Ordering::SeqCst) {
            if let Ok(mut guard) = self.killer.lock() {
                if let Some(killer) = guard.as_mut() { let _ = killer.kill(); }
            }
            #[cfg(unix)]
            if let Some(pid) = self.pid {
                let pgid = pid as i32;
                if pgid > 0 && !self.reaped.load(Ordering::SeqCst) {
                    unsafe { libc::killpg(pgid, libc::SIGTERM); }
                }
            }
            #[cfg(not(unix))]
            let _ = self.pid;
        }
        // Immediately release master/writer so Windows ConPTY & reader thread exit cleanly (`H4`).
        self.release_handles();
    }
}

#[derive(Default)]
pub struct PtyStore {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
}

impl PtyStore {
    pub fn new() -> Self { Self::default() }

    fn insert(&self, pty_id: String, session: Arc<PtySession>) -> Result<(), RpcCallError> {
        let mut guard = self.sessions.lock()
            .map_err(|_| RpcCallError::new(RpcErrorCode::InternalError, "pty store lock poisoned"))?;
        if guard.len() >= MAX_ACTIVE_PTYS {
            return Err(RpcCallError::new(RpcErrorCode::Conflict, "maximum active PTY sessions reached"));
        }
        guard.insert(pty_id, session);
        Ok(())
    }

    fn get(&self, pty_id: &str) -> Option<Arc<PtySession>> {
        self.sessions.lock().ok().and_then(|g| g.get(pty_id).cloned())
    }

    fn remove(&self, pty_id: &str, stream_id: Option<u32>) -> Option<Arc<PtySession>> {
        let mut guard = self.sessions.lock().ok()?;
        if let Some(session) = guard.remove(pty_id) { return Some(session); }
        if let Some(sid) = stream_id {
            let matched = guard.iter().find(|(_, s)| s.stream_id == sid).map(|(k, _)| k.clone());
            if let Some(k) = matched { return guard.remove(&k); }
        }
        None
    }

    pub fn cleanup_all(&self) {
        if let Ok(mut guard) = self.sessions.lock() {
            for (_, session) in guard.drain() { session.terminate(); }
        }
    }
}

impl Drop for PtyStore {
    fn drop(&mut self) { self.cleanup_all(); }
}

#[derive(Debug, Deserialize)]
struct PtyOpenParams {
    cwd: String,
    root: Option<String>,
    shell: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    env: Option<HashMap<String, String>>,
    #[serde(rename = "streamId")]
    stream_id: Option<u32>,
}

pub async fn handle_pty_open(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: PtyOpenParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    let stream_id = input.stream_id.unwrap_or(ctx.stream_id);
    if stream_id == 0 { return Err(RpcCallError::invalid("streamId must be positive")); }
    let cwd = resolve_exec_cwd(ctx.platform, input.root.as_deref(), &input.cwd)?;
    let extra_env = validate_env(input.env.as_ref())?;
    let cols = input.cols.unwrap_or(100).clamp(1, 500);
    let rows = input.rows.unwrap_or(30).clamp(1, 500);
    let shell = resolve_pty_shell(ctx.platform, input.shell.as_deref())?;

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| RpcCallError::new(RpcErrorCode::InternalError, format!("openpty failed: {e}")))?;

    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&cwd);
    if !extra_env.iter().any(|(k, _)| k.eq_ignore_ascii_case("TERM")) { cmd.env("TERM", "xterm-256color"); }
    if !extra_env.iter().any(|(k, _)| k.eq_ignore_ascii_case("COLORTERM")) { cmd.env("COLORTERM", "truecolor"); }
    for (k, v) in &extra_env { cmd.env(k, v); }

    let mut child = pair.slave.spawn_command(cmd)
        .map_err(|e| RpcCallError::new(RpcErrorCode::InternalError, format!("pty spawn failed: {e}")))?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader()
        .map_err(|e| RpcCallError::new(RpcErrorCode::InternalError, format!("pty reader failed: {e}")))?;
    let writer = pair.master.take_writer()
        .map_err(|e| RpcCallError::new(RpcErrorCode::InternalError, format!("pty writer failed: {e}")))?;
    let killer = child.clone_killer();
    let pid = child.process_id();
    let pty_id = generate_pty_id();

    let (stream_cancel, mut inbound_rx, pending_bytes) =
        ctx.register_duplex_stream(stream_id, MAX_PTY_INBOUND_PENDING_BYTES)?;
    let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(64);
    let session = Arc::new(PtySession {
        stream_id,
        pid,
        master: Mutex::new(Some(pair.master)),
        killer: Mutex::new(Some(killer)),
        stdin_tx: Mutex::new(Some(stdin_tx)),
        cancel: stream_cancel.clone(),
        reaped: AtomicBool::new(false),
        terminated: AtomicBool::new(false),
    });
    if let Err(err) = ctx.state.ptys.insert(pty_id.clone(), Arc::clone(&session)) {
        session.terminate();
        ctx.unregister_stream(stream_id);
        return Err(err);
    }

    // Dedicated writer thread: exits and drops PTY writer immediately when `release_handles()` drops `stdin_tx`.
    tokio::task::spawn_blocking(move || {
        let mut writer = writer;
        while let Some(chunk) = stdin_rx.blocking_recv() {
            if writer.write_all(&chunk).is_err() { break; }
            let _ = writer.flush();
        }
    });

    // Dedicated child waiter thread independent of stdout reader (`H4`): drops master/writer on exit so ConPTY hits EOF.
    let (exit_tx, exit_rx) = oneshot::channel::<u32>();
    let wait_session = Arc::clone(&session);
    tokio::task::spawn_blocking(move || {
        let exit_code = child.wait().map(|s| s.exit_code()).unwrap_or(0);
        wait_session.mark_reaped_and_release();
        let _ = exit_tx.send(exit_code);
    });

    // Async inbound stdin pump.
    let (in_session, in_cancel, rpc_cancel) = (Arc::clone(&session), stream_cancel.clone(), ctx.cancel.clone());
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = in_cancel.cancelled() => break,
                _ = rpc_cancel.cancelled() => break,
                maybe = inbound_rx.recv() => match maybe {
                    Some(StreamInbound::Data(bytes)) => {
                        pending_bytes.fetch_sub(bytes.len(), Ordering::Relaxed);
                        let Some(tx) = in_session.send_stdin() else { break };
                        if tx.send(bytes.to_vec()).await.is_err() { break; }
                    }
                    Some(StreamInbound::Eof(_)) | None => {
                        in_session.terminate();
                        break;
                    }
                }
            }
        }
    });

    // Async outbound coordinator: waits for RPC_RESPONSE, streams stdout, flushes tail on exit, sends STREAM_EOF.
    let (out_ctx, out_pty_id, out_session) = (ctx.clone(), pty_id.clone(), Arc::clone(&session));
    tokio::spawn(async move {
        let mut response_rx = out_ctx.response_sent.clone();
        let ready = tokio::select! {
            _ = stream_cancel.cancelled() => false,
            _ = out_ctx.cancel.cancelled() => false,
            res = response_rx.wait_for(|sent| *sent) => res.is_ok(),
        };
        if !ready {
            out_session.terminate();
            out_ctx.state.ptys.remove(&out_pty_id, Some(stream_id));
            out_ctx.unregister_stream(stream_id);
            return;
        }
        let (outbound_tx, cancel_a, cancel_b) =
            (out_ctx.outbound_tx.clone(), stream_cancel.clone(), out_ctx.cancel.clone());
        let reader_task = tokio::task::spawn_blocking(move || {
            let mut reader = reader;
            let mut buf = vec![0u8; PTY_READ_CHUNK_BYTES];
            while !cancel_a.is_cancelled() && !cancel_b.is_cancelled() {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(frame) = encode_stream_data(stream_id, Bytes::copy_from_slice(&buf[..n])) {
                            if outbound_tx.blocking_send(frame).is_err() { break; }
                        }
                    }
                }
            }
        });

        let exited_code = tokio::select! {
            res = exit_rx => res.ok(),
            _ = stream_cancel.cancelled() => None,
            _ = out_ctx.cancel.cancelled() => None,
        };
        if let Some(exit_code) = exited_code {
            let _ = tokio::time::timeout(Duration::from_millis(500), reader_task).await;
            if !stream_cancel.is_cancelled() && !out_ctx.cancel.is_cancelled() {
                if let Ok(eof) = encode_stream_eof(stream_id, Some(&json!({ "exitCode": exit_code }))) {
                    let _ = out_ctx.outbound_tx.send(eof).await;
                }
            }
        } else {
            out_session.terminate();
            let _ = tokio::time::timeout(Duration::from_millis(500), reader_task).await;
        }
        stream_cancel.cancel();
        out_ctx.state.ptys.remove(&out_pty_id, Some(stream_id));
        out_ctx.unregister_stream(stream_id);
    });

    Ok(json!({ "ptyId": pty_id, "streamId": stream_id }))
}

#[derive(Debug, Deserialize)]
struct PtyResizeParams {
    #[serde(rename = "ptyId")]
    pty_id: String,
    cols: u16,
    rows: u16,
}

pub async fn handle_pty_resize(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: PtyResizeParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    let Some(session) = ctx.state.ptys.get(&input.pty_id) else {
        return Err(RpcCallError::new(RpcErrorCode::Enoent, format!("PTY session not found: {}", input.pty_id)));
    };
    session.resize(input.cols.clamp(1, 500), input.rows.clamp(1, 500))?;
    Ok(json!({ "ok": true }))
}

#[derive(Debug, Deserialize)]
struct PtyCloseParams {
    #[serde(rename = "ptyId")]
    pty_id: String,
    #[serde(rename = "streamId")]
    stream_id: Option<u32>,
}

pub async fn handle_pty_close(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: PtyCloseParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    if let Some(session) = ctx.state.ptys.remove(&input.pty_id, input.stream_id) {
        session.terminate();
        ctx.unregister_stream(session.stream_id);
    } else if let Some(sid) = input.stream_id {
        ctx.unregister_stream(sid);
    }
    Ok(json!({ "ok": true }))
}

fn resolve_pty_shell(platform: ClientPlatform, requested: Option<&str>) -> Result<String, RpcCallError> {
    if let Some(raw) = requested.map(str::trim).filter(|s| !s.is_empty()) {
        if raw.contains(['\0', '\r', '\n']) { return Err(RpcCallError::invalid("invalid PTY shell")); }
        return Ok(raw.to_string());
    }
    if platform == ClientPlatform::Windows {
        return Ok(std::env::var("COMSPEC").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "powershell.exe".into()));
    }
    if let Ok(sh) = std::env::var("SHELL") {
        if !sh.trim().is_empty() && std::path::Path::new(&sh).exists() { return Ok(sh); }
    }
    Ok(if std::path::Path::new("/bin/bash").exists() { "/bin/bash" } else { "/bin/sh" }.into())
}

fn generate_pty_id() -> String {
    let mut raw = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut raw);
    let mut out = String::with_capacity(20);
    out.push_str("pty-");
    for b in raw { use std::fmt::Write; let _ = write!(&mut out, "{b:02x}"); }
    out
}
