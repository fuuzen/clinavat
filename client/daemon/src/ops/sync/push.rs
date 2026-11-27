use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use crate::framing::{
    encode_stream_cancel, encode_stream_eof, BatchRecord, BatchRecordDecoder,
};
use crate::ops::sync::{
    apply_sync_delete, apply_sync_mkdir, classify_sync_io_error, commit_sync_staged_file,
    hex_lower, validate_sync_root, MAX_SYNC_FILE_BYTES,
};
use crate::ops::{OpContext, RpcCallError, StreamInbound};
use crate::path_guard::{resolve_contained_details, ClientPlatform};

const MAX_PUSH_PENDING_BYTES: usize = 32 * 1024 * 1024;
const MAX_CONCURRENT_PUSH_PARTIALS: usize = 256;
const WORK_CHANNEL_CAPACITY: usize = 64;

#[derive(Debug, Deserialize)]
struct PushOperation {
    op: String,
    path: String,
    #[serde(rename = "mtimeMs")]
    mtime_ms: Option<u64>,
    mode: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct PushBatchParams {
    root: String,
    #[serde(default)]
    operations: Vec<PushOperation>,
    #[serde(rename = "streamId")]
    stream_id: Option<u32>,
}

struct PartialPushFile {
    temp_path: PathBuf,
    file: File,
    received: u64,
    mtime_ms: Option<u64>,
    mode: Option<u32>,
    hasher: Sha256,
}

impl Drop for PartialPushFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.temp_path);
    }
}

#[derive(Default)]
struct PushCollector {
    applied: Vec<String>,
    warnings: Vec<Value>,
    errors: Vec<Value>,
    stats: Map<String, Value>,
    failed_paths: HashSet<String>,
}

impl PushCollector {
    fn err(&mut self, path: &str, code: &str, msg: impl Into<String>) {
        self.failed_paths.insert(path.to_string());
        self.errors.push(json!({ "path": path, "code": code, "message": msg.into() }));
    }

    fn warn(&mut self, path: &str, code: &str, msg: impl Into<String>) {
        self.failed_paths.insert(path.to_string());
        self.warnings.push(json!({ "path": path, "code": code, "message": msg.into() }));
    }
}

/// RAII guard guaranteeing that any abnormal exit, cancel, or panic sends `STREAM_CANCEL` so Hub never hangs (`H2`).
struct PushStreamGuard {
    stream_id: u32,
    ctx: OpContext,
    finished: bool,
}

impl PushStreamGuard {
    fn new(stream_id: u32, ctx: OpContext) -> Self {
        Self { stream_id, ctx, finished: false }
    }

    fn mark_finished(&mut self) {
        self.finished = true;
    }
}

impl Drop for PushStreamGuard {
    fn drop(&mut self) {
        self.ctx.unregister_stream(self.stream_id);
        if !self.finished {
            if let Ok(frame) = encode_stream_cancel(self.stream_id, Some("push_batch aborted")) {
                if self.ctx.outbound_tx.try_send(frame.clone()).is_err() {
                    let tx = self.ctx.outbound_tx.clone();
                    if let Ok(handle) = tokio::runtime::Handle::try_current() {
                        handle.spawn(async move { let _ = tx.send(frame).await; });
                    }
                }
            }
        }
    }
}

pub async fn handle_sync_push_batch(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: PushBatchParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    let stream_id = input.stream_id.unwrap_or(ctx.stream_id);
    if stream_id == 0 {
        return Err(RpcCallError::invalid("streamId must be positive"));
    }
    let canonical_root = validate_sync_root(ctx.platform, &input.root)?;
    let (stream_cancel, mut inbound_rx, pending_bytes) =
        ctx.register_duplex_stream(stream_id, MAX_PUSH_PENDING_BYTES)?;
    let task_ctx = ctx.clone();

    tokio::spawn(async move {
        let mut guard = PushStreamGuard::new(stream_id, task_ctx.clone());
        let mut response_rx = task_ctx.response_sent.clone();
        let ready = tokio::select! {
            _ = stream_cancel.cancelled() => false,
            _ = task_ctx.cancel.cancelled() => false,
            res = response_rx.wait_for(|sent| *sent) => res.is_ok(),
        };
        if !ready { return; }

        let (work_tx, mut work_rx) = mpsc::channel::<StreamInbound>(WORK_CHANNEL_CAPACITY);
        let worker_ctx = task_ctx.clone();
        let root_str = input.root;
        let operations = input.operations;

        // Run all blocking filesystem I/O inside a dedicated blocking worker so Tokio workers never stall (`L8`).
        let worker = tokio::task::spawn_blocking(move || -> Result<Value, String> {
            run_push_worker(&root_str, &canonical_root, operations, &worker_ctx, &mut work_rx)
        });
        tokio::pin!(worker);

        let mut cancelled = false;
        let mut worker_outcome: Option<Result<Result<Value, String>, tokio::task::JoinError>> = None;
        loop {
            tokio::select! {
                _ = stream_cancel.cancelled() => { cancelled = true; break; }
                _ = task_ctx.cancel.cancelled() => { cancelled = true; break; }
                res = &mut worker => { worker_outcome = Some(res); break; }
                item = inbound_rx.recv() => match item {
                    Some(StreamInbound::Data(chunk)) => {
                        let len = chunk.len();
                        let sent = tokio::select! {
                            _ = stream_cancel.cancelled() => false,
                            _ = task_ctx.cancel.cancelled() => false,
                            r = work_tx.send(StreamInbound::Data(chunk)) => r.is_ok(),
                        };
                        pending_bytes.fetch_sub(len, Ordering::Relaxed);
                        if !sent { break; }
                    }
                    Some(StreamInbound::Eof(meta)) => {
                        let _ = work_tx.send(StreamInbound::Eof(meta)).await;
                        break;
                    }
                    None => { cancelled = true; break; }
                }
            }
        }
        drop(work_tx);
        if cancelled {
            if worker_outcome.is_none() { let _ = worker.await; }
            return; // PushStreamGuard::drop sends STREAM_CANCEL to Hub immediately.
        }
        let outcome = match worker_outcome {
            Some(res) => res,
            None => worker.await,
        };
        match outcome {
            Ok(Ok(meta)) => {
                if let Ok(eof) = encode_stream_eof(stream_id, Some(&meta)) {
                    if task_ctx.outbound_tx.send(eof).await.is_ok() {
                        guard.mark_finished();
                    }
                }
            }
            Ok(Err(reason)) => {
                if let Ok(frame) = encode_stream_cancel(stream_id, Some(&reason)) {
                    let _ = task_ctx.outbound_tx.send(frame).await;
                    guard.mark_finished();
                }
            }
            Err(_) => {} // Worker panicked; PushStreamGuard::drop sends STREAM_CANCEL.
        }
    });

    Ok(json!({ "streamId": stream_id }))
}

fn run_push_worker(
    root: &str,
    canonical_root: &Path,
    operations: Vec<PushOperation>,
    ctx: &OpContext,
    work_rx: &mut mpsc::Receiver<StreamInbound>,
) -> Result<Value, String> {
    let mut col = PushCollector::default();
    let mut declared_writes: HashMap<String, (Option<u64>, Option<u32>)> = HashMap::new();
    let mut deletes: Vec<String> = Vec::new();
    for op in operations {
        match op.op.as_str() {
            "mkdir" => match apply_sync_mkdir(root, &op.path, ctx.platform) {
                Ok(rel) => col.applied.push(rel),
                Err((p, code, msg)) => col.err(&p, code, msg),
            },
            "write" => { declared_writes.insert(op.path, (op.mtime_ms, op.mode)); }
            "delete" => deletes.push(op.path),
            other => col.err(&op.path, "INVALID_ARGUMENT", format!("unknown push op: {other}")),
        }
    }
    let enforce_declared = !declared_writes.is_empty();
    let mut decoder = BatchRecordDecoder::default();
    let mut partials: HashMap<String, PartialPushFile> = HashMap::new();
    let mut saw_eof = false;

    while let Some(msg) = work_rx.blocking_recv() {
        match msg {
            StreamInbound::Data(chunk) => {
                let recs = decoder.push(&chunk).map_err(|e| e.to_string())?;
                for rec in recs {
                    process_push_record(
                        root, canonical_root, ctx.platform, ctx,
                        enforce_declared, &declared_writes, rec, &mut partials, &mut col,
                    );
                }
            }
            StreamInbound::Eof(_) => {
                saw_eof = true;
                break;
            }
        }
    }
    for (rel, partial) in partials.drain() {
        drop(partial);
        col.warn(&rel, "INCOMPLETE", "file transfer ended before done=true");
    }
    if !saw_eof {
        return Err("push_batch cancelled before EOF".into());
    }
    for rel in &deletes {
        match apply_sync_delete(root, rel, ctx.platform) {
            Ok(Some(deleted)) => col.applied.push(deleted),
            Ok(None) => {}
            Err((p, code, msg)) => col.err(&p, code, msg),
        }
    }
    Ok(json!({
        "applied": col.applied,
        "warnings": col.warnings,
        "errors": col.errors,
        "stats": col.stats,
    }))
}

#[allow(clippy::too_many_arguments)]
fn process_push_record(
    root: &str,
    canonical_root: &Path,
    platform: ClientPlatform,
    ctx: &OpContext,
    enforce_declared: bool,
    declared: &HashMap<String, (Option<u64>, Option<u32>)>,
    rec: BatchRecord,
    partials: &mut HashMap<String, PartialPushFile>,
    col: &mut PushCollector,
) {
    let raw_path = rec.header.get("path").and_then(Value::as_str).unwrap_or("").to_string();
    if col.failed_paths.contains(&raw_path) { return; }
    let contained = match resolve_contained_details(root, Some(&raw_path), platform, false, true) {
        Ok(c) => c,
        Err(err) => {
            let r = RpcCallError::from(err);
            col.err(&raw_path, r.code.as_str(), r.message);
            return;
        }
    };
    let rel = contained.rel_path;
    if col.failed_paths.contains(&rel) { return; }
    if enforce_declared && !declared.contains_key(&rel) {
        col.err(&rel, "EACCES", "write path was not declared in push operations");
        return;
    }
    let done = rec.header.get("done").and_then(Value::as_bool).unwrap_or(true);
    let rec_mtime = rec.header.get("mtimeMs").and_then(Value::as_u64)
        .or_else(|| declared.get(&rel).and_then(|(m, _)| *m));
    let rec_mode = rec.header.get("mode").and_then(Value::as_u64).map(|m| m as u32)
        .or_else(|| declared.get(&rel).and_then(|(_, md)| *md));

    if !partials.contains_key(&rel) {
        if partials.len() >= MAX_CONCURRENT_PUSH_PARTIALS {
            col.err(&rel, "CONFLICT", "too many concurrent partial push files");
            return;
        }
        let (temp_path, file) = match ctx.state.staging.create_staged_file() {
            Ok(pair) => pair,
            Err(err) => { col.err(&rel, err.code.as_str(), err.message); return; }
        };
        partials.insert(rel.clone(), PartialPushFile {
            temp_path, file, received: 0, mtime_ms: rec_mtime, mode: rec_mode, hasher: Sha256::new(),
        });
    }
    let Some(state) = partials.get_mut(&rel) else { return };
    let next_total = state.received.saturating_add(rec.body.len() as u64);
    if next_total > MAX_SYNC_FILE_BYTES {
        partials.remove(&rel);
        col.err(&rel, "FILE_TOO_LARGE", "pushed file exceeds 64 MiB sync limit");
        return;
    }
    if !rec.body.is_empty() {
        if let Err(err) = state.file.write_all(&rec.body) {
            partials.remove(&rel);
            col.err(&rel, classify_sync_io_error(&err), err.to_string());
            return;
        }
        state.hasher.update(&rec.body);
        state.received = next_total;
    }
    if done {
        if let Some(mut finished) = partials.remove(&rel) {
            let sha = hex_lower(&finished.hasher.clone().finalize());
            match commit_sync_staged_file(
                canonical_root, &rel, &contained.full_path, &mut finished.file,
                finished.mtime_ms, finished.mode, sha, platform,
            ) {
                Ok(stat) => {
                    col.applied.push(rel.clone());
                    col.stats.insert(rel, stat);
                }
                Err((code, msg)) => col.err(&rel, code, msg),
            }
        }
    }
}
