use std::io::{Read, Write};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::ops::fs_common::{
    atomic_replace_file, check_write_condition, create_temp_in_dir, ensure_dirs_contained,
    file_tag, mtime_ms, open_read_nofollow, unix_mode, WriteCondition,
};
use crate::ops::fs_staging::build_unified_diff;
use crate::ops::{OpContext, RpcCallError, RpcErrorCode};
use crate::path_guard::{
    is_symlink_or_reparse, resolve_contained_details, resolve_contained_path_for_stat,
    verify_canonical_within,
};

const MAX_EDIT_FILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct EditParams {
    root: String,
    path: String,
    #[serde(rename = "oldText")]
    old_text: String,
    #[serde(rename = "newText")]
    new_text: String,
    #[serde(rename = "replaceAll")]
    replace_all: Option<bool>,
    #[serde(rename = "expectedTag")]
    expected_tag: Option<String>,
    condition: Option<WriteCondition>,
}

pub async fn handle_edit(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: EditParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    if input.old_text.is_empty() {
        return Err(RpcCallError::invalid("oldText must not be empty"));
    }
    let expected_tag = input.expected_tag.or_else(|| input.condition.and_then(|c| c.expected_tag));
    let replace_all = input.replace_all.unwrap_or(false);
    let platform = ctx.platform;
    let cancel = ctx.cancel.clone();

    tokio::task::spawn_blocking(move || -> Result<Value, RpcCallError> {
        if cancel.is_cancelled() {
            return Err(RpcCallError::new(RpcErrorCode::InternalError, "cancelled"));
        }
        let contained = resolve_contained_details(&input.root, Some(&input.path), platform, false, true)?;
        let (mut file, meta) = open_read_nofollow(&contained.full_path)?;
        if meta.len() > MAX_EDIT_FILE_BYTES {
            return Err(RpcCallError::invalid("file exceeds 16 MiB edit size limit"));
        }
        let current_tag = file_tag(meta.len(), mtime_ms(&meta));
        if let Some(expected) = &expected_tag {
            if current_tag != *expected {
                return Err(RpcCallError::new(
                    RpcErrorCode::Conflict,
                    format!("expectedTag mismatch (expected {expected}, actual {current_tag})"),
                ));
            }
        }
        let mut raw = Vec::with_capacity(meta.len() as usize);
        file.read_to_end(&mut raw)?;
        drop(file);
        if raw.contains(&0) {
            return Err(RpcCallError::invalid("cannot edit binary file"));
        }
        let before = String::from_utf8(raw).map_err(|_| RpcCallError::invalid("file is not valid UTF-8"))?;
        let count = before.matches(&input.old_text).count();
        if count == 0 {
            return Err(RpcCallError::new(RpcErrorCode::Conflict, "oldText not found in file"));
        }
        if !replace_all && count > 1 {
            return Err(RpcCallError::new(
                RpcErrorCode::Conflict,
                format!("oldText matched {count} times; set replaceAll=true or provide more context"),
            ));
        }
        let (after, replacements) = if replace_all {
            (before.replace(&input.old_text, &input.new_text), count)
        } else {
            (before.replacen(&input.old_text, &input.new_text, 1), 1)
        };
        let cond = WriteCondition { create_only: false, expected_tag: Some(current_tag) };
        let preserve_mode = Some(unix_mode(&meta));
        let parent = contained.full_path.parent().ok_or_else(|| RpcCallError::invalid("file has no parent"))?;
        let (temp_path, mut temp_file) = create_temp_in_dir(parent, "edit")?;
        if let Err(err) = temp_file.write_all(after.as_bytes()).and_then(|_| temp_file.sync_all()) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(RpcCallError::from(err));
        }
        drop(temp_file);
        if let Err(err) = check_write_condition(&contained.full_path, &cond) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(err);
        }
        let written = atomic_replace_file(&contained.canonical_root, &contained.full_path, &temp_path, platform, preserve_mode)?;
        Ok(json!({
            "replacements": replacements,
            "size": written.size,
            "mtimeMs": written.mtime_ms,
            "tag": file_tag(written.size, written.mtime_ms),
            "diff": build_unified_diff(&contained.rel_path, Some(&before), Some(&after)),
        }))
    })
    .await
    .map_err(|e| RpcCallError::new(RpcErrorCode::InternalError, format!("edit task failed: {e}")))?
}

#[derive(Debug, Deserialize)]
struct MkdirParams {
    root: String,
    path: Option<String>,
    recursive: Option<bool>,
}

pub async fn handle_mkdir(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: MkdirParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    let recursive = input.recursive.unwrap_or(true);
    let platform = ctx.platform;
    tokio::task::spawn_blocking(move || -> Result<Value, RpcCallError> {
        let contained = resolve_contained_details(&input.root, input.path.as_deref(), platform, true, true)?;
        if contained.rel_path.is_empty() {
            let meta = std::fs::symlink_metadata(&contained.full_path)?;
            if !meta.is_dir() {
                return Err(RpcCallError::new(RpcErrorCode::Enotdir, "root is not a directory"));
            }
            return Ok(json!({ "ok": true, "path": "" }));
        }
        match std::fs::symlink_metadata(&contained.full_path) {
            Ok(meta) => {
                if is_symlink_or_reparse(&contained.full_path, &meta) {
                    return Err(RpcCallError::new(RpcErrorCode::Eacces, "target is a symlink"));
                }
                if meta.is_dir() {
                    return if recursive {
                        Ok(json!({ "ok": true, "path": contained.rel_path }))
                    } else {
                        Err(RpcCallError::new(RpcErrorCode::PreconditionFailed, "directory already exists"))
                    };
                }
                return Err(RpcCallError::new(RpcErrorCode::Conflict, "a non-directory already exists at path"));
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(RpcCallError::from(err)),
        }
        if recursive {
            let segments: Vec<&str> = contained.rel_path.split('/').collect();
            ensure_dirs_contained(&contained.canonical_root, &segments, platform)?;
        } else {
            let parent = contained.full_path.parent().ok_or_else(|| RpcCallError::invalid("missing parent"))?;
            let parent_meta = std::fs::symlink_metadata(parent)?;
            if is_symlink_or_reparse(parent, &parent_meta) {
                return Err(RpcCallError::new(RpcErrorCode::Eacces, "parent is a symlink"));
            }
            if !parent_meta.is_dir() {
                return Err(RpcCallError::new(RpcErrorCode::Enotdir, "parent is not a directory"));
            }
            verify_canonical_within(&contained.canonical_root, parent, platform)?;
            std::fs::create_dir(&contained.full_path)?;
        }
        Ok(json!({ "ok": true, "path": contained.rel_path }))
    })
    .await
    .map_err(|e| RpcCallError::new(RpcErrorCode::InternalError, format!("mkdir task failed: {e}")))?
}

#[derive(Debug, Deserialize)]
struct DeleteParams {
    root: String,
    path: String,
    recursive: Option<bool>,
}

pub async fn handle_delete(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: DeleteParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    let recursive = input.recursive.unwrap_or(false);
    let platform = ctx.platform;
    tokio::task::spawn_blocking(move || -> Result<Value, RpcCallError> {
        // Allow leaf symlink so `fs.delete` unlinks the symlink itself without following it (L2); ancestors remain real.
        let contained = resolve_contained_path_for_stat(&input.root, Some(&input.path), platform, false)?;
        let meta = std::fs::symlink_metadata(&contained.full_path)?;
        if contained.full_path == contained.canonical_root {
            return Err(RpcCallError::new(RpcErrorCode::Eacces, "cannot delete workspace root"));
        }
        let parent = contained.full_path.parent().ok_or_else(|| RpcCallError::invalid("missing parent"))?;
        verify_canonical_within(&contained.canonical_root, parent, platform)?;
        if is_symlink_or_reparse(&contained.full_path, &meta) {
            #[cfg(windows)]
            {
                if std::fs::remove_file(&contained.full_path).is_err() {
                    std::fs::remove_dir(&contained.full_path)?;
                }
            }
            #[cfg(not(windows))]
            {
                std::fs::remove_file(&contained.full_path)?;
            }
            return Ok(json!({ "ok": true, "path": contained.rel_path }));
        }
        verify_canonical_within(&contained.canonical_root, &contained.full_path, platform)?;
        if meta.is_dir() {
            if recursive {
                std::fs::remove_dir_all(&contained.full_path)?;
            } else {
                std::fs::remove_dir(&contained.full_path)?;
            }
        } else {
            std::fs::remove_file(&contained.full_path)?;
        }
        Ok(json!({ "ok": true, "path": contained.rel_path }))
    })
    .await
    .map_err(|e| RpcCallError::new(RpcErrorCode::InternalError, format!("delete task failed: {e}")))?
}
