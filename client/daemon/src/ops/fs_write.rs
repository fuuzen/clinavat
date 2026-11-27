use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::ops::fs_common::{
    atomic_replace_file, check_write_condition, create_temp_in_dir, ensure_dirs_contained,
    file_tag, now_ms, open_read_nofollow, unix_mode, WriteCondition,
};
use crate::ops::fs_staging::{discard_staged, StagedWrite, MAX_STAGED_FILE_BYTES};
use crate::ops::{OpContext, RpcCallError, RpcErrorCode};
use crate::path_guard::{
    is_symlink_or_reparse, resolve_contained_details, verify_canonical_within, ClientPlatform,
};

#[derive(Debug, Deserialize)]
struct WriteParams {
    root: String,
    path: String,
    #[serde(rename = "contentBase64")]
    content_base64: String,
    offset: Option<u64>,
    #[serde(rename = "totalSize")]
    total_size: Option<u64>,
    condition: Option<WriteCondition>,
    #[serde(rename = "expectedTag")]
    expected_tag: Option<String>,
    #[serde(rename = "createOnly")]
    create_only: Option<bool>,
    #[serde(rename = "createDirs")]
    create_dirs: Option<bool>,
    commit: Option<bool>,
    append: Option<bool>,
}

impl WriteParams {
    fn merged_condition(&self) -> WriteCondition {
        let mut cond = self.condition.clone().unwrap_or_default();
        if self.create_only.unwrap_or(false) { cond.create_only = true; }
        if self.expected_tag.is_some() { cond.expected_tag = self.expected_tag.clone(); }
        cond
    }
}

pub async fn handle_write(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: WriteParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    let chunk = BASE64_STANDARD
        .decode(input.content_base64.as_bytes())
        .map_err(|e| RpcCallError::invalid(format!("invalid contentBase64: {e}")))?;
    let cond = input.merged_condition();
    let create_dirs = input.create_dirs.unwrap_or(true);
    let offset = input.offset.unwrap_or(0);
    let commit = input.commit.unwrap_or(true);
    let append = input.append.unwrap_or(false);
    let total_size = input.total_size;
    let platform = ctx.platform;
    let state = ctx.state.clone();
    let cancel = ctx.cancel.clone();

    tokio::task::spawn_blocking(move || -> Result<Value, RpcCallError> {
        if cancel.is_cancelled() {
            return Err(RpcCallError::new(RpcErrorCode::InternalError, "cancelled"));
        }
        let contained = resolve_contained_details(&input.root, Some(&input.path), platform, false, true)?;
        if let Some(ts) = total_size {
            if ts > MAX_STAGED_FILE_BYTES {
                return Err(RpcCallError::invalid(format!("totalSize exceeds limit ({MAX_STAGED_FILE_BYTES} bytes)")));
            }
        }
        let end_offset = offset.checked_add(chunk.len() as u64)
            .ok_or_else(|| RpcCallError::invalid("write offset overflow"))?;
        if end_offset > MAX_STAGED_FILE_BYTES {
            return Err(RpcCallError::invalid(format!("staged write exceeds limit ({MAX_STAGED_FILE_BYTES} bytes)")));
        }

        if append {
            return write_append(&contained.canonical_root, &contained.rel_path, &contained.full_path, &chunk, &cond, create_dirs, platform);
        }

        let key = (contained.canonical_root.clone(), contained.rel_path.clone());
        if offset == 0 && commit {
            if let Some(old) = state.staging.take(&key)? {
                discard_staged(old);
            }
            if let Some(ts) = total_size {
                if ts != chunk.len() as u64 {
                    return Err(RpcCallError::invalid("chunk length does not match totalSize on single-shot commit"));
                }
            }
            return commit_bytes_atomic(&contained.canonical_root, &contained.rel_path, &contained.full_path, &chunk, &cond, create_dirs, platform);
        }

        if offset == 0 {
            if let Some(ts) = total_size {
                if (chunk.len() as u64) > ts {
                    return Err(RpcCallError::invalid("chunk exceeds declared totalSize"));
                }
            }
            check_write_condition(&contained.full_path, &cond)?;
            let (temp_path, mut temp_file) = state.staging.create_staged_file()?;
            if let Err(err) = temp_file.write_all(&chunk).and_then(|_| temp_file.flush()) {
                drop(temp_file);
                let _ = std::fs::remove_file(&temp_path);
                return Err(RpcCallError::from(err));
            }
            let received = chunk.len() as u64;
            state.staging.insert(key, StagedWrite {
                temp_path,
                file: temp_file,
                received,
                total_size,
                condition: cond,
                create_dirs,
                last_updated: Instant::now(),
            })?;
            return Ok(json!({ "size": received, "mtimeMs": now_ms(), "received": received }));
        }

        let Some(mut staged) = state.staging.take(&key)? else {
            return Err(RpcCallError::new(RpcErrorCode::Conflict, "no active staged write found for offset > 0"));
        };
        if offset > staged.received {
            discard_staged(staged);
            return Err(RpcCallError::new(RpcErrorCode::Conflict, "non-contiguous write offset"));
        }
        if let Some(ts) = total_size.or(staged.total_size) {
            if end_offset > ts {
                discard_staged(staged);
                return Err(RpcCallError::invalid("staged write exceeds declared totalSize"));
            }
            staged.total_size = Some(ts);
        }
        staged.condition.merge(&cond);
        if let Err(err) = write_staged_fd(&mut staged.file, offset, &chunk) {
            discard_staged(staged);
            return Err(err);
        }
        staged.received = end_offset;
        staged.last_updated = Instant::now();
        if !commit {
            let received = staged.received;
            state.staging.insert(key, staged)?;
            return Ok(json!({ "size": received, "mtimeMs": now_ms(), "received": received }));
        }
        if let Some(ts) = staged.total_size {
            if staged.received != ts {
                discard_staged(staged);
                return Err(RpcCallError::invalid("committed size does not match declared totalSize"));
            }
        }
        let res = commit_staged_file(
            &contained.canonical_root, &contained.rel_path, &contained.full_path, &mut staged, platform,
        );
        discard_staged(staged);
        res
    })
    .await
    .map_err(|e| RpcCallError::new(RpcErrorCode::InternalError, format!("write task failed: {e}")))?
}

fn write_staged_fd(file: &mut std::fs::File, offset: u64, chunk: &[u8]) -> Result<(), RpcCallError> {
    file.set_len(offset)?;
    file.seek(SeekFrom::Start(offset))?;
    file.write_all(chunk)?;
    file.flush()?;
    Ok(())
}

fn write_append(
    canonical_root: &Path, rel_path: &str, target: &Path, chunk: &[u8],
    cond: &WriteCondition, create_dirs: bool, platform: ClientPlatform,
) -> Result<Value, RpcCallError> {
    let existing_meta = check_write_condition(target, cond)?;
    let mut combined = Vec::new();
    if let Some(meta) = existing_meta {
        if meta.len().saturating_add(chunk.len() as u64) > MAX_STAGED_FILE_BYTES {
            return Err(RpcCallError::invalid("appended file exceeds size limit"));
        }
        let (mut file, _) = open_read_nofollow(target)?;
        file.read_to_end(&mut combined)?;
    }
    combined.extend_from_slice(chunk);
    commit_bytes_atomic(canonical_root, rel_path, target, &combined, cond, create_dirs, platform)
}

fn prepare_parent(
    canonical_root: &Path, rel_path: &str, target: &Path, create_dirs: bool, platform: ClientPlatform,
) -> Result<PathBuf, RpcCallError> {
    let segments: Vec<&str> = rel_path.split('/').collect();
    if segments.len() > 1 {
        if create_dirs {
            return ensure_dirs_contained(canonical_root, &segments[..segments.len() - 1], platform);
        }
        let parent = target.parent().ok_or_else(|| RpcCallError::invalid("target has no parent"))?;
        let meta = std::fs::symlink_metadata(parent)?;
        if is_symlink_or_reparse(parent, &meta) {
            return Err(RpcCallError::new(RpcErrorCode::Eacces, "parent directory is a symlink"));
        }
        if !meta.is_dir() {
            return Err(RpcCallError::new(RpcErrorCode::Enotdir, "parent path is not a directory"));
        }
        verify_canonical_within(canonical_root, parent, platform)?;
        return Ok(parent.to_path_buf());
    }
    Ok(canonical_root.to_path_buf())
}

fn commit_bytes_atomic(
    canonical_root: &Path, rel_path: &str, target: &Path, data: &[u8],
    cond: &WriteCondition, create_dirs: bool, platform: ClientPlatform,
) -> Result<Value, RpcCallError> {
    let existing = check_write_condition(target, cond)?;
    let preserve_mode = existing.as_ref().map(unix_mode);
    let parent = prepare_parent(canonical_root, rel_path, target, create_dirs, platform)?;
    let (temp_path, mut temp_file) = create_temp_in_dir(&parent, "write")?;
    if let Err(err) = temp_file.write_all(data).and_then(|_| temp_file.sync_all()) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(RpcCallError::from(err));
    }
    drop(temp_file);
    if let Err(err) = check_write_condition(target, cond) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(err);
    }
    let written = atomic_replace_file(canonical_root, target, &temp_path, platform, preserve_mode)?;
    Ok(json!({
        "size": written.size,
        "mtimeMs": written.mtime_ms,
        "tag": file_tag(written.size, written.mtime_ms),
        "received": written.size,
    }))
}

fn commit_staged_file(
    canonical_root: &Path, rel_path: &str, target: &Path, staged: &mut StagedWrite, platform: ClientPlatform,
) -> Result<Value, RpcCallError> {
    let existing = check_write_condition(target, &staged.condition)?;
    let preserve_mode = existing.as_ref().map(unix_mode);
    let parent = prepare_parent(canonical_root, rel_path, target, staged.create_dirs, platform)?;
    let (temp_path, mut temp_file) = create_temp_in_dir(&parent, "commit")?;
    // Copy directly from the already-open staging FD without reopening by path (H1).
    let copy_res = (|| -> std::io::Result<()> {
        staged.file.seek(SeekFrom::Start(0))?;
        std::io::copy(&mut staged.file, &mut temp_file)?;
        temp_file.sync_all()
    })();
    drop(temp_file);
    if let Err(err) = copy_res {
        let _ = std::fs::remove_file(&temp_path);
        return Err(RpcCallError::from(err));
    }
    if let Err(err) = check_write_condition(target, &staged.condition) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(err);
    }
    let written = atomic_replace_file(canonical_root, target, &temp_path, platform, preserve_mode)?;
    Ok(json!({
        "size": written.size,
        "mtimeMs": written.mtime_ms,
        "tag": file_tag(written.size, written.mtime_ms),
        "received": staged.received,
    }))
}
