use std::io::{Read, Seek, SeekFrom};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use bytes::Bytes;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::framing::{encode_stream_cancel, encode_stream_data, encode_stream_eof};
use crate::ops::fs_common::{file_tag, mtime_ms, open_read_nofollow};
use crate::ops::{OpContext, RpcCallError, RpcErrorCode, SAFE_RPC_RESPONSE_BYTES};
use crate::path_guard::resolve_contained_path;

const DEFAULT_READ_BYTES: usize = 1024 * 1024;
const MAX_READ_BYTES: usize = 2 * 1024 * 1024;
const MAX_LINE_MODE_BYTES: usize = 1024 * 1024;
const MAX_LINE_READ_SCAN_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_STREAM_CHUNK: usize = 64 * 1024;
const MIN_STREAM_CHUNK: usize = 4 * 1024;
const MAX_STREAM_CHUNK: usize = 512 * 1024;

#[derive(Debug, Deserialize)]
struct ReadParams {
    root: String,
    path: String,
    offset: Option<u64>,
    #[serde(rename = "byteOffset")]
    byte_offset: Option<u64>,
    #[serde(rename = "maxBytes")]
    max_bytes: Option<usize>,
    #[serde(rename = "startLine")]
    start_line: Option<usize>,
    #[serde(rename = "endLine")]
    end_line: Option<usize>,
}

pub async fn handle_read(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: ReadParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    let platform = ctx.platform;
    let max_bytes = input.max_bytes.unwrap_or(DEFAULT_READ_BYTES).clamp(1, MAX_READ_BYTES);
    let cancel = ctx.cancel.clone();

    tokio::task::spawn_blocking(move || -> Result<Value, RpcCallError> {
        if cancel.is_cancelled() {
            return Err(RpcCallError::new(RpcErrorCode::InternalError, "cancelled"));
        }
        let resolved = resolve_contained_path(&input.root, Some(&input.path), platform, false, false)?;
        let (mut file, meta) = open_read_nofollow(&resolved)?;
        let file_size = meta.len();
        let modified = mtime_ms(&meta);
        let tag = file_tag(file_size, modified);

        if input.start_line.is_some() || input.end_line.is_some() {
            return read_lines_slice(
                &mut file, file_size, modified, tag, input.start_line, input.end_line,
                max_bytes.min(MAX_LINE_MODE_BYTES),
            );
        }

        let offset = input.byte_offset.or(input.offset).unwrap_or(0);
        let mut buf = Vec::new();
        if offset < file_size {
            file.seek(SeekFrom::Start(offset))?;
            let to_read = ((file_size - offset) as usize).min(max_bytes);
            buf.resize(to_read, 0);
            let n = read_full_up_to(&mut file, &mut buf)?;
            buf.truncate(n);
        }
        let is_binary = buf.contains(&0);
        let truncated = offset.saturating_add(buf.len() as u64) < file_size;
        Ok(json!({
            "contentBase64": BASE64_STANDARD.encode(&buf),
            "size": file_size,
            "mtimeMs": modified,
            "tag": tag,
            "isBinary": is_binary,
            "encoding": if is_binary { "binary" } else { "utf-8" },
            "bytesRead": buf.len(),
            "truncated": truncated,
        }))
    })
    .await
    .map_err(|e| RpcCallError::new(RpcErrorCode::InternalError, format!("read task failed: {e}")))?
}

fn read_lines_slice(
    file: &mut std::fs::File,
    file_size: u64,
    modified: u64,
    tag: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
    max_bytes: usize,
) -> Result<Value, RpcCallError> {
    let scan_limit = (file_size as usize).min(MAX_LINE_READ_SCAN_BYTES);
    let mut raw = vec![0u8; scan_limit];
    let n = read_full_up_to(file, &mut raw)?;
    raw.truncate(n);
    if raw.contains(&0) {
        return Ok(json!({
            "contentBase64": "",
            "size": file_size,
            "mtimeMs": modified,
            "tag": tag,
            "isBinary": true,
            "encoding": "binary",
            "truncated": true,
        }));
    }
    let text = String::from_utf8_lossy(&raw);
    let trimmed = text.strip_suffix('\n').unwrap_or(&text);
    let all_lines: Vec<&str> = if raw.is_empty() { Vec::new() } else { trimmed.split('\n').collect() };
    let total_lines = all_lines.len();
    let start = start_line.unwrap_or(1).max(1);
    let end = end_line.unwrap_or(total_lines.max(start)).max(start);
    let mut selected = String::new();
    let mut clipped = (n as u64) < file_size;
    let mut last_line = start.saturating_sub(1);
    // Account for both `content` (JSON-escaped) and `contentBase64` (~1.34x) staying below SAFE_RPC_RESPONSE_BYTES.
    let mut est_json_bytes = 256usize;
    for (idx, line) in all_lines.iter().enumerate() {
        let line_no = idx + 1;
        if line_no < start { continue; }
        if line_no > end {
            clipped = true;
            break;
        }
        let piece = line.strip_suffix('\r').unwrap_or(line);
        let extra_raw = if selected.is_empty() { piece.len() } else { piece.len() + 1 };
        let piece_json = serde_json::to_string(piece).map(|s| s.len()).unwrap_or(piece.len() * 2);
        let extra_json = piece_json.saturating_add((extra_raw * 4) / 3 + 4);
        if !selected.is_empty()
            && (selected.len() + extra_raw > max_bytes || est_json_bytes + extra_json > SAFE_RPC_RESPONSE_BYTES)
        {
            clipped = true;
            break;
        }
        if selected.is_empty() && est_json_bytes + extra_json > SAFE_RPC_RESPONSE_BYTES {
            let cap = (SAFE_RPC_RESPONSE_BYTES / 4).min(max_bytes);
            let mut end_idx = piece.len().min(cap);
            while !piece.is_char_boundary(end_idx) { end_idx -= 1; }
            selected.push_str(&piece[..end_idx]);
            last_line = line_no;
            clipped = true;
            break;
        }
        if !selected.is_empty() { selected.push('\n'); }
        selected.push_str(piece);
        est_json_bytes += extra_json;
        last_line = line_no;
    }
    let bytes = selected.as_bytes();
    Ok(json!({
        "contentBase64": BASE64_STANDARD.encode(bytes),
        "content": selected,
        "size": file_size,
        "mtimeMs": modified,
        "tag": tag,
        "isBinary": false,
        "encoding": "utf-8",
        "startLine": start,
        "endLine": last_line,
        "totalLines": total_lines,
        "bytesRead": bytes.len(),
        "truncated": clipped,
    }))
}

#[derive(Debug, Deserialize)]
struct ReadStreamParams {
    root: String,
    path: String,
    offset: Option<u64>,
    length: Option<u64>,
    #[serde(rename = "chunkSize")]
    chunk_size: Option<usize>,
    #[serde(rename = "streamId")]
    stream_id: Option<u32>,
}

pub async fn handle_read_stream(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: ReadStreamParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    let stream_id = input.stream_id.unwrap_or(ctx.stream_id);
    if stream_id == 0 {
        return Err(RpcCallError::invalid("streamId must be positive"));
    }
    let platform = ctx.platform;
    let root = input.root;
    let rel = input.path;
    let (std_file, file_size, modified) = tokio::task::spawn_blocking(move || -> Result<(std::fs::File, u64, u64), RpcCallError> {
        let resolved = resolve_contained_path(&root, Some(&rel), platform, false, false)?;
        let (file, meta) = open_read_nofollow(&resolved)?;
        Ok((file, meta.len(), mtime_ms(&meta)))
    })
    .await
    .map_err(|e| RpcCallError::new(RpcErrorCode::InternalError, format!("read_stream open task failed: {e}")))??;

    let offset = input.offset.unwrap_or(0);
    let remaining = file_size.saturating_sub(offset);
    let to_read = input.length.map_or(remaining, |len| len.min(remaining));
    let chunk_size = input.chunk_size.unwrap_or(DEFAULT_STREAM_CHUNK).clamp(MIN_STREAM_CHUNK, MAX_STREAM_CHUNK);

    let stream_cancel = ctx.register_stream(stream_id)?;
    let task_ctx = ctx.clone();

    tokio::spawn(async move {
        let mut response_rx = task_ctx.response_sent.clone();
        // Wait until the RPC response frame has been enqueued so STREAM_DATA never races ahead of openStream.
        let ready = tokio::select! {
            _ = stream_cancel.cancelled() => false,
            _ = task_ctx.cancel.cancelled() => false,
            res = response_rx.wait_for(|sent| *sent) => res.is_ok(),
        };
        if ready {
            let mut file = tokio::fs::File::from_std(std_file);
            let mut sent: u64 = 0;
            let mut failed: Option<String> = None;
            if offset > 0 {
                if let Err(err) = file.seek(SeekFrom::Start(offset)).await {
                    failed = Some(err.to_string());
                }
            }
            let mut buf = vec![0u8; chunk_size];
            while failed.is_none() && sent < to_read {
                if stream_cancel.is_cancelled() || task_ctx.cancel.is_cancelled() { break; }
                let want = ((to_read - sent) as usize).min(buf.len());
                let read_res = tokio::select! {
                    _ = stream_cancel.cancelled() => break,
                    _ = task_ctx.cancel.cancelled() => break,
                    r = file.read(&mut buf[..want]) => r,
                };
                match read_res {
                    Ok(0) => break,
                    Ok(n) => {
                        sent += n as u64;
                        let Ok(frame) = encode_stream_data(stream_id, Bytes::copy_from_slice(&buf[..n])) else {
                            failed = Some("failed to encode stream data frame".into());
                            break;
                        };
                        let send_ok = tokio::select! {
                            _ = stream_cancel.cancelled() => false,
                            _ = task_ctx.cancel.cancelled() => false,
                            r = task_ctx.outbound_tx.send(frame) => r.is_ok(),
                        };
                        if !send_ok { break; }
                    }
                    Err(err) => {
                        failed = Some(err.to_string());
                        break;
                    }
                }
            }
            if !stream_cancel.is_cancelled() && !task_ctx.cancel.is_cancelled() {
                if let Some(reason) = failed {
                    if let Ok(cancel_frame) = encode_stream_cancel(stream_id, Some(&reason)) {
                        let _ = task_ctx.outbound_tx.send(cancel_frame).await;
                    }
                } else if let Ok(eof_frame) = encode_stream_eof(
                    stream_id,
                    Some(&json!({ "bytesSent": sent, "size": file_size })),
                ) {
                    let _ = task_ctx.outbound_tx.send(eof_frame).await;
                }
            }
        }
        task_ctx.unregister_stream(stream_id);
    });

    Ok(json!({
        "streamId": stream_id,
        "size": file_size,
        "mtimeMs": modified,
        "offset": offset,
        "length": to_read,
    }))
}

fn read_full_up_to(file: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut total = 0usize;
    while total < buf.len() {
        let n = file.read(&mut buf[total..])?;
        if n == 0 { break; }
        total += n;
    }
    Ok(total)
}
