use std::fs::File;
use std::io::Read;

use bytes::Bytes;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::framing::{encode_batch_record, encode_stream_data, encode_stream_eof, BatchRecord};
use crate::ops::fs_common::{mtime_ms, open_read_nofollow, unix_mode};
use crate::ops::sync::{classify_sync_io_error, validate_sync_root, MAX_SYNC_FILE_BYTES};
use crate::ops::{OpContext, RpcCallError};
use crate::path_guard::{resolve_contained_details, ClientPlatform};

const SYNC_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Debug, Deserialize)]
struct PullBatchParams {
    root: String,
    paths: Vec<String>,
    #[serde(rename = "streamId")]
    stream_id: Option<u32>,
}

pub async fn handle_sync_pull_batch(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: PullBatchParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    let stream_id = input.stream_id.unwrap_or(ctx.stream_id);
    if stream_id == 0 {
        return Err(RpcCallError::invalid("streamId must be positive"));
    }
    let _ = validate_sync_root(ctx.platform, &input.root)?;
    let count = input.paths.len();
    let stream_cancel = ctx.register_stream(stream_id)?;
    let task_ctx = ctx.clone();

    tokio::spawn(async move {
        let mut response_rx = task_ctx.response_sent.clone();
        let ready = tokio::select! {
            _ = stream_cancel.cancelled() => false,
            _ = task_ctx.cancel.cancelled() => false,
            res = response_rx.wait_for(|sent| *sent) => res.is_ok(),
        };
        if ready {
            let (platform, root, paths) = (task_ctx.platform, input.root, input.paths);
            let (outbound_tx, cancel_a, cancel_b) =
                (task_ctx.outbound_tx.clone(), stream_cancel.clone(), task_ctx.cancel.clone());
            let _ = tokio::task::spawn_blocking(move || {
                for raw_path in paths {
                    if cancel_a.is_cancelled() || cancel_b.is_cancelled() { return; }
                    if !stream_one_pull_file(&root, &raw_path, platform, stream_id, &outbound_tx, &cancel_a, &cancel_b) {
                        return;
                    }
                }
                if !cancel_a.is_cancelled() && !cancel_b.is_cancelled() {
                    if let Ok(eof) = encode_stream_eof(stream_id, None) {
                        let _ = outbound_tx.blocking_send(eof);
                    }
                }
            })
            .await;
        }
        task_ctx.unregister_stream(stream_id);
    });

    Ok(json!({ "streamId": stream_id, "count": count }))
}

fn send_pull_error(
    stream_id: u32, path: &str, code: &str, message: &str, tx: &mpsc::Sender<Bytes>,
) -> bool {
    let mut header = Map::new();
    header.insert("path".into(), json!(path));
    header.insert("code".into(), json!(code));
    header.insert("error".into(), json!(message));
    header.insert("done".into(), json!(true));
    let Ok(encoded) = encode_batch_record(&BatchRecord { header, body: Bytes::new() }) else { return false };
    encode_stream_data(stream_id, encoded)
        .map(|frame| tx.blocking_send(frame).is_ok())
        .unwrap_or(false)
}

fn stream_one_pull_file(
    root: &str,
    raw_path: &str,
    platform: ClientPlatform,
    stream_id: u32,
    tx: &mpsc::Sender<Bytes>,
    cancel_a: &CancellationToken,
    cancel_b: &CancellationToken,
) -> bool {
    let contained = match resolve_contained_details(root, Some(raw_path), platform, false, false) {
        Ok(c) => c,
        Err(err) => {
            let r = RpcCallError::from(err);
            return send_pull_error(stream_id, raw_path, r.code.as_str(), &r.message, tx);
        }
    };
    let rel = contained.rel_path;
    let (mut file, _) = match open_read_nofollow(&contained.full_path) {
        Ok(pair) => pair,
        Err(err) => return send_pull_error(stream_id, &rel, err.code.as_str(), &err.message, tx),
    };
    // T6-M1: re-verify regular file & <= 64 MiB limit on the ALREADY-OPENED file handle before sending bytes.
    let meta = match file.metadata() {
        Ok(m) => m,
        Err(err) => return send_pull_error(stream_id, &rel, classify_sync_io_error(&err), &err.to_string(), tx),
    };
    if !meta.file_type().is_file() {
        let code = if meta.is_dir() { "EISDIR" } else { "EACCES" };
        return send_pull_error(stream_id, &rel, code, "target is not a regular file", tx);
    }
    if meta.len() > MAX_SYNC_FILE_BYTES {
        return send_pull_error(
            stream_id,
            &rel,
            "FILE_TOO_LARGE",
            &format!("file exceeds 64 MiB sync limit ({} bytes)", meta.len()),
            tx,
        );
    }
    let (modified, mode) = (mtime_ms(&meta), unix_mode(&meta));
    let (mut cur_buf, mut next_buf) = (vec![0u8; SYNC_CHUNK_BYTES], vec![0u8; SYNC_CHUNK_BYTES]);
    let mut cur_len = match read_chunk(&mut file, &mut cur_buf) {
        Ok(n) => n,
        Err(err) => return send_pull_error(stream_id, &rel, classify_sync_io_error(&err), &err.to_string(), tx),
    };
    if cur_len == 0 {
        return send_pull_chunk(stream_id, &rel, modified, mode, true, &[], tx);
    }
    let mut total_sent = 0u64;
    loop {
        if cancel_a.is_cancelled() || cancel_b.is_cancelled() { return false; }
        let next_len = match read_chunk(&mut file, &mut next_buf) {
            Ok(n) => n,
            Err(err) => return send_pull_error(stream_id, &rel, classify_sync_io_error(&err), &err.to_string(), tx),
        };
        total_sent = total_sent.saturating_add(cur_len as u64);
        if total_sent > MAX_SYNC_FILE_BYTES || total_sent.saturating_add(next_len as u64) > MAX_SYNC_FILE_BYTES {
            return send_pull_error(stream_id, &rel, "FILE_TOO_LARGE", "file grew beyond 64 MiB during transfer", tx);
        }
        let is_done = next_len == 0;
        if !send_pull_chunk(stream_id, &rel, modified, mode, is_done, &cur_buf[..cur_len], tx) {
            return false;
        }
        if is_done { return true; }
        std::mem::swap(&mut cur_buf, &mut next_buf);
        cur_len = next_len;
    }
}

fn send_pull_chunk(
    stream_id: u32, rel: &str, modified: u64, mode: u32, done: bool, data: &[u8],
    tx: &mpsc::Sender<Bytes>,
) -> bool {
    let mut header = Map::new();
    header.insert("path".into(), json!(rel));
    header.insert("mtimeMs".into(), json!(modified));
    header.insert("mode".into(), json!(mode));
    header.insert("done".into(), json!(done));
    let Ok(encoded) = encode_batch_record(&BatchRecord { header, body: Bytes::copy_from_slice(data) }) else {
        return false;
    };
    encode_stream_data(stream_id, encoded)
        .map(|frame| tx.blocking_send(frame).is_ok())
        .unwrap_or(false)
}

fn read_chunk(file: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut total = 0usize;
    while total < buf.len() {
        let n = file.read(&mut buf[total..])?;
        if n == 0 { break; }
        total += n;
    }
    Ok(total)
}
