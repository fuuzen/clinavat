use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::ops::fs_common::now_ms;
use crate::ops::proc::process_tree::{ProcessTree, RunningProcessGuard};
use crate::ops::proc::task_store::{BoundedOutput, ManagedTask, TaskCompletion, TaskStatus};
use crate::ops::proc::{extract_exit_info, resolve_exec_cwd, validate_env};
use crate::ops::{OpContext, RpcCallError, RpcErrorCode};
use crate::path_guard::ClientPlatform;

const MAX_COMMAND_BYTES: usize = 64 * 1024;
const MAX_INPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
struct ExecCommandParams {
    cwd: String,
    root: Option<String>,
    command: String,
    shell: Option<String>,
    env: Option<HashMap<String, String>>,
    background: Option<bool>,
    #[serde(alias = "isDaemon")]
    daemon: Option<bool>,
    #[serde(rename = "waitMs", alias = "waitMsBeforeAsync")]
    wait_ms: Option<u64>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    #[serde(rename = "taskId")]
    task_id: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

pub async fn handle_exec_command(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: ExecCommandParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    if input.command.trim().is_empty() || input.command.len() > MAX_COMMAND_BYTES || input.command.contains('\0') {
        return Err(RpcCallError::invalid("command is empty, too large, or contains NUL bytes"));
    }
    let extra_env = validate_env(input.env.as_ref())?;
    let cwd = resolve_exec_cwd(ctx.platform, input.root.as_deref(), &input.cwd)?;

    let session_id = input.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let is_daemon = input.daemon.unwrap_or(false);
    let is_bg_flag = input.background.unwrap_or(false);
    let immediate_bg = is_daemon || is_bg_flag;
    let can_promote = immediate_bg || (session_id.is_some() && input.wait_ms.is_some() && input.background != Some(false));

    // Pre-validate and reserve custom `taskId` before spawning so duplicate IDs never execute (`L2`).
    let mut task_reservation = if can_promote && session_id.is_some() {
        match input.task_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(custom) if custom.len() <= 128 && !custom.contains('\0') => {
                Some(ctx.state.tasks.reserve(custom.to_string())?)
            }
            Some(_) => return Err(RpcCallError::invalid("invalid taskId")),
            None => None,
        }
    } else {
        None
    };

    let mut cmd = build_shell_command(ctx.platform, input.shell.as_deref(), &input.command)?;
    ProcessTree::configure_command(&mut cmd);
    cmd.current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if can_promote { Stdio::piped() } else { Stdio::null() })
        .kill_on_drop(true);
    for (k, v) in &extra_env { cmd.env(k, v); }

    let mut child = cmd.spawn()?;
    let stdout_buf = Arc::new(Mutex::new(BoundedOutput::default()));
    let stderr_buf = Arc::new(Mutex::new(BoundedOutput::default()));
    let out_task = child.stdout.take().map(|r| tokio::spawn(drain_pipe(r, Arc::clone(&stdout_buf))));
    let err_task = child.stderr.take().map(|r| tokio::spawn(drain_pipe(r, Arc::clone(&stderr_buf))));
    let stdin_tx = child.stdin.take().map(|mut stdin| {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(32);
        tokio::spawn(async move {
            while let Some(chunk) = rx.recv().await {
                if stdin.write_all(&chunk).await.is_err() { break; }
                let _ = stdin.flush().await;
            }
        });
        tx
    });

    let tree = ProcessTree::from_child(child);
    let mut guard = RunningProcessGuard::new(Arc::clone(&tree));

    let wait_limit = if immediate_bg {
        Some(Duration::from_millis(input.wait_ms.unwrap_or(0)))
    } else {
        input.wait_ms.or(input.timeout_ms).map(Duration::from_millis)
    };

    if let Some(limit) = wait_limit {
        tokio::select! {
            status_res = tree.wait() => {
                guard.disarm();
                drop(stdin_tx);
                join_drains(out_task, err_task).await;
                return Ok(build_exit_result(&status_res?, &stdout_buf, &stderr_buf));
            }
            _ = tokio::time::sleep(limit) => {
                // Without a sessionId (and not explicitly background/daemon), foreground timeout kills & errors (`L1`).
                if !immediate_bg && (session_id.is_none() || input.background == Some(false)) {
                    tree.terminate();
                    let _ = tokio::time::timeout(Duration::from_millis(600), tree.wait()).await;
                    guard.disarm();
                    drop(stdin_tx);
                    join_drains(out_task, err_task).await;
                    let (stdout, stderr) = snapshot_streams(&stdout_buf, &stderr_buf);
                    let mut err = RpcCallError::new(
                        RpcErrorCode::RpcTimeout,
                        format!("command timed out after {} ms", limit.as_millis()),
                    );
                    err.data = Some(json!({ "timedOut": true, "stdout": stdout, "stderr": stderr }));
                    return Err(err);
                }

                // Detached background without sessionId (e.g. exec-barrier background): run without occupying session slots.
                let Some(owner_session) = session_id else {
                    guard.disarm();
                    drop(stdin_tx);
                    let wait_tree = Arc::clone(&tree);
                    tokio::spawn(async move {
                        let _ = wait_tree.wait().await;
                        join_drains(out_task, err_task).await;
                    });
                    let (stdout, stderr) = snapshot_streams(&stdout_buf, &stderr_buf);
                    return Ok(json!({ "exitCode": 0, "stdout": stdout, "stderr": stderr }));
                };

                let task_id = match task_reservation.as_ref() {
                    Some(res) => res.task_id().to_string(),
                    None => generate_task_id(),
                };
                let task = Arc::new(ManagedTask {
                    task_id: task_id.clone(),
                    session_id: owner_session,
                    command: input.command,
                    cwd,
                    started_at: now_ms(),
                    tree: Arc::clone(&tree),
                    stdout: Arc::clone(&stdout_buf),
                    stderr: Arc::clone(&stderr_buf),
                    stdin_tx: Mutex::new(stdin_tx),
                    completion: Mutex::new(TaskCompletion {
                        status: TaskStatus::Running, exit_code: None, signal: None, finished_at: None,
                    }),
                });
                ctx.state.tasks.insert(Arc::clone(&task), task_reservation.as_mut())?;
                guard.disarm();
                tokio::spawn(async move {
                    let status = task.tree.wait().await.ok();
                    join_drains(out_task, err_task).await;
                    let (code, sig) = status.as_ref().map(extract_exit_info).unwrap_or((1, None));
                    task.mark_exited(code, sig);
                });
                let (stdout, stderr) = snapshot_streams(&stdout_buf, &stderr_buf);
                let mut resp = json!({
                    "exitCode": 0, "stdout": stdout, "stderr": stderr, "backgroundTaskId": task_id,
                });
                if !immediate_bg { resp["timedOut"] = json!(true); }
                return Ok(resp);
            }
        }
    }

    let status = tree.wait().await?;
    guard.disarm();
    drop(stdin_tx);
    join_drains(out_task, err_task).await;
    Ok(build_exit_result(&status, &stdout_buf, &stderr_buf))
}

#[derive(Debug, Deserialize)]
struct ManageTaskParams {
    #[serde(rename = "sessionId")]
    session_id: String,
    action: String,
    #[serde(rename = "taskId")]
    task_id: Option<String>,
    input: Option<String>,
}

pub async fn handle_manage_task(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let req: ManageTaskParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    if req.session_id.trim().is_empty() {
        return Err(RpcCallError::invalid("sessionId is required"));
    }
    match req.action.as_str() {
        "list" => Ok(json!({ "tasks": ctx.state.tasks.list_for_session(&req.session_id) })),
        "status" => {
            let tid = require_task_id(req.task_id.as_deref())?;
            Ok(ctx.state.tasks.get_for_session(&req.session_id, tid)?.detail_json())
        }
        "send_input" => {
            let tid = require_task_id(req.task_id.as_deref())?;
            let payload = req.input.ok_or_else(|| RpcCallError::invalid("send_input requires input"))?;
            if payload.len() > MAX_INPUT_BYTES {
                return Err(RpcCallError::invalid("input exceeds 64 KiB limit"));
            }
            let task = ctx.state.tasks.get_for_session(&req.session_id, tid)?;
            let tx = task.stdin_tx.lock().ok().and_then(|g| g.clone())
                .ok_or_else(|| RpcCallError::new(RpcErrorCode::Conflict, "task stdin is closed or task has exited"))?;
            let bytes = payload.into_bytes();
            let written = bytes.len();
            tx.send(bytes).await
                .map_err(|_| RpcCallError::new(RpcErrorCode::Conflict, "task is no longer accepting input"))?;
            Ok(json!({ "ok": true, "taskId": tid, "bytesWritten": written }))
        }
        "kill" => {
            let tid = require_task_id(req.task_id.as_deref())?;
            let task = ctx.state.tasks.get_for_session(&req.session_id, tid)?;
            task.mark_killed();
            let mut detail = task.detail_json();
            detail["ok"] = json!(true);
            Ok(detail)
        }
        other => Err(RpcCallError::invalid(format!("unsupported manage_task action: {other}"))),
    }
}

fn require_task_id(raw: Option<&str>) -> Result<&str, RpcCallError> {
    raw.map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| RpcCallError::invalid("taskId is required"))
}

fn build_shell_command(platform: ClientPlatform, shell: Option<&str>, command: &str) -> Result<Command, RpcCallError> {
    if let Some(raw_shell) = shell.map(str::trim).filter(|s| !s.is_empty()) {
        if raw_shell.contains(['\0', '\r', '\n']) {
            return Err(RpcCallError::invalid("invalid shell executable"));
        }
        let lower = raw_shell.to_ascii_lowercase();
        let mut c = Command::new(raw_shell);
        if lower == "cmd" || lower == "cmd.exe" || lower.ends_with("\\cmd.exe") {
            c.args(["/C", command]);
        } else if matches!(lower.as_str(), "pwsh" | "pwsh.exe" | "powershell" | "powershell.exe")
            || lower.ends_with("\\pwsh.exe")
            || lower.ends_with("\\powershell.exe")
        {
            c.args(["-NoLogo", "-NoProfile", "-Command", command]);
        } else {
            c.args(["-c", command]);
        }
        return Ok(c);
    }
    if platform == ClientPlatform::Windows {
        let comspec = std::env::var("COMSPEC").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "cmd.exe".into());
        let mut c = Command::new(comspec);
        c.args(["/C", command]);
        return Ok(c);
    }
    let mut c = Command::new(if std::path::Path::new("/bin/bash").exists() { "/bin/bash" } else { "/bin/sh" });
    c.args(["-c", command]);
    Ok(c)
}

async fn drain_pipe<R: AsyncRead + Unpin>(mut reader: R, target: Arc<Mutex<BoundedOutput>>) {
    let mut chunk = [0u8; 8192];
    while let Ok(n) = reader.read(&mut chunk).await {
        if n == 0 { break; }
        if let Ok(mut guard) = target.lock() { guard.push(&chunk[..n]); }
    }
}

async fn join_drains(
    out_task: Option<tokio::task::JoinHandle<()>>,
    err_task: Option<tokio::task::JoinHandle<()>>,
) {
    if let Some(t) = out_task { let _ = tokio::time::timeout(Duration::from_secs(2), t).await; }
    if let Some(t) = err_task { let _ = tokio::time::timeout(Duration::from_secs(2), t).await; }
}

fn snapshot_streams(out: &Arc<Mutex<BoundedOutput>>, err: &Arc<Mutex<BoundedOutput>>) -> (String, String) {
    (
        out.lock().map(|g| g.to_lossy_string()).unwrap_or_default(),
        err.lock().map(|g| g.to_lossy_string()).unwrap_or_default(),
    )
}

fn build_exit_result(
    status: &std::process::ExitStatus,
    stdout_buf: &Arc<Mutex<BoundedOutput>>,
    stderr_buf: &Arc<Mutex<BoundedOutput>>,
) -> Value {
    let (code, sig) = extract_exit_info(status);
    let (stdout, stderr) = snapshot_streams(stdout_buf, stderr_buf);
    let mut obj = json!({ "exitCode": code, "stdout": stdout, "stderr": stderr });
    if let Some(s) = sig { obj["signal"] = json!(s); }
    obj
}

fn generate_task_id() -> String {
    let mut raw = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut raw);
    let mut out = String::with_capacity(21);
    out.push_str("task-");
    for b in raw { use std::fmt::Write; let _ = write!(&mut out, "{b:02x}"); }
    out
}
